"""Caller-owned, cooperative same-UID maintenance control and receipt bridge.

This is not an OS sandbox. Construct once with a trusted deployment root and a
commit_verifier that checks the caller's durable code-commit journal. Never build
it from request paths. The caller also owns the target lease and obtains current
service PID/start ticks/boot/source identities independently of these receipts.
No method starts services, reads application state, or invents counters.
"""
import contextlib
import datetime
import errno
import fcntl
import hashlib
import json
import math
import os
import re
import stat
import time
import uuid

MAX_BYTES = 32768
MAX_INT = 9007199254740991  # Interoperable JavaScript safe integer.
SOURCES = ("api", "relay")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_SOURCE_ID = re.compile(r"sha256:[a-f0-9]{64}\Z")
_UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z")
_TICKS = re.compile(r"[1-9][0-9]{0,19}\Z")
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\Z")
CONTROL_KEYS = frozenset(("schemaVersion", "state", "attemptId", "generation", "bindings"))
BINDING_KEYS = frozenset(("sourceName", "sourceId", "processId", "processInstanceId"))
RECEIPT_KEYS = frozenset((
    "schemaVersion", "sourceName", "sourceId", "sourceHashes", "processId",
    "processInstanceId", "processStartTicks", "bootId", "attemptId", "generation",
    "state", "total", "counts", "blockedReason", "providerHealthy", "providers",
    "receiptHealthy", "receiptSequence", "observedAt",
))
EXPECTED_KEYS = frozenset(("sourceId", "sourceHashes", "processId", "processStartTicks", "bootId"))
BLOCKED_REASONS = frozenset((
    "STARTUP_HELD", "RECEIPT_UNAVAILABLE", "STALE_GENERATION", "FOREIGN_ATTEMPT",
    "FOREIGN_BINDING", "MISSING_HELD_GENERATION", "PROVIDER_INVALID",
    "INVALID_CONTROL", "NOT_DRAINED", "ON_OPEN_FAILED",
))
PROVIDER_FIELDS = {
    "api": frozenset(("supervisorEnabled", "running", "timerPending")),
    "discord_relay": frozenset(("running", "timerPending", "transportConnected", "transportReady",
                                 "sessionGeneration", "heartbeatAckAgeMs", "heartbeatIntervalMs")),
    "kis_scheduler": frozenset(("ownerActive", "timerPending", "running", "configured", "faulted", "taskCount")),
    "kis_recovery": frozenset(("running",)),
    "kis_state_fault_notification": frozenset(("running",)),
}
PROVIDER_INTEGER_BOUNDS = {
    ("discord_relay", "sessionGeneration"): 1000000000,
    ("discord_relay", "heartbeatAckAgeMs"): 86400000,
    ("discord_relay", "heartbeatIntervalMs"): 86400000,
    ("kis_scheduler", "taskCount"): 5,
}

REQUIRED_PROVIDERS = {"api": frozenset(PROVIDER_FIELDS), "relay": frozenset(("discord_relay",))}


class _Failure(Exception):
    """Only fixed codes reach public results; file contents never reach errors."""


class _PublishedWriteFailure(_Failure):
    def __init__(self, control):
        super().__init__("CONTROL_DURABILITY_UNKNOWN")
        self.control = control


def _require(value, code):
    if not value:
        raise _Failure(code)


def _integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_INT


def _matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def _exact(value, keys):
    return type(value) is dict and set(value) == keys


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "DUPLICATE_FIELD")
        result[key] = value
    return result


