"""Local host contract tests; all service commands are replaced by a fake."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

import guard
from runtime import Host, Refused, encoded, render_unit


class Sources:
    def __init__(self):
        self.packages, self.calls = {}, []

    def add(self, target, sha, settings=None):
        values = {name: ("VALUE = %r\n" % sha).encode() for name in guard.SOURCE_FILES[target]}
        manifest = {"schema": 1, "authority_epoch": guard.EPOCH, "target": target,
                    "files": {name: {"sha256": hashlib.sha256(value).hexdigest(), "size": len(value)}
                              for name, value in values.items()},
                    "unit_settings": settings or {"restart_seconds": 5, "stop_timeout_seconds": 15}}
        prefix = "ops/deploy-control/" + ("probe/" if target == "probe" else "")
        self.packages[sha] = {prefix + name: value for name, value in values.items()}
        self.packages[sha][prefix + "manifest.json"] = encoded(manifest)

    def verify(self, alias, sha):
        self.calls.append(("verify", alias, sha))
        return "/fake/cache"

    def blob(self, cache, sha, name, maximum):
        self.calls.append(("blob", cache, sha, name, maximum))
        return self.packages[sha][name]


class Ledger:
    def __init__(self):
        self.active, self.entries = {}, {}

    def target_state(self, target):
        return {"active_job": self.active.get(target), "quarantined": 0}

    def get(self, request_id):
        return self.entries.get(request_id)

    def jobs(self, include_terminal=False):
        return list(self.entries.values())


class Commands:
    def __init__(self, policy):
        self.calls, self.fail_restart, self.check_ok = [], False, True
        self.values = {}
        for role, name in policy["services"].items():
            self.values[name] = {"Id": name, "LoadState": "loaded", "FragmentPath": str(Path(policy["unit_dir"]) / name),
                                 "DropInPaths": "", "NeedDaemonReload": "no", "ActiveState": "active",
                                 "SubState": "running" if role == "worker" else "exited", "Job": "0",
                                 "InvocationID": "d" * 32, "MainPID": "900" if role == "worker" else "0",
                                 "ExecMainPID": "900", "ExecMainStartTimestampMonotonic": "12345000",
                                 "ExecMainCode": "1", "ExecMainStatus": "0", "Result": "success"}

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        if "show" in argv:
            value = self.values[argv[3]]
            return types.SimpleNamespace(returncode=0, stdout=("\n".join(key + "=" + value for key, value in value.items()) + "\n").encode(), stderr=b"")
        if "restart" in argv and self.fail_restart:
            raise subprocess.TimeoutExpired(argv, 15)
        if "check-updater" in argv:
            release = {"sha": argv[-2], "manifest_sha256": argv[-1], "package": "worker-" + argv[-2]}
            return types.SimpleNamespace(returncode=0 if self.check_ok else 1, stdout=encoded({"ok": True, "release": release}), stderr=b"")
        return types.SimpleNamespace(returncode=0 if self.check_ok else 1, stdout=b"", stderr=b"")


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bootstrap = self.root / "bootstrap"
        self.bootstrap.mkdir(mode=0o700)
        (self.bootstrap / "launcher.py").write_text("# anchored launcher\n")
        self.units = self.root / "user-units"
        self.units.mkdir(mode=0o700)
        for name in ("releases", "active", "receipts", "challenges", "locks"):
            (self.root / name).mkdir(mode=0o700)
        for target in guard.SOURCE_FILES:
            (self.root / "releases" / target).mkdir(mode=0o700)
        self.policy = {"root": str(self.root), "bootstrap_dir": str(self.bootstrap),
                       "launcher": str(self.bootstrap / "launcher.py"), "unit_dir": str(self.units),
                       "services": {"worker": "fixed-worker.service", "updater": "fixed-updater.service", "probe": "fixed-probe.service"}}
        self.sources, self.ledger = Sources(), Ledger()
        self.commands = Commands(self.policy)
        self.now = 2000000000.0
        self.host = Host(self.policy, self.sources, self.ledger, runner=self.commands, clock=lambda: self.now)
        for name, value in self.host.unit_files().items():
            (self.units / name).write_bytes(value)
        self.old = self.stage("probe", "a" * 40)
        self.new = self.stage("probe", "b" * 40)
        self.write_pointer("probe", self.old)
        self.attempt = "f" * 32

    def tearDown(self):
        for directory, _, _ in os.walk(str(self.root)):
            os.chmod(directory, 0o700)
        self.temp.cleanup()

    def job(self, target="probe", sha="b" * 40, operation=None):
        operation = operation or ("deploy.apply" if target == "probe" else "deploy.update_self")
        return {"request_id": "request-1", "target": target, "operation": operation, "state": "QUEUED",
                "request": {"repo": "Hermes", "sha": sha, "target": target, "authority_epoch": guard.EPOCH}}

    def stage(self, target, sha):
        self.sources.add(target, sha)
        return self.host.stage(self.job(target, sha))

    def write_pointer(self, target, release, owner="bootstrap", generation="c" * 32):
        (self.root / "active" / (target + ".json")).write_bytes(encoded({"release": release, "owner": owner, "generation": generation}))

    def claim(self, target="probe", operation="deploy.apply"):
        baseline = self.host.snapshot(target)
        job = self.job(target, operation=operation)
        job.update(state="RUNNING", intent={"attempt_id": self.attempt, "restart_baseline": baseline})
        self.ledger.active[target] = job["request_id"]
        self.ledger.entries[job["request_id"]] = job
        return baseline

    def receipt(self, target="probe", attempt=None):
        current = self.host.snapshot(target)
        attempt = attempt or self.attempt
        challenge = {"release": current["release"], "pointer_generation": current["pointer_generation"],
                     "attempt_id": attempt, "requested_at": self.now - 2}
        (self.root / "challenges" / (target + ".json")).write_bytes(encoded(challenge))
        receipt = dict(current, observed_at=self.now, status="healthy", attempt_id=attempt)
        (self.root / "receipts" / (target + ".json")).write_bytes(encoded(receipt))
        return receipt

    def test_stage_only_exact_bounded_fixed_sources_and_retains_bytes(self):
        blob_calls = [call for call in self.sources.calls if call[0] == "blob"]
        self.assertEqual({call[3] for call in blob_calls}, {"ops/deploy-control/probe/manifest.json", "ops/deploy-control/probe/probe.py"})
        path = self.root / "releases" / "probe" / self.old["sha"]
        self.assertEqual(path.stat().st_mode & 0o777, 0o500)
        self.assertEqual((path / "probe.py").stat().st_mode & 0o777, 0o400)
        self.assertEqual(self.host.stage(self.job(sha=self.old["sha"])), self.old)

    def test_existing_different_or_partial_release_never_overwritten(self):
        path = self.root / "releases" / "probe" / self.old["sha"] / "probe.py"
        path.chmod(0o600)
        path.write_bytes(b"CHANGED = True\n")
        with self.assertRaises(guard.Refused):
            self.host.stage(self.job(sha=self.old["sha"]))
        self.assertEqual(path.read_bytes(), b"CHANGED = True\n")
        sha = "e" * 40
        self.sources.add("probe", sha)
        (self.root / "releases" / "probe" / sha).mkdir()
        with self.assertRaises(guard.Refused):
            self.host.stage(self.job(sha=sha))

    def test_release_symlink_refused(self):
        sha = "e" * 40
        self.sources.add("probe", sha)
        (self.root / "releases" / "probe" / sha).symlink_to(self.root / "releases" / "probe" / self.old["sha"])
        with self.assertRaises(guard.Refused):
            self.host.stage(self.job(sha=sha))

    def test_manifest_cannot_change_unit_settings_or_add_directives(self):
        sha = "e" * 40
        self.sources.add("probe", sha, {"restart_seconds": 6, "stop_timeout_seconds": 15})
        with self.assertRaisesRegex(guard.Refused, "BOOTSTRAP_UNIT_SETTINGS_CHANGED"):
            self.host.stage(self.job(sha=sha))
        self.assertFalse((self.root / "releases" / "probe" / sha).exists())
        raw = self.sources.packages[sha]["ops/deploy-control/probe/manifest.json"]
        manifest = json.loads(raw)
        manifest["unit_settings"]["ExecStart"] = "bad"
        self.sources.packages[sha]["ops/deploy-control/probe/manifest.json"] = encoded(manifest)
        with self.assertRaises(guard.Refused):
            self.host.stage(self.job(sha=sha))

    def test_stage_checks_epoch_and_fixed_operation(self):
        job = self.job()
        job["request"]["authority_epoch"] = "other"
        with self.assertRaises(guard.Refused):
            self.host.stage(job)
        with self.assertRaises(guard.Refused):
            self.host.stage(self.job(operation="deploy.update_self"))

    def test_snapshot_uses_actual_oneshot_pid_and_monotonic_start(self):
        value = self.host.snapshot("probe")
        self.assertEqual(value["pid"], 900)
        self.assertEqual(value["started_at"], 12345000)
        self.assertTrue(value["settled"])
        self.commands.values["fixed-probe.service"]["Job"] = "77 /job/77"
        self.assertFalse(self.host.snapshot("probe")["settled"])

    def test_unit_file_dropin_and_stale_loaded_config_refused(self):
        name = self.policy["services"]["probe"]
        (self.units / name).write_bytes(render_unit(self.policy, "probe") + b"User=root\n")
        with self.assertRaises(guard.Refused):
            self.host.snapshot("probe")
        (self.units / name).write_bytes(render_unit(self.policy, "probe"))
        self.commands.values[name]["DropInPaths"] = "/unexpected/override.conf"
        with self.assertRaises(guard.Refused):
            self.host.snapshot("probe")
        self.commands.values[name]["DropInPaths"] = ""
        self.commands.values[name]["NeedDaemonReload"] = "yes"
        with self.assertRaises(guard.Refused):
            self.host.snapshot("probe")

    def test_activate_cas_checks_generation_service_and_ledger_ownership(self):
        baseline = self.claim()
        changed = dict(baseline, pointer_generation="9" * 32)
        with self.assertRaises(guard.Refused):
            self.host.activate("probe", self.new, changed, baseline["unit_identity"], self.attempt)
        self.assertEqual(self.host.snapshot("probe")["release"], self.old)
        self.ledger.active.clear()
        with self.assertRaises(guard.Refused):
            self.host.activate("probe", self.new, baseline, baseline["unit_identity"], self.attempt)
        self.claim()
        self.commands.values["fixed-probe.service"]["InvocationID"] = "e" * 32
        with self.assertRaises(guard.Refused):
            self.host.activate("probe", self.new, baseline, baseline["unit_identity"], self.attempt)

    def test_activate_and_restore_keep_releases_and_use_distinct_generations(self):
        baseline = self.claim()
        switched = self.host.activate("probe", self.new, baseline, baseline["unit_identity"], self.attempt)
        current = self.host.snapshot("probe")
        self.assertEqual(current["release"], self.new)
        self.assertEqual(current["pointer_owner"], self.attempt)
        self.assertNotEqual(current["pointer_generation"], baseline["pointer_generation"])
        self.assertEqual(switched["pointer_generation"], current["pointer_generation"])
        rollback = self.attempt + ":rollback"
        self.ledger.entries["request-1"]["intent"]["rollback_attempt"] = rollback
        self.host.restore("probe", self.old, current, current["unit_identity"], rollback)
        self.assertEqual(self.host.snapshot("probe")["release"], self.old)
        self.assertTrue((self.root / "releases" / "probe" / self.new["sha"]).is_dir())

    def test_restart_fixed_command_challenge_and_timeout_stays_unknown(self):
        baseline = self.claim(operation="deploy.restart_service")
        result = self.host.restart("probe", baseline, baseline["unit_identity"], self.attempt)
        self.assertEqual(result["status"], "submitted")
        command = self.commands.calls[-1][0]
        self.assertEqual(command, ["/usr/bin/systemctl", "--user", "--no-block", "restart", "fixed-probe.service"])
        challenge = json.loads((self.root / "challenges" / "probe.json").read_bytes())
        self.assertEqual(challenge["attempt_id"], self.attempt)
        self.assertEqual(challenge["pointer_generation"], baseline["pointer_generation"])
        self.commands.fail_restart = True
        with self.assertRaises(TimeoutError):
            self.host.restart("probe", baseline, baseline["unit_identity"], self.attempt)
        self.assertEqual(self.host.snapshot("probe")["release"], self.old)

    def test_fresh_receipt_binds_all_actual_process_identity_fields(self):
        original = self.receipt()
        self.assertEqual(self.host.health("probe", self.old, None)["status"], "healthy")
        for field, value in (("invocation_id", "e" * 32), ("pid", 123), ("started_at", 123),
                             ("pointer_generation", "9" * 32), ("attempt_id", "9" * 32),
                             ("observed_at", self.now - 3), ("observed_at", self.now + 2),
                             ("observed_at", True), ("release", self.new), ("unit_identity", "changed")):
            changed = dict(original, **{field: value})
            (self.root / "receipts" / "probe.json").write_bytes(encoded(changed))
            self.assertEqual(self.host.health("probe", self.old, None)["status"], "unknown", field)

    def test_old_probe_completion_is_readable_but_not_new_attempt_health(self):
        self.claim(operation="deploy.restart_service")
        original = self.receipt()
        self.now += 60
        result = self.host.health("probe", self.old, None)
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["completed_at"], original["observed_at"])
        self.assertEqual(result["observed_at"], self.now)
        self.assertEqual(result["evidence"], "retained_oneshot_completion")
        self.assertEqual(self.host.health("probe", self.old, self.attempt)["status"], "unknown")

    def test_actual_launcher_receipt_matches_host_health_contract(self):
        import launcher
        sha = "8" * 40
        self.sources.add("probe", sha)
        prefix = "ops/deploy-control/probe/"
        source = b"import _deploy_context\ndef main():\n    _deploy_context.heartbeat('healthy')\n"
        values = self.sources.packages[sha]
        values[prefix + "probe.py"] = source
        manifest = json.loads(values[prefix + "manifest.json"])
        manifest["files"]["probe.py"] = {"sha256": hashlib.sha256(source).hexdigest(), "size": len(source)}
        values[prefix + "manifest.json"] = encoded(manifest)
        release = self.host.stage(self.job(sha=sha))
        self.write_pointer("probe", release)
        self.receipt()
        self.commands.values["fixed-probe.service"]["ExecMainPID"] = str(os.getpid())
        (self.root / "receipts" / "probe.json").unlink()
        with mock.patch.dict(sys.modules), mock.patch.object(sys, "path", list(sys.path)), \
                mock.patch.dict(os.environ, {"INVOCATION_ID": "d" * 32}), \
                mock.patch.object(launcher, "anchored_configuration", return_value=(self.policy, {})), \
                mock.patch.object(launcher.subprocess, "run", side_effect=self.commands), \
                mock.patch.object(launcher.time, "time", return_value=self.now):
            sys.modules.pop("probe", None)
            launcher.main(["run", "probe"])
        result = self.host.health("probe", release, None)
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["pid"], os.getpid())

    def test_probe_receipt_cannot_mask_service_failure(self):
        self.receipt()
        self.commands.values["fixed-probe.service"]["Result"] = "exit-code"
        self.commands.values["fixed-probe.service"]["ExecMainStatus"] = "1"
        self.assertEqual(self.host.health("probe", self.old, None)["status"], "unhealthy")

    def test_missing_receipt_is_unknown_and_failed_new_invocation_is_unhealthy(self):
        self.assertEqual(self.host.health("probe", self.old, None)["status"], "unknown")
        baseline = self.claim(operation="deploy.restart_service")
        self.host.restart("probe", baseline, baseline["unit_identity"], self.attempt)
        self.commands.values["fixed-probe.service"].update(ActiveState="failed", SubState="failed", Result="exit-code", ExecMainStatus="1", InvocationID="e" * 32)
        self.assertEqual(self.host.health("probe", self.old, self.attempt)["status"], "unhealthy")

    def test_old_failed_invocation_is_not_evidence_of_attempt_failure(self):
        baseline = self.claim(operation="deploy.restart_service")
        self.host.restart("probe", baseline, baseline["unit_identity"], self.attempt)
        self.commands.values["fixed-probe.service"].update(ActiveState="failed", SubState="failed", Result="exit-code", ExecMainStatus="1")
        self.assertEqual(self.host.health("probe", self.old, self.attempt)["status"], "unknown")

    def test_worker_health_always_requires_recent_receipt(self):
        release = self.stage("worker", "e" * 40)
        self.write_pointer("worker", release)
        self.receipt("worker")
        self.assertEqual(self.host.health("worker", release, None)["status"], "healthy")
        self.now += 11
        self.assertEqual(self.host.health("worker", release, None)["status"], "unknown")

    def test_fixed_unit_start_timeout_and_no_autorestart_during_transaction(self):
        worker = render_unit(self.policy, "worker")
        updater = render_unit(self.policy, "updater")
        self.assertIn(b"Restart=no\n", worker)
        self.assertIn(b"/usr/bin/python3 -I -S -B", worker)
        self.assertIn(b"TimeoutStartSec=600\n", updater)
        self.assertIn(b"[Install]\nWantedBy=default.target\n", worker)
        self.assertNotIn(b"[Install]", updater)
        self.assertNotIn(b"[Install]", render_unit(self.policy, "probe"))
        self.assertNotIn(b"Environment=", worker)
        self.assertNotIn(b"User=", worker)

    def test_construct_snapshot_and_health_do_not_create_or_change_files(self):
        def inventory():
            return {str(path.relative_to(self.root)): (path.stat().st_mode, path.stat().st_mtime_ns,
                                                       path.read_bytes() if path.is_file() else None)
                    for path in self.root.rglob("*")}
        self.receipt()
        before = inventory()
        first_command = len(self.commands.calls)
        with mock.patch.object(Path, "mkdir", side_effect=AssertionError("unexpected directory creation")):
            host = Host(self.policy, self.sources, self.ledger, runner=self.commands, clock=lambda: self.now)
            host.snapshot("probe")
            self.assertEqual(host.health("probe", self.old, None)["status"], "healthy")
        self.assertEqual(inventory(), before)
        self.assertTrue(all(command[:3] == ["/usr/bin/systemctl", "--user", "show"]
                            for command, _ in self.commands.calls[first_command:]))

    def test_constructor_refuses_missing_infrastructure_without_creating_it(self):
        (self.root / "locks").rmdir()
        before = set(self.root.rglob("*"))
        with self.assertRaises(FileNotFoundError):
            Host(self.policy, self.sources, self.ledger, runner=self.commands)
        self.assertEqual(set(self.root.rglob("*")), before)
        self.assertFalse((self.root / "locks").exists())

    def test_candidate_updater_only_fixed_bounded_launcher_arguments(self):
        release = self.stage("worker", "e" * 40)
        self.assertEqual(self.host.check_candidate_updater(release), {"ok": True})
        command, options = self.commands.calls[-1]
        self.assertEqual(command, ["/usr/bin/python3", "-I", "-S", "-B", self.policy["launcher"], "check-updater", release["sha"], release["manifest_sha256"]])
        self.assertEqual(options["timeout"], 30)
        self.assertNotIn("shell", options)
        self.commands.check_ok = False
        self.assertEqual(self.host.check_candidate_updater(release), {"ok": False})

    def test_verify_does_not_stage_or_run_source(self):
        job = self.job("verify", "e" * 40, "deploy.verify")
        before = len(self.sources.calls)
        self.assertEqual(self.host.verify(job), {"verified": True, "repo": "Hermes", "sha": "e" * 40})
        self.assertEqual(self.sources.calls[before:], [("verify", "Hermes", "e" * 40)])

    def test_explicit_rollback_only_known_successful_transition(self):
        job = self.job(operation="deploy.rollback")
        with self.assertRaises(guard.Refused):
            self.host.stage(job)
        self.write_pointer("probe", self.new)
        self.ledger.entries["previous"] = {"target": "probe", "state": "SUCCEEDED",
                                            "intent": {"changes_pointer": True, "new": self.new, "old": {"release": self.old}}}
        self.assertEqual(self.host.stage(job), self.old)

    def test_worker_identity_includes_updater_unit(self):
        release = self.stage("worker", "e" * 40)
        self.write_pointer("worker", release)
        self.host.snapshot("worker")
        (self.units / self.policy["services"]["updater"]).write_bytes(b"changed\n")
        with self.assertRaises(guard.Refused):
            self.host.snapshot("worker")


if __name__ == "__main__":
    unittest.main()
