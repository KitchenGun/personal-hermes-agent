"""Independent updater transaction engine; no request-supplied commands or paths.

Run from a retained package in a separate oneshot systemd unit, never as a child
in the request worker's service cgroup. The bootstrap launcher selects
Store.recovery_release('worker') before the active pointer after interruption.

The trusted host implements fixed targets, release validation and atomic pointer
CAS. Its mutation methods must check unit identity and the entire expected
pointer (release, generation, owner) immediately before changing anything.
This is a trusted shared-UID policy, not an operating-system security boundary.
"""
import time
import uuid

from store import Busy, Conflict, READ_ONLY, TERMINAL


MUTATIONS = frozenset(("deploy.apply", "deploy.update_self", "deploy.rollback",
                       "deploy.restart_service"))
POINTER_KEYS = ("release", "pointer_owner", "pointer_generation")
SERVICE_KEYS = ("unit_identity", "invocation_id", "pid", "started_at")


def error_code(error):
    name=type(error).__name__
    return name if name in ('Refused','Conflict','RemoteError','TimeoutError','OSError','ValueError','TypeError','RuntimeError','OperationalError') else 'OtherError'


def self_check():
    """Pure candidate-startup contract used by the anchored bootstrap launcher."""
    return {"ok": True, "store_schema": 1, "engine_api": 1}


def same_pointer(left, right):
    return all(key in left and key in right and left[key] == right[key] for key in POINTER_KEYS)


def same_service(left, right):
    return all(key in left and key in right and left[key] == right[key] for key in SERVICE_KEYS)