def _source_digest(hashes):
    _require(type(hashes) is dict and 1 <= len(hashes) <= 64, "INVALID_SOURCE")
    _require(all(_matches(_ID, key) and _matches(_HASH, value)
                 for key, value in hashes.items()), "INVALID_SOURCE")
    packed = json.dumps(sorted(hashes.items()), separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(packed.encode("ascii")).hexdigest()


def _control(value):
    _require(_exact(value, CONTROL_KEYS), "INVALID_CONTROL")
    _require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and
             value["state"] in ("HELD", "OPEN") and _matches(_ID, value["attemptId"]) and
             _integer(value["generation"], 1) and type(value["bindings"]) is list,
             "INVALID_CONTROL")
    if value["state"] == "HELD":
        _require(value["bindings"] == [], "INVALID_CONTROL")
    else:
        _require(len(value["bindings"]) == 2, "INVALID_CONTROL")
        names = set()
        for binding in value["bindings"]:
            _require(_exact(binding, BINDING_KEYS), "INVALID_CONTROL")
            _require(binding["sourceName"] in SOURCES and binding["sourceName"] not in names and
                     _matches(_SOURCE_ID, binding["sourceId"]) and _integer(binding["processId"], 1) and
                     _matches(_UUID, binding["processInstanceId"]), "INVALID_CONTROL")
            names.add(binding["sourceName"])
    return value


def _expected(value):
    _require(_exact(value, frozenset(SOURCES)), "INVALID_EXPECTED")
    result = {}
    for name in SOURCES:
        identity = value[name]
        _require(type(identity) is dict and set(identity) in
                 (EXPECTED_KEYS, EXPECTED_KEYS | {"processInstanceId"}), "INVALID_EXPECTED")
        _require(_source_digest(identity["sourceHashes"]) == identity["sourceId"] and
                 _integer(identity["processId"], 1) and _matches(_TICKS, identity["processStartTicks"]) and
                 _matches(_UUID, identity["bootId"]) and
                 ("processInstanceId" not in identity or _matches(_UUID, identity["processInstanceId"])),
                 "INVALID_EXPECTED")
        result[name] = dict(identity, sourceHashes=dict(identity["sourceHashes"]))
    _require(result["api"]["processId"] != result["relay"]["processId"], "INVALID_EXPECTED")
    return result


def _receipt(value, name, expected, now, max_age, future_skew):
    _require(_exact(value, RECEIPT_KEYS), "INVALID_RECEIPT")
    _require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and
             value["sourceName"] == name and _matches(_SOURCE_ID, value["sourceId"]) and
             _integer(value["processId"], 1) and _matches(_UUID, value["processInstanceId"]) and
             _matches(_TICKS, value["processStartTicks"]) and _matches(_UUID, value["bootId"]) and
             value["state"] in ("HELD", "OPEN") and _integer(value["total"]) and
             _exact(value["counts"], frozenset(("operation", "child"))) and
             all(_integer(count) for count in value["counts"].values()) and
             sum(value["counts"].values()) == value["total"] and
             (value["blockedReason"] is None or value["blockedReason"] in BLOCKED_REASONS) and
             type(value["providerHealthy"]) is bool and type(value["receiptHealthy"]) is bool and
             _integer(value["receiptSequence"], 1) and _matches(_TIMESTAMP, value["observedAt"]),
             "INVALID_RECEIPT")
    _require((_matches(_ID, value["attemptId"]) and _integer(value["generation"], 1)) or
             (value["attemptId"] is None and type(value["generation"]) is int and value["generation"] == 0 and
              value["state"] == "HELD" and value["blockedReason"] is not None), "INVALID_RECEIPT")
    providers = value["providers"]
    _require(type(providers) is dict and len(providers) <= len(PROVIDER_FIELDS), "INVALID_PROVIDER")
    for provider, fields in providers.items():
        _require(provider in PROVIDER_FIELDS and type(fields) is dict and
                 (set(fields) == PROVIDER_FIELDS[provider] or
                  (fields == {} and value["providerHealthy"] is False)) and
                 all((type(item) is int and 0 <= item <= PROVIDER_INTEGER_BOUNDS[(provider, field)])
                     if (provider, field) in PROVIDER_INTEGER_BOUNDS else type(item) is bool
                     for field, item in fields.items()), "INVALID_PROVIDER")
    _require(_source_digest(value["sourceHashes"]) == value["sourceId"], "SOURCE_MISMATCH")
    for key, wanted in expected.items():
        _require(value[key] == wanted, "SOURCE_MISMATCH" if key in ("sourceId", "sourceHashes")
                 else "PROCESS_MISMATCH")
    try:
        observed = datetime.datetime.fromisoformat(value["observedAt"][:-1] + "+00:00").timestamp()
    except (ValueError, OverflowError):
        raise _Failure("INVALID_RECEIPT")
    _require(-future_skew <= now - observed <= max_age, "RECEIPT_NOT_FRESH")
    return value


