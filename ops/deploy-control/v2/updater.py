"""Bounded v2 dispatcher over injected, locally qualified Host adapters.

Recovery never calls admission, request TTL, or GitHub. The anchored kernel
checks that retained journals have accepted Store rows before candidate imports.
The old Store row stays unchanged throughout controller migration: intermediate
phases and effect intents belong to the separate migration journal.

Host: recovery_job(), admit(job), operation(job,recovery=bool) context manager,
controller_migration(job), application_release(job), application_request(job),
readonly(job), fault_gate(), fault_status(id). Optional idle recovery starts on
an empty queue; a retained idle attempt finishes before new queued effects.
Accepted RUNNING effects and retained controller recovery always take priority.
Controller activate/restore take full descriptors, including registry binding.
"""
import time

from migration import (MigrationError, NotReady, POINTER_KEYS, SERVICE_KEYS, TARGET,
                       MIGRATION_OPERATIONS, _same)
from store import Busy, Conflict, TERMINAL

APPLICATION_TARGETS = frozenset(("HERMES_API", "HERMES_DISCORD_RELAY", "KIS"))
READ_ONLY = frozenset(("deploy.status", "deploy.verify", "deploy.health"))
APPLICATION_OPERATIONS = frozenset(("deploy.apply", "deploy.rollback", "deploy.restart_service"))
CONTROLLER_TERMINAL = frozenset(("COMMITTED", "ROLLED_BACK", "NOT_APPLIED", "QUARANTINED"))


def self_check():
    return {"ok": True, "store_schema": 1, "engine_api": 1}


def error_code(error):
    value = type(error).__name__
    allowed = ("Refused", "Conflict", "NotReady", "MigrationError", "TimeoutError",
               "OSError", "ValueError", "TypeError", "RuntimeError", "OperationalError", "AttributeError")
    return value if value in allowed else "OtherError"


