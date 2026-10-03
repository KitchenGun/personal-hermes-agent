import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from store import Busy, Conflict, Store
from updater import Engine, same_pointer, same_service, self_check


OLD = {"sha": "a" * 40, "manifest_sha256": "1" * 64, "package": "old"}
NEW = {"sha": "b" * 40, "manifest_sha256": "2" * 64, "package": "new"}


class Crash(BaseException):
    pass


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def atomic_json(path, value):
    tmp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with tmp.open("w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(str(tmp), str(path))
    directory = os.open(str(path.parent), os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class Host:
    """Real durable pointer files with a small, explicit systemd simulator."""
    def __init__(self, root, clock, initialize=True):
        self.root, self.clock = Path(root), clock
        self.bad_release = None
        self.bad_updater = False
        self.stale_receipt = False
        self.no_receipt = False
        self.restart_timeout = False
        self.activate_timeout_after = False
        self.receipt_hook = None
        self.counts = {"activate": 0, "restore": 0, "restart": 0}
        if initialize:
            self.root.mkdir(parents=True, exist_ok=True)
            for package in ("old", "new"):
                (self.root / package).mkdir(exist_ok=True)
            atomic_json(self.root / "pointer.json", {"release": OLD, "pointer_owner": "bootstrap", "pointer_generation": uuid.uuid4().hex})
            (self.root / "unit").write_text("fixed service and updater unit envelope")
            atomic_json(self.root / "service.json", {"release": OLD, "invocation_id": "old-invocation", "pid": 11,
                        "started_at": clock() - 100, "settled": True})

    def snapshot(self, target):
        assert target in ("worker", "probe")
        pointer = json.loads((self.root / "pointer.json").read_text())
        service = json.loads((self.root / "service.json").read_text())
        result = dict(service)
        result.update(pointer)
        result["unit_identity"] = hashlib.sha256((self.root / "unit").read_bytes()).hexdigest()
        return result

    observe = snapshot

    def stage(self, job):
        return OLD if job["operation"] == "deploy.rollback" else NEW

    def verify(self, job):
        return {"verified": True, "sha": job["request"].get("sha")}

    def _guard(self, target, expected, unit):
        current = self.snapshot(target)
        if not same_pointer(current, expected) or current["unit_identity"] != unit:
            raise Conflict("human changed pointer or unit")

    def activate(self, target, new, expected, unit, attempt_id):
        self._guard(target, expected, unit)
        self.counts["activate"] += 1
        atomic_json(self.root / "pointer.json", {"release": new, "pointer_owner": attempt_id, "pointer_generation": uuid.uuid4().hex})
        if self.activate_timeout_after:
            raise TimeoutError("response lost after atomic replace")
        return self.snapshot(target)

    def restore(self, target, old, expected, unit, attempt_id):
        self._guard(target, expected, unit)
        self.counts["restore"] += 1
        atomic_json(self.root / "pointer.json", {"release": old, "pointer_owner": attempt_id, "pointer_generation": uuid.uuid4().hex})
        return self.snapshot(target)

    def restart(self, target, expected, unit, attempt_id):
        self._guard(target, expected, unit)
        if not same_service(self.snapshot(target), expected):
            raise Conflict("human restarted service")
        self.counts["restart"] += 1
        if self.restart_timeout:
            raise TimeoutError("unknown systemd outcome")
        service = json.loads((self.root / "service.json").read_text())
        atomic_json(self.root / "service.json", {"release": expected["release"], "invocation_id": uuid.uuid4().hex,
                    "pid": service["pid"] + 1, "started_at": self.clock(), "settled": True})
        return self.snapshot(target)

    def health(self, target, release, attempt_id):
        if self.no_receipt:
            return None
        service = json.loads((self.root / "service.json").read_text())
        receipt = dict(service)
        receipt["unit_identity"] = self.snapshot(target)["unit_identity"]
        receipt["observed_at"] = self.clock() - (100 if self.stale_receipt else 0)
        receipt["status"] = "unhealthy" if service["release"] == self.bad_release else "healthy"
        if self.receipt_hook:
            self.receipt_hook()
        return receipt

    def check_candidate_updater(self, release):
        return not self.bad_updater


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "ledger.sqlite"
        self.store = Store(self.path)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.store.close)
        self.request = {"id": "r1", "operation": "deploy.apply", "target": "worker", "sha": NEW["sha"]}

    def accept(self, **changes):
        request = dict(self.request)
        request.update(changes)
        return self.store.accept("r1", "digest", "101", request)

    def test_exact_replay_and_id_comment_digest_conflicts(self):
        self.assertTrue(self.accept()[1])
        self.assertFalse(self.accept()[1])
        for args in (("r1", "different", "101"), ("r1", "digest", "102"), ("r2", "digest", "101")):
            with self.assertRaises(Conflict):
                self.store.accept(*args, self.request)
        with self.assertRaises(Conflict):
            self.accept(sha=OLD["sha"])

    def test_reopen_preserves_updater_ownership_and_ledger(self):
        self.accept()
        self.store.prepare("r1", {"old": {"release": OLD}, "new": NEW})
        reopened = Store(self.path)
        try:
            self.assertEqual(reopened.get("r1")["state"], "RUNNING")
            self.assertEqual(reopened.recovery_release(), OLD)
            self.assertEqual(reopened.target_state("worker")["active_job"], "r1")
        finally:
            reopened.close()

    def test_uncertain_outbox_cannot_repost_and_marker_reconciles(self):
        self.accept()
        self.store.enqueue_outbox("r1:result", "r1", "result <!-- stable -->", "stable")
        self.store.outbox_uncertain("r1:result")
        with self.assertRaises(Conflict):
            self.store.outbox_uncertain("r1:result")
        self.assertEqual(self.store.outbox_pending()[0]["state"], "UNCERTAIN")
        self.store.outbox_delivered("r1:result", "202")
        self.assertEqual(self.store.outbox_pending(), [])
        with self.assertRaises(Conflict):
            self.store.outbox_delivered("r1:result", "203")

    def test_engine_lock_is_process_independent(self):
        with self.store.engine_lock():
            other = Store(self.path)
            try:
                with self.assertRaises(Busy):
                    with other.engine_lock():
                        pass
            finally:
                other.close()


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.clock = Clock()
        self.host = Host(self.root / "host", self.clock)
        self.store = Store(self.root / "ledger.sqlite")
        self.addCleanup(self.store.close)
        self.engine = self.make_engine()

    def make_engine(self, crash_hook=None):
        return Engine(self.store, self.host, health_timeout=2, poll_interval=.2,
                      clock=self.clock, sleep=self.clock.sleep, crash_hook=crash_hook)

    def queue(self, rid="r1", operation="deploy.update_self", target="worker"):
        request = {"id": rid, "operation": operation, "target": target, "sha": NEW["sha"]}
        self.store.accept(rid, "digest:" + rid, "comment:" + rid, request)

    def stop_at(self, boundary):
        def hook(label):
            if label == boundary:
                raise Crash(label)
        self.queue()
        with self.assertRaises(Crash):
            self.make_engine(hook).run("r1")

    def test_transient_observation_timeout_retries_without_repeating_effect(self):
        self.queue()
        original = self.host.observe
        calls = [0]
        def observe(target):
            calls[0] += 1
            if calls[0] == 2:
                raise TimeoutError('temporary query timeout')
            return original(target)
        self.host.observe = observe
        result = self.engine.run('r1')
        self.assertEqual(result['state'], 'SUCCEEDED')
        self.assertEqual(self.host.counts['activate'], 1)
        self.assertEqual(self.host.counts['restart'], 1)
        self.assertEqual(self.host.counts['restore'], 0)

    def test_success_exact_release_process_receipt_and_retained_versions(self):
        self.queue()
        result = self.engine.run("r1")
        self.assertEqual(result["state"], "SUCCEEDED")
        self.assertEqual(result["result"]["release"], NEW)
        self.assertNotEqual(result["result"]["receipt"]["invocation_id"], "old-invocation")
        self.assertEqual(self.host.counts, {"activate": 1, "restore": 0, "restart": 1})
        self.assertTrue((self.host.root / "old").is_dir())
        self.assertIsNone(self.store.recovery_release())

    def test_candidate_self_check_is_pure(self):
        self.assertEqual(self_check(), {"ok": True, "store_schema": 1, "engine_api": 1})
        self.assertEqual(sum(self.host.counts.values()), 0)

    def test_monotonic_process_start_is_not_compared_to_wall_clock(self):
        original = self.host.restart
        def restart(*args):
            original(*args)
            service = json.loads((self.host.root / "service.json").read_text())
            service["started_at"] = 123456789
            atomic_json(self.host.root / "service.json", service)
            return self.host.snapshot("worker")
        self.host.restart = restart
        self.queue()
        self.assertEqual(self.engine.run("r1")["state"], "SUCCEEDED")

    def test_bad_new_worker_rolls_back_and_updater_finishes(self):
        self.host.bad_release = NEW
        self.queue()
        result = self.engine.run("r1")
        self.assertEqual(result["state"], "ROLLED_BACK")
        self.assertEqual(self.host.snapshot("worker")["release"], OLD)
        self.assertEqual(self.host.counts, {"activate": 1, "restore": 1, "restart": 2})
        self.assertFalse(self.store.target_state("worker")["quarantined"])

    def test_bad_candidate_updater_rolls_back_even_if_worker_healthy(self):
        self.host.bad_updater = True
        self.queue()
        result = self.engine.run("r1")
        self.assertEqual(result["state"], "ROLLED_BACK")
        self.assertEqual(result["result"]["reason"], "candidate_updater_startup_failed")

    def test_resume_after_prepared_intent(self):
        self.stop_at("after_prepare")
        self.assertEqual(self.store.recovery_release(), OLD)
        self.assertEqual(self.engine.run("r1")["state"], "SUCCEEDED")

    def test_before_activation_crash_does_not_blindly_replay(self):
        self.stop_at("before_activate")
        self.assertEqual(self.engine.run("r1")["state"], "FAILED")
        self.assertEqual(self.host.counts["activate"], 0)

    def test_resume_after_atomic_pointer_swap_before_result_recorded(self):
        self.stop_at("after_activate")
        self.assertEqual(self.engine.run("r1")["state"], "SUCCEEDED")
        self.assertEqual(self.host.counts["activate"], 1)

    def test_resume_after_restart_before_result_recorded(self):
        self.stop_at("after_restart")
        self.assertEqual(self.engine.run("r1")["state"], "SUCCEEDED")
        self.assertEqual(self.host.counts["restart"], 1)

    def test_before_restart_crash_is_uncertain_no_duplicate_restart(self):
        self.stop_at("before_restart")
        result = self.engine.run("r1")
        self.assertEqual(result["state"], "UNKNOWN_OUTCOME")
        self.assertEqual(self.host.counts["restart"], 0)
        self.assertEqual(self.store.recovery_release(), OLD)
        with self.assertRaises(Conflict):
            self.queue("new-id")

    def test_restart_timeout_is_bounded_and_quarantines(self):
        self.host.restart_timeout = True
        self.queue()
        self.assertEqual(self.engine.run("r1")["state"], "UNKNOWN_OUTCOME")
        self.assertEqual(self.host.counts["restart"], 1)
        self.assertLessEqual(self.clock(), 1002.01)

    def test_activation_timeout_after_effect_reobserves_successfully(self):
        self.host.activate_timeout_after = True
        self.queue()
        self.assertEqual(self.engine.run("r1")["state"], "SUCCEEDED")
        self.assertEqual(self.host.counts["activate"], 1)

    def test_stale_receipt_never_succeeds_or_triggers_blind_rollback(self):
        self.host.stale_receipt = True
        self.queue()
        self.assertEqual(self.engine.run("r1")["state"], "UNKNOWN_OUTCOME")
        self.assertEqual(self.host.counts["restore"], 0)

    def test_crash_after_quarantine_cannot_resume_effects(self):
        self.stop_at("after_activate")
        self.store.quarantine("worker", "r1", "already_ambiguous")
        counts = dict(self.host.counts)
        result = self.engine.run("r1")
        self.assertEqual(result["state"], "UNKNOWN_OUTCOME")
        self.assertEqual(result["result"]["reason"], "already_ambiguous")
        self.assertEqual(self.host.counts, counts)

    def test_crash_after_rollback_restart_recovers_without_restarting_again(self):
        self.host.bad_release = NEW
        self.stop_at("after_restart_old")
        self.assertEqual(self.engine.run("r1")["state"], "ROLLED_BACK")
        self.assertEqual(self.host.counts["restart"], 2)

    def test_crash_before_rollback_restart_quarantines_without_replay(self):
        self.host.bad_release = NEW
        self.stop_at("before_restart_old")
        self.assertEqual(self.engine.run("r1")["state"], "MANUAL_RECOVERY_REQUIRED")
        self.assertEqual(self.host.counts["restart"], 1)

    def test_same_release_receipt_wrong_pid_is_rejected(self):
        original = self.host.health
        def wrong_pid(*args):
            receipt = original(*args)
            receipt["pid"] += 100
            return receipt
        self.host.health = wrong_pid
        self.queue()
        self.assertEqual(self.engine.run("r1")["state"], "UNKNOWN_OUTCOME")

    def test_human_unit_change_blocks_rollback(self):
        self.host.bad_release = NEW
        self.stop_at("after_restart")
        (self.host.root / "unit").write_text("human changed service")
        self.assertEqual(self.engine.run("r1")["state"], "UNKNOWN_OUTCOME")
        self.assertEqual(self.host.counts["restore"], 0)

    def test_human_same_release_pointer_replacement_blocks_rollback(self):
        self.host.bad_release = NEW
        self.stop_at("after_restart")
        pointer = json.loads((self.host.root / "pointer.json").read_text())
        pointer["pointer_generation"] = "human-generation"
        pointer["pointer_owner"] = "human"
        atomic_json(self.host.root / "pointer.json", pointer)
        self.assertEqual(self.engine.run("r1")["state"], "UNKNOWN_OUTCOME")
        self.assertEqual(self.host.counts["restore"], 0)

    def test_human_restart_during_health_read_blocks_completion(self):
        def change():
            self.host.receipt_hook = None
            current = self.host.snapshot("worker")
            self.host.restart("worker", current, current["unit_identity"], "human")
        self.host.receipt_hook = change
        self.queue()
        self.assertEqual(self.engine.run("r1")["state"], "UNKNOWN_OUTCOME")

    def test_resume_rollback_after_pointer_restore(self):
        self.host.bad_release = NEW
        self.stop_at("after_restore")
        self.assertEqual(self.engine.run("r1")["state"], "ROLLED_BACK")
        self.assertEqual(self.host.counts["restore"], 1)

    def test_recovery_refuses_repeating_uncertain_restore(self):
        self.host.bad_release = NEW
        self.stop_at("before_restore")
        self.assertEqual(self.engine.run("r1")["state"], "MANUAL_RECOVERY_REQUIRED")
        self.assertEqual(self.host.counts["restore"], 0)

    def test_probe_transaction_does_not_claim_worker(self):
        self.queue(operation="deploy.apply", target="probe")
        self.assertEqual(self.engine.run("r1")["state"], "SUCCEEDED")
        self.assertIsNone(self.store.target_state("worker")["active_job"])

    def test_worker_reopen_does_not_mark_delegated_request_unknown(self):
        self.stop_at("after_activate")
        worker_view = Store(self.root / "ledger.sqlite")
        try:
            self.assertEqual(worker_view.get("r1")["state"], "RUNNING")
        finally:
            worker_view.close()
        self.assertEqual(self.engine.run("r1")["state"], "SUCCEEDED")

    def test_readonly_verify_uses_fixed_host_without_service_mutation(self):
        self.queue(operation="deploy.verify", target="verify")
        self.assertEqual(self.engine.run("r1")["state"], "SUCCEEDED")
        self.assertEqual(sum(self.host.counts.values()), 0)


class ProcessHost(Host):
    """Process-group isolation simulator, without requiring real systemd/root."""
    def restart(self, target, expected, unit, attempt_id):
        self._guard(target, expected, unit)
        service = json.loads((self.root / "service.json").read_text())
        os.killpg(service["pid"], signal.SIGTERM)
        for child in getattr(self, "children", []):
            if child.pid == service["pid"]:
                child.wait(timeout=3)
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                   start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children = getattr(self, "children", []) + [process]
        atomic_json(self.root / "service.json", {"release": expected["release"], "invocation_id": uuid.uuid4().hex,
                    "pid": process.pid, "started_at": self.clock(), "settled": True})
        return self.snapshot(target)


def run_process_engine(root):
    os.setsid()
    root = Path(root)
    store = Store(root / "ledger.sqlite")
    host = ProcessHost(root / "host", time.time, initialize=False)
    host.bad_release = NEW
    result = Engine(store, host, health_timeout=3, poll_interval=.05).run("independent")
    atomic_json(root / "updater-result.json", {"state": result["state"], "updater_pid": os.getpid(),
                                              "updater_group": os.getpgrp()})
    # Test fixture shutdown only: its durable result already proved rollback.
    for child in getattr(host, "children", []):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=3)
    store.close()


class ProcessIndependenceTests(unittest.TestCase):
    def test_stopping_worker_group_does_not_kill_updater_or_prevent_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            host = Host(root / "host", time.time)
            worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                      start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            service = json.loads((host.root / "service.json").read_text())
            service["pid"] = worker.pid
            atomic_json(host.root / "service.json", service)
            store = Store(root / "ledger.sqlite")
            store.accept("independent", "digest", "999", {"operation": "deploy.update_self", "target": "worker"})
            store.close()
            updater = multiprocessing.Process(target=run_process_engine, args=(tmp,))
            try:
                updater.start()
                updater.join(10)
                self.assertFalse(updater.is_alive(), "updater did not finish")
                self.assertEqual(updater.exitcode, 0)
                result = json.loads((root / "updater-result.json").read_text())
                self.assertEqual(result["state"], "ROLLED_BACK")
                self.assertNotEqual(result["updater_group"], worker.pid)
                self.assertEqual(host.snapshot("worker")["release"], OLD)
                worker.wait(timeout=3)
            finally:
                if updater.is_alive():
                    updater.terminate()
                    updater.join(3)
                for pid in (worker.pid, host.snapshot("worker")["pid"]):
                    try:
                        os.killpg(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                worker.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
