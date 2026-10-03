"""Fixed, user-service host adapter. Python 3.8+, standard library only.

Bootstrap installs the units and this policy once. Releases cannot add unit
directives, commands, targets, ports, credentials or source paths. Filesystem
locks coordinate this controller, not hostile code running as the same Unix UID.
"""
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

import guard


MAX_MANIFEST = 16384
POINTER_KEYS = ("release", "pointer_owner", "pointer_generation")
SERVICE_KEYS = ("unit_identity", "invocation_id", "pid", "started_at")
PROPERTIES = ("Id", "LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload",
              "ActiveState", "SubState", "Job", "InvocationID", "MainPID",
              "ExecMainPID", "ExecMainStartTimestamp", "ExecMainStartTimestampMonotonic",
              "ExecMainCode", "ExecMainStatus", "Result")


class Refused(guard.Refused):
    pass


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _directory(path, create=False):
    path = Path(path)
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    value = path.lstat()
    if (not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid()
            or value.st_mode & 0o022):
        raise Refused("DIRECTORY_OWNERSHIP_REFUSED")
    return path


def _read(path, maximum):
    descriptor = os.open(os.fspath(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        value = os.fstat(stream.fileno())
        if (not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid()
                or value.st_nlink != 1 or value.st_size > maximum or value.st_mode & 0o022):
            raise Refused("FILE_OWNERSHIP_OR_BOUND_REFUSED")
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise Refused("FILE_BOUND_REFUSED")
    return data


def _fsync_directory(path):
    descriptor = os.open(os.fspath(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _exclusive(path, data, mode=0o600):
    descriptor = os.open(os.fspath(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def _object(data):
    try:
        value = json.loads(data, object_pairs_hook=guard.strict_object)
    except (TypeError, ValueError):
        raise Refused("LOCAL_JSON_INVALID") from None
    if not isinstance(value, dict):
        raise Refused("LOCAL_JSON_OBJECT_REQUIRED")
    return value


def _unit_quote(value):
    value = str(value)
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise Refused("UNIT_PATH_CONTROL_CHARACTER")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


def render_unit(policy, role):
    """Exact bootstrap unit bytes; no manifest commands or directives."""
    if role not in ("worker", "updater", "probe"):
        raise Refused("UNIT_ROLE_REFUSED")
    settings = policy.get("unit_settings", {"restart_seconds": 5, "stop_timeout_seconds": 15})
    lines = ["[Unit]", "Description=Fixed deploy control " + role,
             "[Service]", "Type=" + ("simple" if role == "worker" else "oneshot"),
             "ExecStart=/usr/bin/python3 -I -S -B " + _unit_quote(policy["launcher"]) + " run " + role,
             "TimeoutStopSec=" + str(settings["stop_timeout_seconds"]), "UMask=0077"]
    if role == "worker":
        # The separate bootstrap timer recovers idle crashes. Automatic service
        # restarts here would erase the invocation being verified by an update.
        lines += ["Restart=no", "RestartSec=" + str(settings["restart_seconds"]),
                  "[Install]", "WantedBy=default.target"]
    elif role == "probe":
        lines += ["RemainAfterExit=yes"]
    elif role == "updater":
        lines += ["TimeoutStartSec=600"]
    return ("\n".join(lines) + "\n").encode()


class Host:
    def __init__(self, policy, sources, store, runner=None, clock=None):
        self.policy, self.sources, self.store = policy, sources, store
        self.runner = runner or subprocess.run
        self.clock = clock or time.time
        root = Path(policy["root"])
        if not root.is_absolute() or str(root.resolve()) != str(root):
            raise Refused("ROOT_MUST_BE_CANONICAL")
        self.root = _directory(root)
        self.services = dict(policy["services"])
        if (set(self.services) != {"worker", "updater", "probe"}
                or len(set(self.services.values())) != 3
                or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}\.service", value)
                       for value in self.services.values())):
            raise Refused("FIXED_SERVICES_REQUIRED")
        self.launcher = Path(policy["launcher"])
        bootstrap = Path(policy["bootstrap_dir"])
        if (not self.launcher.is_absolute() or self.launcher.parent != bootstrap
                or bootstrap.resolve() != bootstrap or self.launcher.name != "launcher.py"):
            raise Refused("STABLE_LAUNCHER_REQUIRED")
        _directory(bootstrap)
        _read(self.launcher, guard.MAX_SOURCE)
        self.settings = policy.get("unit_settings", {"restart_seconds": 5, "stop_timeout_seconds": 15})
        if (not isinstance(self.settings, dict)
                or set(self.settings) != {"restart_seconds", "stop_timeout_seconds"}
                or any(type(value) is not int or not 5 <= value <= 60 for value in self.settings.values())):
            raise Refused("BOOTSTRAP_UNIT_SETTINGS_INVALID")
        expected_paths = {"worker": "ops/deploy-control", "probe": "ops/deploy-control/probe"}
        self.source_paths = policy.get("source_paths", expected_paths)
        if self.source_paths != expected_paths:
            raise Refused("FIXED_SOURCE_PATHS_REQUIRED")
        self.unit_dir = Path(policy["unit_dir"])
        if not self.unit_dir.is_absolute() or self.unit_dir.resolve() != self.unit_dir:
            raise Refused("UNIT_DIRECTORY_MUST_BE_CANONICAL")
        _directory(self.unit_dir)
        # Only the explicit bootstrap creates infrastructure. Constructing a
        # host for status/health cannot repair or mutate an incomplete install.
        for name in ("releases", "active", "receipts", "challenges", "locks"):
            _directory(self.root / name)
        for target in guard.SOURCE_FILES:
            _directory(self.root / "releases" / target)

    def _target(self, target):
        if target not in guard.SOURCE_FILES:
            raise Refused("FIXED_TARGET_REQUIRED")

    def _release(self, target, release):
        self._target(target)
        if (not isinstance(release, dict) or set(release) != {"sha", "manifest_sha256", "package"}
                or not isinstance(release.get("sha"), str) or not re.fullmatch(r"[0-9a-f]{40}", release["sha"])
                or not isinstance(release.get("manifest_sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", release["manifest_sha256"])
                or release["package"] != target + "-" + release["sha"]):
            raise Refused("RELEASE_IDENTITY_INVALID")
        base = _directory(self.root / "releases")
        parent = _directory(base / target)
        path = _directory(parent / release["sha"])
        expected_names = set(guard.SOURCE_FILES[target]) | {"manifest.json"}
        if set(os.listdir(path)) != expected_names:
            raise Refused("RETAINED_RELEASE_FILES_CHANGED")
        raw = _read(path / "manifest.json", MAX_MANIFEST)
        values = {name: _read(path / name, guard.MAX_SOURCE) for name in guard.SOURCE_FILES[target]}
        manifest = guard.validate_manifest(raw, target, values)
        if guard.release_identity(release["sha"], raw, target) != release:
            raise Refused("RETAINED_RELEASE_CHANGED")
        if manifest["unit_settings"] != self.settings:
            raise Refused("BOOTSTRAP_UNIT_SETTINGS_CHANGED")
        return path, manifest

    def stage(self, job):
        target, request = job["target"], job["request"]
        self._target(target)
        if request.get("authority_epoch") != guard.EPOCH:
            raise Refused("AUTHORITY_EPOCH_CHANGED")
        if job["operation"] == "deploy.rollback":
            current = self._pointer(target)["release"]
            for previous in reversed(self.store.jobs(include_terminal=True)):
                intent = previous.get("intent", {})
                if (previous["target"] == target and previous["state"] == "SUCCEEDED"
                        and intent.get("changes_pointer") and intent.get("new") == current
                        and intent.get("old", {}).get("release") != current):
                    old = intent["old"]["release"]
                    self._release(target, old)
                    return old
            raise Refused("NO_VERIFIED_PREVIOUS_RELEASE")
        if ((target, job["operation"]) not in (("worker", "deploy.update_self"), ("probe", "deploy.apply"))
                or request.get("repo") != "Hermes"):
            raise Refused("PACKAGE_OPERATION_REFUSED")
        sha = request.get("sha")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise Refused("SOURCE_SHA_REQUIRED")
        cache = self.sources.verify(request["repo"], sha)
        prefix = self.source_paths[target] + "/"
        raw = self.sources.blob(cache, sha, prefix + "manifest.json", MAX_MANIFEST)
        values = {name: self.sources.blob(cache, sha, prefix + name, guard.MAX_SOURCE)
                  for name in guard.SOURCE_FILES[target]}
        manifest = guard.validate_manifest(raw, target, values)
        if manifest["unit_settings"] != self.settings:
            raise Refused("BOOTSTRAP_UNIT_SETTINGS_CHANGED")
        release = guard.release_identity(sha, raw, target)
        parent = _directory(self.root / "releases" / target)
        path = parent / sha
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            self._release(target, release)
            return release
        # Never overwrite or clean a partial retained release. A crash remains
        # visible and requires inspection instead of silently replacing evidence.
        for name in guard.SOURCE_FILES[target]:
            _exclusive(path / name, values[name], 0o400)
        _exclusive(path / "manifest.json", raw, 0o400)
        _fsync_directory(path)
        os.chmod(path, 0o500)
        _fsync_directory(parent)
        self._release(target, release)
        return release

    def verify(self, job):
        request = job["request"]
        if (job["operation"] != "deploy.verify" or job["target"] != "verify"
                or request.get("authority_epoch") != guard.EPOCH
                or not isinstance(request.get("sha"), str)
                or not re.fullmatch(r"[0-9a-f]{40}", request["sha"])):
            raise Refused("VERIFY_REQUEST_REFUSED")
        self.sources.verify(request["repo"], request["sha"])
        return {"verified": True, "repo": request["repo"], "sha": request["sha"]}

    def unit_files(self):
        """Bootstrap may install these exact files and link these fixed units."""
        return {self.services[role]: render_unit(self.policy, role) for role in self.services}

    def _run(self, argv, timeout=15):
        environment = {key: value for key, value in os.environ.items()
                       if key in ("HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")}
        environment.update({"PATH": "/usr/bin:/bin", "LC_ALL": "C", "TZ": "UTC", "PYTHONDONTWRITEBYTECODE": "1"})
        try:
            result = self.runner(argv, env=environment, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise TimeoutError("FIXED_COMMAND_OUTCOME_UNKNOWN") from None
        if len(result.stdout or b"") > 131072 or len(result.stderr or b"") > 131072:
            raise Refused("COMMAND_OUTPUT_BOUND")
        return result

    def _show(self, target):
        result = self._run(["/usr/bin/systemctl", "--user", "show", self.services[target],
                            "--property=" + ",".join(PROPERTIES)])
        if result.returncode:
            raise Refused("SERVICE_OBSERVATION_UNAVAILABLE")
        try:
            pairs = [line.split("=", 1) for line in result.stdout.decode("utf-8").splitlines() if "=" in line]
            values = guard.strict_object(pairs)
        except (UnicodeError, ValueError):
            raise Refused("SERVICE_OBSERVATION_INVALID") from None
        if (values.get("Id") != self.services[target] or values.get("LoadState") != "loaded"
                or values.get("FragmentPath") != str(self.unit_dir / self.services[target])
                or values.get("DropInPaths") != "" or values.get("NeedDaemonReload") != "no"):
            raise Refused("SERVICE_UNIT_CHANGED")
        return values

    def _unit_identity(self, target):
        names = ("worker", "updater") if target == "worker" else ("probe",)
        templates = self.unit_files()
        folder = _directory(self.unit_dir)
        for name in names:
            service = self.services[name]
            if _read(folder / service, 16384) != templates[service]:
                raise Refused("FIXED_UNIT_CONTENT_CHANGED")
            self._show(name)
        return guard.digest({self.services[name]: templates[self.services[name]].decode() for name in names})

    def _pointer(self, target):
        self._target(target)
        folder = _directory(self.root / "active")
        value = _object(_read(folder / (target + ".json"), 4096))
        if (set(value) != {"release", "owner", "generation"}
                or not isinstance(value["owner"], str) or not 1 <= len(value["owner"]) <= 128
                or not isinstance(value["generation"], str)
                or not re.fullmatch(r"[0-9a-f]{32}", value["generation"])):
            raise Refused("ACTIVE_POINTER_INVALID")
        self._release(target, value["release"])
        return {"release": value["release"], "pointer_owner": value["owner"], "pointer_generation": value["generation"]}

    def snapshot(self, target):
        pointer = self._pointer(target)
        identity = self._unit_identity(target)
        values = self._show(target)
        try:
            pid = int(values.get("MainPID", "0")) or int(values.get("ExecMainPID", "0"))
            start_ticks = int(values.get("ExecMainStartTimestampMonotonic", "0"))
        except ValueError:
            raise Refused("SERVICE_PROCESS_ID_INVALID") from None
        invocation = values.get("InvocationID", "")
        if pid < 0 or start_ticks < 0 or (invocation and not re.fullmatch(r"[0-9a-f]{32}", invocation)):
            raise Refused("SERVICE_PROCESS_ID_INVALID")
        job = values.get("Job")
        settled = (job is not None and (job == "" or job == "0" or job.startswith("0 "))
                   and values.get("ActiveState") not in ("activating", "deactivating", "reloading"))
        pointer.update({"unit_identity": identity, "invocation_id": invocation, "pid": pid,
                        "started_at": start_ticks, "settled": settled,
                        "active_state": values.get("ActiveState"), "sub_state": values.get("SubState"),
                        "service_result": values.get("Result"), "exit_status": values.get("ExecMainStatus")})
        # A pointer switch during observation must not yield a mixed snapshot.
        after = self._pointer(target)
        if any(pointer[key] != after[key] for key in POINTER_KEYS):
            raise Refused("POINTER_CHANGED_DURING_OBSERVATION")
        return pointer

    observe = snapshot

    @contextlib.contextmanager
    def _lock(self, target):
        self._target(target)
        folder = _directory(self.root / "locks")
        descriptor = os.open(str(folder / (target + ".lock")), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def _attempt(self, target, attempt):
        if not isinstance(attempt, str) or not re.fullmatch(r"[0-9a-f]{32}(?::rollback)?", attempt):
            raise Refused("ATTEMPT_ID_INVALID")
        row = self.store.target_state(target)
        job = self.store.get(row["active_job"]) if row.get("active_job") else None
        if (not job or row.get("quarantined") or job["state"] != "RUNNING"
                or attempt not in (job["intent"].get("attempt_id"), job["intent"].get("rollback_attempt"))):
            raise Refused("TARGET_ATTEMPT_NOT_OWNED")
        return job

    def _compare(self, target, expected, expected_unit):
        current = self.snapshot(target)
        if (not isinstance(expected, dict) or any(current.get(key) != expected.get(key) for key in POINTER_KEYS + SERVICE_KEYS)
                or not current["settled"] or current["unit_identity"] != expected_unit):
            raise Refused("TARGET_COMPARE_AND_SWAP_FAILED")
        return current

    def _switch(self, target, release, expected, expected_unit, attempt):
        self._release(target, release)
        with self._lock(target):
            self._attempt(target, attempt)
            self._compare(target, expected, expected_unit)
            folder = _directory(self.root / "active")
            value = {"release": release, "owner": attempt, "generation": uuid.uuid4().hex}
            temporary = folder / ("." + target + "." + uuid.uuid4().hex)
            _exclusive(temporary, encoded(value))
            # Both pointer and service are checked again immediately before replace.
            self._compare(target, expected, expected_unit)
            os.replace(str(temporary), str(folder / (target + ".json")))
            _fsync_directory(folder)
        return {"pointer_generation": value["generation"], "pointer_owner": attempt, "release": release}

    def activate(self, target, new, expected_old_snapshot, expected_unit, attempt_id):
        return self._switch(target, new, expected_old_snapshot, expected_unit, attempt_id)

    def restore(self, target, old_release, expected_new_snapshot, expected_unit, attempt_id):
        return self._switch(target, old_release, expected_new_snapshot, expected_unit, attempt_id)

    def restart(self, target, expected_snapshot, expected_unit, attempt_id):
        with self._lock(target):
            job = self._attempt(target, attempt_id)
            current = self._compare(target, expected_snapshot, expected_unit)
            if (current["pointer_owner"] != attempt_id and job["operation"] != "deploy.restart_service"):
                raise Refused("RESTART_POINTER_NOT_OWNED")
            folder = _directory(self.root / "challenges")
            temporary = folder / ("." + target + "." + uuid.uuid4().hex)
            challenge = {"release": current["release"], "pointer_generation": current["pointer_generation"],
                         "attempt_id": attempt_id, "requested_at": self.clock()}
            _exclusive(temporary, encoded(challenge))
            self._compare(target, expected_snapshot, expected_unit)
            os.replace(str(temporary), str(folder / (target + ".json")))
            _fsync_directory(folder)
            result = self._run(["/usr/bin/systemctl", "--user", "--no-block", "restart", self.services[target]])
            # Even a nonzero exit can follow a queued operation. The engine must
            # observe a fresh invocation; it may never infer failure from this code.
            return {"status": "submitted" if result.returncode == 0 else "unknown"}

    def health(self, target, expected_release, attempt_id):
        current = self.snapshot(target)
        unknown = dict(current, status="unknown", observed_at=self.clock())
        if current["release"] != expected_release or not current["settled"]:
            return unknown
        job = None
        if attempt_id is not None:
            job = self._attempt(target, attempt_id)
            if current["pointer_owner"] != attempt_id and job["operation"] != "deploy.restart_service":
                return unknown
        try:
            challenge = _object(_read(_directory(self.root / "challenges") / (target + ".json"), 4096))
        except (FileNotFoundError, Refused):
            return unknown
        if (challenge.get("release") != expected_release or challenge.get("pointer_generation") != current["pointer_generation"]
                or not isinstance(challenge.get("attempt_id"), str)
                or type(challenge.get("requested_at")) not in (int, float)
                or not math.isfinite(challenge["requested_at"])
                or (attempt_id is not None and challenge.get("attempt_id") != attempt_id)):
            return unknown
        # An identified invocation that systemd reports terminated abnormally is
        # affirmative failure evidence, including failure before its first receipt.
        baseline = (job["intent"].get("rollback_active", {}) if attempt_id and attempt_id.endswith(":rollback")
                    else job["intent"].get("restart_baseline", {})) if job else {}
        if (attempt_id is not None and current["active_state"] == "failed"
                and current["service_result"] in ("exit-code", "signal", "core-dump")
                and baseline.get("invocation_id") != current["invocation_id"]
                and "invocation_id" in baseline
                and current["invocation_id"] and current["pid"] > 0 and current["started_at"] > 0):
            return dict(unknown, status="unhealthy", attempt_id=attempt_id)
        try:
            receipt = _object(_read(_directory(self.root / "receipts") / (target + ".json"), 8192))
        except (FileNotFoundError, Refused):
            return unknown
        now, observed = self.clock(), receipt.get("observed_at")
        retained_probe = target == "probe" and attempt_id is None
        if (any(receipt.get(key) != current.get(key) for key in SERVICE_KEYS + ("release", "pointer_generation"))
                or receipt.get("attempt_id") != challenge.get("attempt_id")
                or not current["invocation_id"] or current["pid"] <= 0 or current["started_at"] <= 0
                or type(observed) not in (int, float) or not math.isfinite(observed)
                or observed > now + 1 or (not retained_probe and observed < now - 10)
                or observed < challenge["requested_at"]
                or receipt.get("status") not in ("healthy", "unhealthy")):
            return unknown
        if receipt["status"] == "healthy":
            if target == "worker" and (current["active_state"], current["sub_state"]) != ("active", "running"):
                return dict(unknown, status="unhealthy")
            if target == "probe" and (current["active_state"] != "active" or current["service_result"] != "success"
                                       or current["exit_status"] != "0"):
                return dict(unknown, status="unhealthy")
        after = self.snapshot(target)
        if any(current[key] != after[key] for key in POINTER_KEYS + SERVICE_KEYS):
            return unknown
        if retained_probe:
            # This is a new observation of a completed oneshot, not a fabricated
            # heartbeat. Preserve its original completion time explicitly.
            return dict(receipt, observed_at=now, completed_at=observed,
                        evidence="retained_oneshot_completion")
        return receipt

    def check_candidate_updater(self, new):
        self._release("worker", new)
        result = self._run(["/usr/bin/python3", "-I", "-S", "-B", str(self.launcher), "check-updater",
                            new["sha"], new["manifest_sha256"]], timeout=30)
        if result.returncode:
            return {"ok": False}
        try:
            value = _object(result.stdout)
        except Refused:
            return {"ok": False}
        return {"ok": value == {"ok": True, "release": new}}

    def guard(self, target, snapshot):
        self._compare(target, snapshot, snapshot["unit_identity"])
        return True