class MaintenanceControl:
    """Use root/application-maintenance only; transport requests supply no paths.

    commit_verifier(attempt_id, generation) must independently read the durable
    caller journal and return exactly True after code commit. A first OPEN is
    irrevocable for this bridge, even if processes subsequently fail to reopen.
    A new attempt establishes a new HELD generation after restarts/recovery.
    """

    def __init__(self, trusted_root, *, commit_verifier=None, owner_uid=None,
                 max_receipt_age=5.0, max_future_skew=1.0, clock=time.time):
        self._root = os.fspath(trusted_root)
        self._uid = os.getuid() if owner_uid is None else owner_uid
        valid_root = (type(self._root) is str and os.path.isabs(self._root) and
                      self._root == os.path.normpath(self._root) and self._root != "/")
        limits = (max_receipt_age, max_future_skew)
        if not (valid_root and type(self._uid) is int and self._uid >= 0 and
                all(type(n) in (int, float) and math.isfinite(n) for n in limits) and
                0 < max_receipt_age <= 120 and 0 <= max_future_skew <= 5 and
                callable(clock) and (commit_verifier is None or callable(commit_verifier))):
            raise ValueError("INVALID_CONFIG")
        self._max_age = max_receipt_age
        self._skew = max_future_skew
        self._clock = clock
        self._verify_commit = commit_verifier

    def _safe_directory(self, fd):
        value = os.fstat(fd)
        _require(stat.S_ISDIR(value.st_mode) and value.st_uid == self._uid and
                 value.st_mode & 0o022 == 0, "UNSAFE_DIRECTORY")
        return value

    def _root_fd(self):
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in self._root.split("/")[1:]:
                following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = following
            self._safe_directory(fd)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _directory(self, parent, name, create=False):
        if create:
            try:
                os.mkdir(name, mode=0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError:
                pass
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            self._safe_directory(fd)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _file_stat(self, value):
        _require(stat.S_ISREG(value.st_mode) and value.st_uid == self._uid and value.st_nlink == 1 and
                 value.st_mode & 0o022 == 0 and value.st_size <= MAX_BYTES, "UNSAFE_FILE")

    def _read(self, directory, filename):
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            self._file_stat(before)
            data = bytearray()
            while len(data) <= MAX_BYTES:
                chunk = os.read(fd, MAX_BYTES + 1 - len(data))
                if not chunk:
                    break
                data.extend(chunk)
            after = os.fstat(fd)
            current = os.stat(filename, dir_fd=directory, follow_symlinks=False)
            self._file_stat(current)
            attributes = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
            _require(len(data) == before.st_size <= MAX_BYTES and
                     all(getattr(before, key) == getattr(after, key) == getattr(current, key)
                         for key in attributes), "CHANGED_FILE")
            try:
                return json.loads(data.decode("utf-8"), object_pairs_hook=_pairs,
                                  parse_constant=lambda _: (_ for _ in ()).throw(_Failure("INVALID_JSON")))
            except (UnicodeError, ValueError, RecursionError):
                raise _Failure("INVALID_JSON")
        finally:
            os.close(fd)

    def _recheck(self, root, maintenance):
        fresh_root = self._root_fd()
        try:
            fresh_dir = self._directory(fresh_root, "application-maintenance")
            try:
                for original, fresh in ((root, fresh_root), (maintenance, fresh_dir)):
                    before, after = self._safe_directory(original), self._safe_directory(fresh)
                    _require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino), "CHANGED_DIRECTORY")
            finally:
                os.close(fresh_dir)
        finally:
            os.close(fresh_root)

    @contextlib.contextmanager
    def _locked(self, create=False, readonly=False):
        fds = []
        try:
            root = self._root_fd()
            fds.append(root)
            maintenance = self._directory(root, "application-maintenance", create)
            fds.append(maintenance)
            if create:
                receipts = self._directory(maintenance, "receipts", True)
                os.close(receipts)
            flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_RDONLY if readonly else os.O_RDWR)
            lock = os.open(".control.lock", flags | (os.O_CREAT if create else 0), 0o600, dir_fd=maintenance)
            fds.append(lock)
            self._file_stat(os.fstat(lock))
            fcntl.flock(lock, fcntl.LOCK_SH if readonly else fcntl.LOCK_EX)
            self._recheck(root, maintenance)
            actual = os.stat(".control.lock", dir_fd=maintenance, follow_symlinks=False)
            self._file_stat(actual)
            _require((actual.st_dev, actual.st_ino) == (os.fstat(lock).st_dev, os.fstat(lock).st_ino), "CHANGED_FILE")
            yield root, maintenance
        finally:
            for fd in reversed(fds):
                os.close(fd)

    def _write(self, root, maintenance, control):
        # Refuse unsafe pre-existing targets before atomically replacing them.
        try:
            self._read(maintenance, "control.json")
        except FileNotFoundError:
            pass
        name = ".control." + uuid.uuid4().hex + ".tmp"
        fd = None
        published = False
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=maintenance)
            data = (json.dumps(control, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
            with os.fdopen(fd, "wb") as output:
                fd = None
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            self._recheck(root, maintenance)
            os.replace(name, "control.json", src_dir_fd=maintenance, dst_dir_fd=maintenance)
            published = True
            os.fsync(maintenance)
        except OSError:
            if published:
                raise _PublishedWriteFailure(control)
            raise
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(name, dir_fd=maintenance)
            except OSError:
                # Cleanup failure cannot hide an OPEN publication or its durability failure.
                pass

    def _result(self, control, code="OK", receipts=None):
        result = {"ok": code == "OK", "code": code, "control": control,
                  "committedOpen": None if control is None else control["state"] == "OPEN"}
        if receipts is not None:
            result["receipts"] = receipts
            result["drained"] = all(self._drained(receipt) for receipt in receipts.values())
            if control["state"] == "OPEN":
                opened = sum(receipt["state"] == "OPEN" and receipt["blockedReason"] is None
                             for receipt in receipts.values())
                result["reopenStatus"] = "OPEN" if opened == 2 else "PARTIAL" if opened == 1 else "PENDING"
        return result

    @staticmethod
    def _drained(receipt):
        return (receipt["state"] == "HELD" and receipt["total"] == 0 and receipt["blockedReason"] is None and
                receipt["providerHealthy"] and receipt["receiptHealthy"] and
                set(receipt["providers"]) == REQUIRED_PROVIDERS[receipt["sourceName"]] and
                all(provider["running"] is False for provider in receipt["providers"].values()))

    def _failure(self, failure, control):
        if isinstance(failure, _PublishedWriteFailure):
            control = failure.control
        if isinstance(failure, _Failure):
            code = str(failure)
        elif isinstance(failure, FileNotFoundError):
            code = "TRANSPORT_MISSING"
        elif isinstance(failure, OSError):
            code = "UNSAFE_PATH" if failure.errno in (errno.ELOOP, errno.ENOTDIR) else "TRANSPORT_UNAVAILABLE"
        else:
            code = "INVALID_INPUT"
        return self._result(control, code)

    def _receipts(self, maintenance, control, expected):
        receipts = self._directory(maintenance, "receipts")
        try:
            now = self._clock()
            _require(type(now) in (int, float) and math.isfinite(now), "INVALID_CLOCK")
            result = {}
            bindings = {binding["sourceName"]: binding for binding in control["bindings"]}
            for name in SOURCES:
                value = _receipt(self._read(receipts, name + ".json"), name, expected[name], now,
                                 self._max_age, self._skew)
                _require(value["attemptId"] == control["attemptId"] and
                         value["generation"] == control["generation"], "RECEIPT_GENERATION_MISMATCH")
                if control["state"] == "OPEN":
                    _require(all(value[key] == wanted for key, wanted in bindings[name].items()), "BINDING_MISMATCH")
                result[name] = value
            return result
        finally:
            os.close(receipts)

    def initialize_hold(self, attempt_id):
        """Explicit installer action; existing valid HELD same-attempt is a no-op."""
        control = None
        try:
            _require(_matches(_ID, attempt_id), "INVALID_ATTEMPT")
            with self._locked(create=True) as (root, maintenance):
                try:
                    control = _control(self._read(maintenance, "control.json"))
                except FileNotFoundError:
                    control = {"schemaVersion": 1, "state": "HELD", "attemptId": attempt_id,
                               "generation": 1, "bindings": []}
                    self._write(root, maintenance, control)
                    return self._result(control)
                _require(control["attemptId"] == attempt_id and control["state"] == "HELD", "ALREADY_INITIALIZED")
                return self._result(control)
        except (OSError, _Failure, TypeError, ValueError) as failure:
            return self._failure(failure, control)

    def request_hold(self, attempt_id):
        """Caller holds its target lease; a new attempt advances the generation."""
        control = None
        try:
            _require(_matches(_ID, attempt_id), "INVALID_ATTEMPT")
            with self._locked() as (root, maintenance):
                control = _control(self._read(maintenance, "control.json"))
                if control["attemptId"] == attempt_id:
                    _require(control["state"] == "HELD", "ATTEMPT_ALREADY_OPEN")
                    return self._result(control)
                _require(control["generation"] < MAX_INT, "GENERATION_EXHAUSTED")
                following = {"schemaVersion": 1, "state": "HELD", "attemptId": attempt_id,
                             "generation": control["generation"] + 1, "bindings": []}
                self._write(root, maintenance, following)
                return self._result(following)
        except (OSError, _Failure, TypeError, ValueError) as failure:
            return self._failure(failure, control)

    def observe_control(self):
        """Read only: validate control independently of stopped or starting services.

        This supplies no drain proof. The caller must establish that separately.
        """
        control = None
        try:
            with self._locked(readonly=True) as (root, maintenance):
                control = _control(self._read(maintenance, "control.json"))
                self._recheck(root, maintenance)
                return self._result(control)
        except (OSError, _Failure, TypeError, ValueError) as failure:
            return self._failure(failure, control)

    def observe(self, expected_processes):
        """Read only: creates no lock, directories, control, or receipt files."""
        control = None
        try:
            expected = _expected(expected_processes)
            with self._locked(readonly=True) as (_, maintenance):
                control = _control(self._read(maintenance, "control.json"))
                return self._result(control, receipts=self._receipts(maintenance, control, expected))
        except (OSError, _Failure, TypeError, ValueError) as failure:
            return self._failure(failure, control)

    def request_open(self, attempt_id, generation, expected_processes):
        """First OPEN requires fresh drained receipts and durable caller proof."""
        control = None
        try:
            _require(_matches(_ID, attempt_id) and _integer(generation, 1), "INVALID_ATTEMPT")
            expected = _expected(expected_processes)
            with self._locked() as (root, maintenance):
                control = _control(self._read(maintenance, "control.json"))
                _require(control["attemptId"] == attempt_id and control["generation"] == generation,
                         "ATTEMPT_MISMATCH")
                receipts = self._receipts(maintenance, control, expected)
                if control["state"] == "OPEN":
                    return self._result(control, receipts=receipts)
                _require(all(self._drained(receipt) for receipt in receipts.values()), "NOT_DRAINED")
                try:
                    committed = self._verify_commit(attempt_id, generation) if self._verify_commit is not None else False
                except Exception:
                    committed = False
                _require(committed is True, "COMMIT_NOT_PROVEN")
                # The verifier may take time: receipts must still be fresh at commit.
                receipts = self._receipts(maintenance, control, expected)
                _require(all(self._drained(receipt) for receipt in receipts.values()), "NOT_DRAINED")
                following = dict(control, state="OPEN", bindings=[
                    {key: receipts[name][key] for key in BINDING_KEYS} for name in SOURCES])
                self._write(root, maintenance, following)
                return self._result(following, receipts=receipts)
        except (OSError, _Failure, TypeError, ValueError) as failure:
            return self._failure(failure, control)