class Engine:
    def __init__(self, store, host, health_timeout=45, poll_interval=1,
                 clock=time.time, sleep=time.sleep, crash_hook=None):
        self.store, self.host = store, host
        self.health_timeout = max(1, min(float(health_timeout), 120))
        self.poll_interval = max(0.01, min(float(poll_interval), 5))
        self.clock, self.sleep = clock, sleep
        self.crash_hook = crash_hook or (lambda label: None)

    def run_pending(self):
        results = []
        with self.store.engine_lock():
            # Resume active transactions before newly queued work.
            jobs = sorted(self.store.jobs(), key=lambda job: job["state"] == "QUEUED")
            for job in jobs:
                results.append(self._run(job["request_id"]))
        return results

    def run(self, request_id):
        with self.store.engine_lock():
            return self._run(request_id)

    def _run(self, request_id):
        while True:
            job = self.store.get(request_id)
            if not job:
                raise Conflict("request does not exist")
            if job["state"] in TERMINAL:
                return job
            target_state = self.store.target_state(job["target"])
            if (job["state"] == "RUNNING" and target_state["quarantined"]
                    and target_state["active_job"] == request_id):
                # A crash between quarantine and terminal-result writes must
                # never allow the operation to resume effects or claim success.
                self._unknown(job, target_state["reason"] or "target_quarantined",
                              manual=job["phase"].startswith("ROLLBACK"))
                continue
            try:
                if job["state"] == "QUEUED":
                    self._start(job)
                else:
                    self._step(job)
            except Busy:
                return self.store.get(request_id)
            except TimeoutError:
                current = self.store.get(request_id)
                if not current['intent']:
                    # No external effects were prepared; the timer can retry this queued request.
                    return current
                deadline = current['intent'].get('rollback_deadline') if current['phase'].startswith('ROLLBACK') else current['intent'].get('deadline')
                if deadline is not None and self.clock() < deadline:
                    self.sleep(self.poll_interval)
                    continue
                self._unknown(current, 'service_observation_timeout', manual=current['phase'].startswith('ROLLBACK'))
            except Exception as error:
                # A command may have taken effect even when its caller failed.
                # Persist ambiguity, then observe; never replay a prepared command.
                current = self.store.get(request_id)
                if not current["intent"]:
                    self.store.finish(request_id, "FAILED", {"reason": "preparation_failed", "error_type": error_code(error)})
                else:
                    self._unknown(current, "host_or_journal_error:" + error_code(error))

    def _start(self, job):
        operation, target = job["operation"], job["target"]
        if operation not in READ_ONLY | MUTATIONS:
            raise Conflict("unsupported fixed operation")
        if operation in READ_ONLY:
            if operation == "deploy.verify":
                result = self.host.verify(job)
            elif operation == "deploy.status":
                result = {"snapshot": self.host.snapshot(target), "target_state": self.store.target_state(target)}
            else:
                current = self.host.snapshot(target)
                receipt = self.host.health(target, current["release"], None)
                result = {"status": self._receipt_status(receipt, current, current["release"], None), "receipt": receipt}
            self.store.finish(job["request_id"], "SUCCEEDED", result)
            return
        if target not in ("worker", "probe"):
            raise Conflict("unsupported fixed target")
        if self.store.target_state(target)["quarantined"]:
            self.store.finish(job["request_id"], "BLOCKED", {"reason": "target_quarantined"})
            return
        old = self.host.snapshot(target)
        self._validate_snapshot(old)
        if not old.get("settled"):
            raise Conflict("target has an unsettled service job")
        new = old["release"] if operation == "deploy.restart_service" else self.host.stage(job)
        if not isinstance(new, dict) or not all(new.get(key) for key in ("sha", "manifest_sha256", "package")):
            raise Conflict("host did not return a validated release identity")
        confirmed = self.host.snapshot(target)
        if not same_pointer(confirmed, old) or not same_service(confirmed, old) or not confirmed.get("settled"):
            raise Conflict("target changed while staging the release")
        now = self.clock()
        intent = {"schema": 1, "attempt_id": uuid.uuid4().hex, "old": old, "new": new,
                  "unit_identity": old["unit_identity"], "prepared_at": now,
                  "deadline": now + self.health_timeout,
                  "changes_pointer": operation != "deploy.restart_service"}
        self.store.prepare(job["request_id"], intent)
        self.crash_hook("after_prepare")

    @staticmethod
    def _validate_snapshot(snapshot):
        if not isinstance(snapshot, dict) or any(key not in snapshot for key in POINTER_KEYS + SERVICE_KEYS):
            raise Conflict("host snapshot omitted pointer or service identity")
        if not snapshot["pointer_generation"] or not snapshot["unit_identity"]:
            raise Conflict("host snapshot omitted stable pointer or unit generation")

    def _effect(self, job, name, args, callback):
        request_id = job["request_id"]
        if not self.store.prepare_command(request_id, name, args):
            return False
        self.crash_hook("before_" + name)
        try:
            result = callback()
        except TimeoutError:
            self.store.set_phase(request_id, job["phase"], last_uncertain_command=name)
            return False
        self.crash_hook("after_" + name)
        self.store.complete_command(request_id, name, result)
        self.crash_hook("after_record_" + name)
        return True

    def _observe(self, job):
        current = self.host.observe(job["target"])
        self._validate_snapshot(current)
        if current["unit_identity"] != job["intent"]["unit_identity"]:
            raise Conflict("unit identity changed outside this attempt")
        return current

    def _owned(self, current, release, attempt):
        return current["release"] == release and current["pointer_owner"] == attempt

    def _wait_or_unknown(self, job, reason, rollback=False):
        deadline = job["intent"].get("rollback_deadline") if rollback else job["intent"]["deadline"]
        if self.clock() >= deadline:
            self._unknown(job, reason, manual=rollback)
        else:
            self.sleep(min(self.poll_interval, max(0, deadline - self.clock())))

    def _unknown(self, job, reason, manual=False):
        self.store.quarantine(job["target"], job["request_id"], reason)
        self.store.finish(job["request_id"], "MANUAL_RECOVERY_REQUIRED" if manual else "UNKNOWN_OUTCOME",
                          {"reason": reason, "target_quarantined": True,
                           "manual_recovery_required": True, "attempt_id": job["intent"].get("attempt_id")})

    def _step(self, job):
        intent, phase = job["intent"], job["phase"]
        request_id, target = job["request_id"], job["target"]
        attempt = intent["attempt_id"]
        if phase == "PREPARED":
            if not intent["changes_pointer"]:
                current = self._observe(job)
                if not same_pointer(current, intent["old"]) or not same_service(current, intent["old"]):
                    raise Conflict("target changed before restart")
                self.store.set_phase(request_id, "ACTIVATED", active=current)
                return
            if not self.store.command(request_id, "activate"):
                current = self._observe(job)
                if not same_pointer(current, intent["old"]) or not same_service(current, intent["old"]):
                    raise Conflict("target changed before activation")
                self._effect(job, "activate", {"old": intent["old"], "new": intent["new"], "attempt_id": attempt},
                             lambda: self.host.activate(target, intent["new"], intent["old"], intent["unit_identity"], attempt))
                return
            current = self._observe(job)
            if self._owned(current, intent["new"], attempt):
                self.store.set_phase(request_id, "ACTIVATED", active=current)
            elif same_pointer(current, intent["old"]) and same_service(current, intent["old"]) and current.get("settled"):
                receipt = self.host.health(target, intent["old"]["release"], None)
                if self._receipt_status(receipt, current, current["release"], None) == "healthy":
                    self.store.finish(request_id, "FAILED", {"reason": "activation_not_observed", "old_release_healthy": True})
                else:
                    self._wait_or_unknown(job, "activation_outcome_unresolved")
            else:
                self._unknown(job, "pointer_changed_outside_attempt")
            return
        if phase == "ACTIVATED":
            current = self._observe(job)
            if not same_pointer(current, intent["active"]) or not same_service(current, intent["active"]):
                raise Conflict("target changed before service restart")
            self.store.set_phase(request_id, "RESTART_PREPARED", restart_baseline=current)
            return
        if phase == "RESTART_PREPARED":
            self._restart_step(job, rollback=False)
            return
        if phase in ("VERIFYING", "ROLLBACK_VERIFYING"):
            self._verify_step(job, rollback=phase == "ROLLBACK_VERIFYING")
            return
        if phase == "ROLLBACK_PREPARED":
            current = self._observe(job)
            old_release = intent["old"]["release"]
            rollback_attempt = intent["rollback_attempt"]
            if not self.store.command(request_id, "restore"):
                if not same_pointer(current, intent["rollback_baseline"]) or not same_service(current, intent["rollback_baseline"]):
                    raise Conflict("target changed before rollback")
                self._effect(job, "restore", {"old": old_release, "expected": current, "attempt_id": rollback_attempt},
                             lambda: self.host.restore(target, old_release, current, intent["unit_identity"], rollback_attempt))
                return
            if self._owned(current, old_release, rollback_attempt):
                self.store.set_phase(request_id, "ROLLBACK_RESTART_PREPARED", rollback_active=current)
            elif same_pointer(current, intent["rollback_baseline"]):
                self._wait_or_unknown(job, "restore_outcome_unresolved", rollback=True)
            else:
                self._unknown(job, "pointer_changed_during_rollback", manual=True)
            return
        if phase == "ROLLBACK_RESTART_PREPARED":
            self._restart_step(job, rollback=True)
            return
        raise Conflict("unknown journal phase")

    def _restart_step(self, job, rollback):
        intent, target = job["intent"], job["target"]
        name = "restart_old" if rollback else "restart"
        baseline = intent["rollback_active"] if rollback else intent["restart_baseline"]
        attempt = intent["rollback_attempt"] if rollback else intent["attempt_id"]
        release = intent["old"]["release"] if rollback else intent["new"]
        if not self.store.command(job["request_id"], name):
            current = self._observe(job)
            if not same_pointer(current, baseline) or not same_service(current, baseline):
                raise Conflict("target changed before prepared restart")
            self._effect(job, name, {"expected": baseline, "attempt_id": attempt},
                         lambda: self.host.restart(target, baseline, intent["unit_identity"], attempt))
            return
        current = self._observe(job)
        if not same_pointer(current, baseline):
            self._unknown(job, "pointer_changed_during_restart", manual=rollback)
            return
        if (current.get("settled") and current["invocation_id"] and current["invocation_id"] != baseline["invocation_id"]
                and isinstance(current["started_at"], (int, float)) and current["started_at"] > 0
                and current["release"] == release):
            fields = {"rollback_service" if rollback else "service": current}
            self.store.set_phase(job["request_id"], "ROLLBACK_VERIFYING" if rollback else "VERIFYING", **fields)
        else:
            self._wait_or_unknown(job, "restart_outcome_unresolved", rollback=rollback)

    def _receipt_status(self, receipt, current, expected_release, minimum_time):
        if not isinstance(receipt, dict) or not current.get("settled"):
            return "unknown"
        if receipt.get("release") != expected_release or not same_service(receipt, current):
            return "unknown"
        observed = receipt.get("observed_at")
        now = self.clock()
        if not isinstance(observed, (int, float)) or not now - 10 <= observed <= now + 1:
            return "unknown"
        if minimum_time is not None and observed < minimum_time:
            return "unknown"
        if receipt.get("status") == "healthy" and (not current["invocation_id"] or not current["pid"]):
            return "unknown"
        return receipt.get("status") if receipt.get("status") in ("healthy", "unhealthy") else "unknown"

    def _verify_step(self, job, rollback):
        intent, target, request_id = job["intent"], job["target"], job["request_id"]
        expected = intent["rollback_service"] if rollback else intent["service"]
        release = intent["old"]["release"] if rollback else intent["new"]
        attempt = intent["rollback_attempt"] if rollback else intent["attempt_id"]
        started = intent["rollback_at"] if rollback else intent["prepared_at"]
        current = self._observe(job)
        if not same_pointer(current, expected) or not same_service(current, expected):
            self._unknown(job, "target_changed_during_health_check", manual=rollback)
            return
        receipt = self.host.health(target, release, attempt)
        # Observe again after health: a receipt for a process that was replaced
        # while the health call ran is never evidence of the current service.
        after = self._observe(job)
        if not same_pointer(after, current) or not same_service(after, current):
            self._unknown(job, "target_changed_while_reading_receipt", manual=rollback)
            return
        status = self._receipt_status(receipt, current, release, started)
        if status == "healthy":
            if not rollback and target == "worker" and intent["changes_pointer"]:
                check = self.host.check_candidate_updater(release)
                ok = check is True or isinstance(check, dict) and check.get("ok") is True
                if not ok:
                    self._begin_rollback(job, current, "candidate_updater_startup_failed")
                    return
                confirmed = self._observe(job)
                if not same_pointer(confirmed, current) or not same_service(confirmed, current):
                    self._unknown(job, "target_changed_during_updater_startup_check")
                    return
            self.store.finish(request_id, "ROLLED_BACK" if rollback else "SUCCEEDED",
                              {"release": release, "receipt": receipt, "attempt_id": attempt,
                               "reason": intent.get("rollback_reason") if rollback else "verified"})
        elif status == "unhealthy":
            if rollback or not intent["changes_pointer"]:
                self._unknown(job, "restored_service_unhealthy" if rollback else "restarted_service_unhealthy", manual=True)
            else:
                self._begin_rollback(job, current, "candidate_service_unhealthy")
        else:
            self._wait_or_unknown(job, "fresh_health_receipt_not_observed", rollback=rollback)

    def _begin_rollback(self, job, current, reason):
        intent = job["intent"]
        if not self._owned(current, intent["new"], intent["attempt_id"]):
            self._unknown(job, "failed_release_is_no_longer_owned")
            return
        now = self.clock()
        self.store.set_phase(job["request_id"], "ROLLBACK_PREPARED", rollback_at=now,
                             rollback_deadline=now + self.health_timeout,
                             rollback_attempt=intent["attempt_id"] + ":rollback",
                             rollback_baseline=current, rollback_reason=reason)
        self.crash_hook("after_rollback_prepare")