class Engine:
    def __init__(self, store, host, tick_seconds=540, health_timeout=120, poll_interval=1,
                 clock=time.time, monotonic=time.monotonic, sleep=time.sleep, crash_hook=None):
        self.store, self.host = store, host
        self.tick_seconds = max(.01, min(float(tick_seconds), 540))
        self.health_timeout = max(1, min(float(health_timeout), 120))
        self.poll_interval = max(.01, min(float(poll_interval), 5))
        self.clock, self.monotonic, self.sleep = clock, monotonic, sleep
        self.crash_hook = crash_hook or (lambda label: None)

    def _first_pending(self):
        states = tuple(sorted(TERMINAL))
        mutations = tuple(sorted(MIGRATION_OPERATIONS))
        row = self.store.db.execute(
            "SELECT request_id FROM requests WHERE state NOT IN (" +
            ",".join("?" for _ in states) +
            ") ORDER BY CASE WHEN state='RUNNING' THEN 0 ELSE 1 END,"
            "CASE WHEN target=? AND operation IN (" + ",".join("?" for _ in mutations) +
            ") THEN 1 ELSE 0 END,created_at,request_id LIMIT 1",
            states + (TARGET,) + mutations).fetchone()
        return self.store.get(row[0]) if row else None

    def _overlapping_controller(self):
        states, operations = tuple(sorted(TERMINAL)), tuple(sorted(MIGRATION_OPERATIONS))
        rows = self.store.db.execute(
            "SELECT request_id,state FROM requests WHERE target=? AND operation IN (" +
            ",".join("?" for _ in operations) + ") AND state NOT IN (" +
            ",".join("?" for _ in states) +
            ") ORDER BY CASE WHEN state='RUNNING' THEN 0 ELSE 1 END,created_at,request_id LIMIT 2",
            (TARGET,) + operations + states).fetchall()
        if len(rows) < 2:
            return None
        if rows[1]["state"] != "QUEUED":
            raise MigrationError("OVERLAPPING_CONTROLLER_RECOVERY_UNRESOLVED")
        return self.store.get(rows[1]["request_id"])

    def _block_overlap(self, job):
        return self.store.finish(job["request_id"], "BLOCKED", {
            "reason": "CONTROLLER_MUTATION_ALREADY_PENDING", "financial_activation": False})

    def run_pending(self):
        with self.store.engine_lock():
            first = self._first_pending()
            if first is None:
                # Older adapters and the deliberately inert candidate fixture
                # do not opt in. Do not probe arbitrary instance attributes.
                if callable(getattr(type(self.host), 'idle_recovery', None)):
                    configured = getattr(type(self.host), 'idle_recovery_configured', None)
                    if (configured is None or configured(self.host)) and self.host.recovery_job() is None:
                        self.idle_recovery_result = self.host.idle_recovery()
                return []
            recovery_id = self.host.recovery_job()
            retained_idle = getattr(type(self.host), 'idle_recovery_pending', None)
            running = self.store.db.execute("SELECT 1 FROM requests WHERE state='RUNNING' LIMIT 1").fetchone()
            if (recovery_id is None and first['state'] == 'QUEUED' and running is None
                    and callable(retained_idle) and retained_idle(self.host)):
                # Fixed status/health reporting remains reachable even when an
                # earlier queued mutation waits behind a stuck idle attempt.
                row = self.store.db.execute("SELECT request_id FROM requests WHERE state='QUEUED' "
                    "AND operation IN ('deploy.status','deploy.health') ORDER BY created_at,request_id LIMIT 1").fetchone()
                if row is None:
                    self.idle_recovery_result = self.host.idle_recovery()
                    return []
                first = self.store.get(row[0])
            if recovery_id is None:
                duplicate = self._overlapping_controller()
                if duplicate is not None:
                    return [self._block_overlap(duplicate)]
            job = self.store.get(recovery_id) if recovery_id is not None else first
            if job is None or job["state"] in TERMINAL:
                raise MigrationError("RECOVERY_HAS_NO_ACCEPTED_NONTERMINAL_REQUEST")
            return [self._run(job, recovery=recovery_id is not None or job["state"] == "RUNNING")]

    def run(self, request_id):
        with self.store.engine_lock():
            job = self.store.get(request_id)
            if job is None:
                raise Conflict("request does not exist")
            if job["state"] in TERMINAL:
                return job
            recovery_id = self.host.recovery_job()
            if recovery_id is not None and recovery_id != request_id:
                raise Busy("retained recovery takes priority")
            if recovery_id is None and job["target"] == TARGET and job["operation"] in MIGRATION_OPERATIONS:
                duplicate = self._overlapping_controller()
                if duplicate is not None:
                    if duplicate["request_id"] == request_id:
                        return self._block_overlap(duplicate)
                    raise Busy("overlapping queued controller request must be reported first")
            return self._run(job, recovery=recovery_id is not None or job["state"] == "RUNNING")

    def _run(self, job, recovery):
        deadline = self.monotonic() + self.tick_seconds
        operation, target = job["operation"], job["target"]
        if target not in APPLICATION_TARGETS | {TARGET}:
            return self._reject(job, "FIXED_TARGET_REQUIRED")
        allowed = READ_ONLY | (MIGRATION_OPERATIONS if target == TARGET else APPLICATION_OPERATIONS)
        if operation not in allowed:
            return self._reject(job, "FIXED_OPERATION_REQUIRED")
        try:
            if not recovery and self.host.admit(job) is not True:
                return self._reject(job, "ADMISSION_REFUSED")
            with self.host.operation(job, recovery=recovery):
                if not recovery and self.host.admit(job) is not True:
                    return self._reject(job, "LOCKED_ADMISSION_REFUSED")
                if operation in READ_ONLY:
                    return self.store.finish(job["request_id"], "SUCCEEDED", self.host.readonly(job))
                target_state = self.store.target_state(target)
                if target_state["quarantined"]:
                    if target_state["active_job"] != job["request_id"]:
                        return self.store.finish(job["request_id"], "BLOCKED", {
                            "reason": "TARGET_QUARANTINED", "manual_recovery_required": True,
                            "target_quarantined": True, "financial_activation": False})
                    return self._unknown(job, "TARGET_QUARANTINED")
                if job["state"] == "QUEUED":
                    job = self.store.prepare(job["request_id"], {
                        "schema": 1, "dispatcher": 2,
                        "kind": "controller" if target == TARGET else "application"})
                    self.crash_hook("after_dispatch_prepare")
                if target == TARGET:
                    return self._controller(job, self.host.controller_migration(job), deadline)
                return self._application(job, self.host.application_release(job), deadline)
        except (Busy, NotReady):
            return self.store.get(job["request_id"])
        except Exception as error:
            current = self.store.get(job["request_id"])
            if current["state"] == "QUEUED":
                return self._reject(current, "PREPARATION_REFUSED:" + error_code(error))
            return self._unknown(current, "DISPATCH_OUTCOME_UNCERTAIN:" + error_code(error))

    def _reject(self, job, reason):
        return self.store.finish(job["request_id"], "FAILED",
                                 {"reason": reason, "financial_activation": False})

    def _unknown(self, job, reason):
        self.store.quarantine(job["target"], job["request_id"], reason)
        return self.store.finish(job["request_id"], "UNKNOWN_OUTCOME", {
            "reason": reason, "manual_recovery_required": True,
            "target_quarantined": True, "financial_activation": False})

    def _application(self, job, adapter, deadline):
        result = adapter.status(job["request_id"])
        if result is None:
            try:
                request = self.host.application_request(job)
                apply_shape = (isinstance(request, dict)
                    and set(request) == {"id", "target", "repo", "sha", "manifest_sha256"}
                    and job["operation"] == "deploy.apply")
                local_shape = (isinstance(request, dict)
                    and set(request) == {"schema", "id", "target", "operation", "source"}
                    and type(request["schema"]) is int and request["schema"] == 2
                    and request["operation"] == job["operation"]
                    and job["operation"] in ("deploy.rollback", "deploy.restart_service"))
                if (not (apply_shape or local_shape)
                        or request["id"] != job["request_id"] or request["target"] != job["target"]):
                    raise Conflict("qualified application request mismatched accepted identity")
                result = adapter.begin(request)
            except (Busy, NotReady):
                raise
            except Exception as error:
                # No journal means this request has not reached any application
                # effect. A malformed/incomplete journal raises and quarantines.
                if adapter.status(job["request_id"]) is None:
                    return self._reject(job, "APPLICATION_PREFLIGHT_REFUSED:" + error_code(error))
                raise
        while True:
            if (result.get("request_id") != job["request_id"] or result.get("target") != job["target"]
                    or result.get("financial_activation") is not False):
                raise Conflict("application journal result mismatched fixed held scope")
            if result["state"] == "HELD_DEPLOYED":
                return self.store.finish(job["request_id"], "SUCCEEDED", result)
            if result["state"] == "HELD_ROLLED_BACK":
                return self.store.finish(job["request_id"], "ROLLED_BACK", result)
            if result["state"] == "UNKNOWN_OUTCOME":
                return self._unknown(job, result.get("reason") or "APPLICATION_OUTCOME_UNCERTAIN")
            if result["state"] not in ("RUNNING", "HELD_PENDING"):
                raise Conflict("unknown application journal state")
            if self.monotonic() >= deadline:
                return self.store.get(job["request_id"])
            previous = result["state"], result["phase"]
            result = adapter.step(job["request_id"])
            if previous == (result["state"], result["phase"]):
                self._pause(deadline)

    def _pause(self, deadline):
        remaining = deadline - self.monotonic()
        if remaining > 0:
            self.sleep(min(self.poll_interval, remaining))

    def _controller(self, job, migration, deadline):
        rid = job["request_id"]
        entry = migration.journal.get(rid)
        if entry is None:
            try:
                migration.prepare(rid, job["digest"], job)
            except (Busy, NotReady):
                raise
            except Exception as error:
                if migration.journal.get(rid) is None:
                    return self._reject(job, "CONTROLLER_PREFLIGHT_REFUSED:" + error_code(error))
                raise
            self.crash_hook("after_migration_prepare")
        while True:
            entry = migration.journal.get(rid)
            if entry["phase"] in CONTROLLER_TERMINAL:
                self.crash_hook("before_controller_result")
                return self._controller_result(job, entry)
            if self.monotonic() >= deadline:
                return self.store.get(rid)
            try:
                progress = self._controller_step(job, migration, entry)
            except Exception as error:
                migration._quarantine(rid, "CONTROLLER_OUTCOME_UNCERTAIN:" + error_code(error))
                progress = True
            if not progress:
                self._pause(deadline)

    def _controller_result(self, job, entry):
        phase, record = entry["phase"], entry["record"]
        if phase == "QUARANTINED":
            return self._unknown(job, record.get("reason", "CONTROLLER_QUARANTINED"))
        if phase == "NOT_APPLIED":
            return self._reject(job, "CONTROLLER_ACTIVATION_NOT_OBSERVED")
        status = "SUCCEEDED" if phase == "COMMITTED" else "ROLLED_BACK"
        result = {
            "state": phase, "financial_activation": False,
            "controller": record["prepared"]["new_controller" if phase == "COMMITTED" else "old_controller"]}
        if job["operation"] == "deploy.test_recovery":
            failed, restored = record.get("failure_receipt", {}), record.get("final_receipt", {})
            binding = record.get("fault_binding", {})
            retired = self.host.fault_status(job["request_id"])
            if (phase != "ROLLED_BACK" or not isinstance(retired, dict)
                    or retired.get("state") != "retired" or retired.get("binding") != binding
                    or retired.get("invocation_id") != failed.get("invocation_id")
                    or not failed.get("invocation_id") or not restored.get("invocation_id")
                    or failed["invocation_id"] == restored["invocation_id"]):
                return self._unknown(job, "RECOVERY_TEST_DURABLE_EVIDENCE_INCOMPLETE")
            result["recovery_test"] = {
                "fault_invocation_verified": True, "old_health_restored": True,
                "attempt_id": record["prepared"]["attempt_id"],
                "candidate_invocation_id": failed["invocation_id"],
                "restored_invocation_id": restored["invocation_id"]}
        return self.store.finish(job["request_id"], status, result)

    def _effect(self, migration, rid, name, intent, callback):
        if not migration.journal.prepare_effect(rid, name, intent):
            return False
        self.crash_hook("before_" + name)
        try:
            callback()
        except TimeoutError:
            return False
        self.crash_hook("after_" + name)
        migration.journal.complete_effect(rid, name)
        return True

    def _controller_step(self, job, migration, entry):
        rid, phase, record = job["request_id"], entry["phase"], entry["record"]
        prepared, host = record["prepared"], migration.host
        attempt = prepared["attempt_id"]
        if phase == "PREPARED":
            if "transition_deadline" not in record:
                migration.journal.capture(rid, "transition_deadline", self.clock() + self.health_timeout)
            migration.before_activation(rid)
            self.crash_hook("after_activation_intent")
            self._effect(migration, rid, "activate",
                         {"new": prepared["new_controller"], "expected": prepared["old_snapshot"]},
                         lambda: host.activate(TARGET, prepared["new_controller"], prepared["old_snapshot"],
                                               prepared["old_snapshot"]["unit_identity"], attempt))
            return True
        if phase == "ACTIVATE_PREPARED":
            outcome = migration.classify_recovery(rid)
            if outcome["classification"] == "UNIT_TRANSITION_OWNED":
                return self._resume_units(migration, rid, record, outcome)
            if outcome["classification"] == "OLD_UNCHANGED":
                current = outcome["snapshot"]
                receipt = host.health(TARGET, current["release"], None)
                if migration._current_receipt(receipt, current, "healthy", prepared["prepared_at"]):
                    migration.journal.advance(rid, "NOT_APPLIED")
                else:
                    migration._quarantine(rid, "PREPARED_ACTIVATION_OUTCOME_UNKNOWN")
            return True
        if phase in ("ACTIVATED", "VERIFYING"):
            outcome = migration.classify_recovery(rid)
            if outcome["classification"] != "NEW_OWNED":
                return True
            current = outcome["snapshot"]
            if job["operation"] == "deploy.test_recovery" and not self._arm_fault(job, migration, entry, current):
                return False
            return self._service_step(job, migration, entry, current, restored=False)
        if phase == "RESTORE_PREPARED":
            outcome = migration.classify_recovery(rid)
            if outcome["classification"] == "UNIT_TRANSITION_OWNED":
                return self._resume_units(migration, rid, record, outcome)
            if outcome["classification"] != "OLD_RESTORED":
                migration._quarantine(rid, "PREPARED_RESTORE_OUTCOME_UNKNOWN")
            return True
        if phase == "RESTORED":
            outcome = migration.classify_recovery(rid)
            if outcome["classification"] != "OLD_RESTORED":
                return True
            return self._service_step(job, migration, entry, outcome["snapshot"], restored=True)
        raise MigrationError("UNKNOWN_CONTROLLER_PHASE")

    def _resume_units(self, migration, rid, record, outcome):
        direction = outcome["direction"]
        key = "transition_deadline" if direction == "apply" else "restore_deadline"
        if key not in record:
            migration.journal.capture(rid, key, self.clock() + self.health_timeout)
        elif self.clock() >= record[key]:
            migration._quarantine(rid, "CONTROLLER_UNIT_TRANSITION_OUTCOME_UNKNOWN")
            return True
        prepared = record["prepared"]
        desired = prepared["new_controller" if direction == "apply" else "old_controller"]
        attempt = prepared["attempt_id"] + (":rollback" if direction == "restore" else "")
        before = outcome["proof"]
        migration.host.resume_controller_transition(direction, desired, outcome["snapshot"], attempt,
                                                    prepared["unit_transition"])
        after = migration.classify_recovery(rid)
        return after["classification"] != "UNIT_TRANSITION_OWNED" or after.get("proof") != before

    def _service_step(self, job, migration, entry, current, restored):
        rid, record = job["request_id"], entry["record"]
        prepared = record["prepared"]
        name = "restart_old" if restored else "restart"
        service_key = "restored_service" if restored else "new_service"
        deadline_key = "rollback_deadline" if restored else "health_deadline"
        attempt = prepared["attempt_id"] + (":rollback" if restored else "")
        effect = record.get("effects", {}).get(name)
        if effect is None:
            if deadline_key not in record:
                migration.journal.capture(rid, deadline_key, self.clock() + self.health_timeout)
            if not restored and entry["phase"] == "ACTIVATED":
                migration.journal.advance(rid, "VERIFYING")
            self._effect(migration, rid, name, {"expected": current, "attempt_id": attempt},
                         lambda: migration.host.restart(TARGET, current, current["unit_identity"], attempt))
            return True
        baseline = effect["intent"]["expected"]
        if not _same(current, baseline, POINTER_KEYS):
            migration._quarantine(rid, "CONTROLLER_POINTER_CHANGED_DURING_RESTART")
            return True
        if (current.get("settled") is not True or not current.get("invocation_id")
                or current["invocation_id"] == baseline["invocation_id"]):
            return self._wait_health(migration, rid, record, deadline_key, "CONTROLLER_RESTART_OUTCOME_UNKNOWN")
        if service_key not in record:
            migration.journal.capture(rid, service_key, current)
            return True
        if not _same(current, record[service_key], POINTER_KEYS + SERVICE_KEYS):
            migration._quarantine(rid, "CONTROLLER_SERVICE_CHANGED_DURING_VERIFICATION")
            return True
        receipt = migration.host.health(TARGET, current["release"], attempt)
        after = migration.host.observe(TARGET)
        if not _same(current, after, POINTER_KEYS + SERVICE_KEYS):
            migration._quarantine(rid, "CONTROLLER_CHANGED_DURING_HEALTH_READ")
            return True
        if migration._current_receipt(receipt, current, "healthy", prepared["prepared_at"]):
            if not restored and job["operation"] == "deploy.test_recovery":
                migration._quarantine(rid, "ONE_USE_RECOVERY_FAULT_NOT_OBSERVED")
                return True
            if restored and job["operation"] == "deploy.test_recovery" and not self._retire_fault(job, migration, entry):
                return False
            if not restored:
                probe = migration.host.check_candidate_controller(prepared["new_controller"])
                if probe != prepared["candidate_probe"]:
                    if (isinstance(probe, dict) and probe.get("ok") is False
                            and probe.get("controller") == prepared["new_controller"]):
                        if "restore_deadline" not in record:
                            migration.journal.capture(rid, "restore_deadline", self.clock() + self.health_timeout)
                        migration.restore_failed(rid, failure_kind="candidate_interface")
                    else:
                        migration._quarantine(rid, "CANDIDATE_INTERFACE_RESULT_CHANGED")
                    return True
            migration.finish(rid, restored=restored)
            return True
        if migration._current_receipt(receipt, current, "unhealthy", prepared["prepared_at"]):
            if restored:
                migration._quarantine(rid, "RESTORED_CONTROLLER_UNHEALTHY")
            elif job["operation"] == "deploy.test_recovery" and not self._fault_failure_matches(job, migration, current):
                migration._quarantine(rid, "ONE_USE_FAULT_FAILURE_NOT_PROVEN")
            else:
                if "restore_deadline" not in record:
                    migration.journal.capture(rid, "restore_deadline", self.clock() + self.health_timeout)
                migration.restore_failed(rid)
            return True
        return self._wait_health(migration, rid, record, deadline_key, "FRESH_CONTROLLER_HEALTH_UNKNOWN")

    def _wait_health(self, migration, rid, record, key, reason):
        if self.clock() >= record[key]:
            migration._quarantine(rid, reason)
            return True
        return False

    @staticmethod
    def _fault_job(job, prepared):
        return {"id": job["request_id"], "digest": job["digest"], "operation": job["operation"],
                "target": TARGET, "attempt_id": prepared["attempt_id"]}

    def _arm_fault(self, job, migration, entry, current):
        rid, record = job["request_id"], entry["record"]
        prepared = record["prepared"]
        binding = {
            "job": self._fault_job(job, prepared),
            "old": {key: prepared["old_controller"]["release"][key] for key in ("sha", "manifest_sha256")},
            "candidate": {key: prepared["new_controller"]["release"][key] for key in ("sha", "manifest_sha256")},
            "generation": current["pointer_generation"]}
        if "fault_binding" not in record:
            migration.journal.capture(rid, "fault_binding", binding)
        elif record["fault_binding"] != binding:
            migration._quarantine(rid, "FAULT_BINDING_CHANGED")
            return False
        if "fault_arm" not in record.get("effects", {}):
            gate = self.host.fault_gate()
            self._effect(migration, rid, "fault_arm", binding,
                         lambda: gate.arm(binding["job"], binding["old"], binding["candidate"], binding["generation"]))
        state = self.host.fault_status(rid)
        if (not isinstance(state, dict) or state.get("binding") != binding
                or state.get("state") not in ("armed", "consumed", "failure_emitted")):
            migration._quarantine(rid, "FAULT_ARM_OUTCOME_UNCERTAIN")
            return False
        return True

    def _fault_failure_matches(self, job, migration, current):
        state = self.host.fault_status(job["request_id"])
        binding = migration.journal.get(job["request_id"])["record"].get("fault_binding")
        return (isinstance(state, dict) and state.get("binding") == binding
                and state.get("state") == "failure_emitted"
                and state.get("invocation_id") == current["invocation_id"])

    def _retire_fault(self, job, migration, entry):
        rid = job["request_id"]
        state = self.host.fault_status(rid)
        binding = entry["record"].get("fault_binding")
        if not isinstance(state, dict) or state.get("binding") != binding:
            migration._quarantine(rid, "FAULT_RETIRE_BINDING_UNKNOWN")
            return False
        if state.get("state") == "retired":
            return True
        if state.get("state") != "failure_emitted":
            migration._quarantine(rid, "FAULT_FAILURE_NOT_RECORDED")
            return False
        if "fault_retire" in entry["record"].get("effects", {}):
            migration._quarantine(rid, "FAULT_RETIRE_OUTCOME_UNCERTAIN")
            return False
        self._effect(migration, rid, "fault_retire", {"request_id": rid},
                     lambda: self.host.fault_gate().retire(rid))
        after = self.host.fault_status(rid)
        if not isinstance(after, dict) or after.get("binding") != binding or after.get("state") != "retired":
            migration._quarantine(rid, "FAULT_RETIRE_OUTCOME_UNCERTAIN")
            return False
        return True
