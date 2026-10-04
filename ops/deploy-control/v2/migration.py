"""Schema-1 migration primitives for a retained controller and fixed authority.

This is not another service manager. The existing updater owns restart/receipt
loops; these primitives protect the controller selection, quiescence barrier and
old ledger. The immutable outer launcher must implement/read this schema before
importing *any* candidate module, and verify the selected retained package.

Host.quiescence_proof() is a proof of a held admission/effect lock, not a promise:
the host must keep admission held and other updaters idle until it explicitly
releases the barrier. An initial v1 host may stop admission and pause scheduling,
but must let an already running updater finish, never kill it or clear its work.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import time
import uuid


TARGETS = ("HERMES_API", "HERMES_DISCORD_RELAY", "KIS", "DEPLOY_WORKER")
TARGET = "DEPLOY_WORKER"
EPOCH = "deploy-control-v2"
SCHEMA = 1
TERMINAL = frozenset(("COMMITTED", "ROLLED_BACK", "NOT_APPLIED", "QUARANTINED"))
LEGACY_TERMINAL = frozenset(("SUCCEEDED", "FAILED", "ROLLED_BACK", "UNKNOWN_OUTCOME", "MANUAL_RECOVERY_REQUIRED", "BLOCKED"))
TABLES = ("requests", "targets", "journal", "commands", "outbox")
POINTER_KEYS = ("controller", "release", "pointer_owner", "pointer_generation")
SERVICE_KEYS = ("unit_identity", "invocation_id", "pid", "started_at")
PROCESS_KEYS = ("invocation_id", "pid", "started_at")
MAX_RECORD = 262144
MAX_ROW = 1048576
MAX_ROWS = 250000
MAX_SNAPSHOT_SECONDS = 15
MIGRATION_OPERATIONS = frozenset(("deploy.update_self", "deploy.migrate_registry", "deploy.test_recovery",
                                  "deploy.rollback", "deploy.restart_service"))


class MigrationError(RuntimeError):
    pass


class NotReady(MigrationError):
    """Old controller remains selected; old work must drain or be reconciled."""


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


def _canonical(path):
    path = Path(os.path.abspath(os.fspath(path)))
    if path.resolve() != path:
        raise MigrationError("DATABASE_PATH_NOT_CANONICAL")
    return path


def _sidecars(path):
    for suffix in ("-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        try:
            identity = candidate.lstat()
        except FileNotFoundError:
            continue
        if (not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid()
                or identity.st_nlink != 1 or identity.st_mode & 0o022):
            raise MigrationError("DATABASE_SIDECAR_OWNERSHIP_INVALID")


def _readonly(path):
    path = _canonical(path)
    _sidecars(path)
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    db = None
    try:
        identity = os.fstat(fd)
        if (not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid()
                or identity.st_nlink != 1 or identity.st_mode & 0o022):
            raise MigrationError("DATABASE_FILE_OWNERSHIP_INVALID")
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)
        after = path.lstat()
        _sidecars(path)
        if (path.resolve() != path or not stat.S_ISREG(after.st_mode)
                or (identity.st_dev, identity.st_ino) != (after.st_dev, after.st_ino)):
            raise MigrationError("DATABASE_IDENTITY_CHANGED_WHILE_OPENING")
        return db
    except BaseException:
        if db is not None:
            db.close()
        raise
    finally:
        os.close(fd)


def legacy_snapshot(path, max_rows=MAX_ROWS, max_seconds=MAX_SNAPSHOT_SECONDS,
                    allowed_request_id=None, allowed_digest=None):
    """Consistent, read-only logical snapshot; includes pending/uncertain work."""
    if (allowed_request_id is None) != (allowed_digest is None):
        raise MigrationError("EXACT_ALLOWED_REQUEST_ID_AND_DIGEST_REQUIRED")
    identity = _canonical(path).lstat()
    db = _readonly(path)
    deadline = time.monotonic() + max_seconds
    db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
    try:
        db.execute("BEGIN")
        if db.execute("PRAGMA user_version").fetchone()[0] != 1:
            raise MigrationError("LEGACY_SCHEMA_UNSUPPORTED")
        hasher = hashlib.sha256()
        result = {"schema": 1, "identity": str(identity.st_dev) + ":" + str(identity.st_ino),
                  "counts": {}, "open_requests": [], "undelivered_outbox": [], "owned_targets": [],
                  "open_request_count": 0, "undelivered_outbox_count": 0, "owned_target_count": 0}
        allowed_seen = allowed_request_id is None
        schema_count = 0
        for name, sql, size in db.execute("SELECT name,CASE WHEN length(sql)<=65536 THEN sql ELSE NULL END,length(sql) FROM sqlite_master WHERE type='table' ORDER BY name"):
            schema_count += 1
            if schema_count > 256 or size is None or size > 65536:
                raise MigrationError("LEGACY_SCHEMA_BOUND_EXCEEDED")
            hasher.update((encoded(["schema", name, sql]) + "\n").encode())
        total = 0
        for table in TABLES:
            names = [row[1] for row in db.execute("PRAGMA table_info(" + table + ")")]
            if not names or len(names) > 64 or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) for name in names):
                raise MigrationError("LEGACY_TABLE_COLUMNS_INVALID")
            # SQLite checks size before returning column values, so even a corrupt
            # enormous TEXT value never becomes a large Python allocation.
            size = "+".join('COALESCE(length(CAST("' + name + '" AS BLOB)),0)' for name in names)
            columns = ",".join('CASE WHEN (' + size + ')<=' + str(MAX_ROW) + ' THEN "' + name + '" ELSE NULL END' for name in names)
            count = 0
            for values in db.execute("SELECT " + columns + ",(" + size + ") FROM " + table + " ORDER BY rowid"):
                count += 1
                total += 1
                if values[-1] > MAX_ROW or total > max_rows or time.monotonic() >= deadline:
                    raise MigrationError("LEGACY_SNAPSHOT_BOUND_EXCEEDED")
                row = dict(zip(names, values[:-1]))
                hasher.update((encoded([table, row]) + "\n").encode())
                category = None
                exempt_request = False
                if table == "requests" and allowed_request_id is not None and row["request_id"] == allowed_request_id:
                    if (row["digest"] != allowed_digest or row["target"] != TARGET
                            or row["operation"] not in MIGRATION_OPERATIONS or row["state"] not in ("QUEUED", "RUNNING")):
                        raise MigrationError("CURRENT_MIGRATION_REQUEST_IDENTITY_INVALID")
                    allowed_seen = True
                    exempt_request = True
                if table == "requests" and row["state"] not in LEGACY_TERMINAL:
                    if not exempt_request:
                        category = ("open_requests", "open_request_count", row["request_id"])
                elif table == "outbox" and row["state"] != "DELIVERED":
                    category = ("undelivered_outbox", "undelivered_outbox_count", row["item_key"])
                elif table == "targets" and (row["active_job"] or row["quarantined"]):
                    if not (allowed_request_id is not None and row["active_job"] == allowed_request_id
                            and row["target"] == TARGET and not row["quarantined"]):
                        category = ("owned_targets", "owned_target_count", row["target"])
                if category:
                    result[category[1]] += 1
                    if len(result[category[0]]) < 100:
                        result[category[0]].append(category[2])
            result["counts"][table] = count
        result["digest"] = hasher.hexdigest()
        after = _canonical(path).lstat()
        if not allowed_seen or (identity.st_dev, identity.st_ino) != (after.st_dev, after.st_ino):
            raise MigrationError("ALLOWED_REQUEST_MISSING_OR_LEDGER_REPLACED")
        db.execute("ROLLBACK")
        return result
    except sqlite3.OperationalError as error:
        if time.monotonic() >= deadline:
            raise MigrationError("LEGACY_SNAPSHOT_TIME_BOUND_EXCEEDED") from None
        raise MigrationError("LEGACY_SNAPSHOT_READ_FAILED") from error
    finally:
        db.close()


def descriptor(value, authority_epoch):
    """Only these identities cross the immutable selector's schema boundary."""
    if not isinstance(value, dict) or set(value) != {"release", "epoch", "authority_epoch", "targets", "registry_epoch", "registry_sha256"}:
        raise MigrationError("CONTROLLER_DESCRIPTOR_INVALID")
    release = value["release"]
    if (not isinstance(release, dict) or set(release) != {"sha", "manifest_sha256", "package"}
            or not re.fullmatch(r"[0-9a-f]{40}", str(release.get("sha", "")))
            or not re.fullmatch(r"[0-9a-f]{64}", str(release.get("manifest_sha256", "")))
            or release.get("package") != "controller-" + release["sha"]
            or not isinstance(value["epoch"], str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", value["epoch"])
            or value["authority_epoch"] != authority_epoch
            or not isinstance(value["registry_epoch"], str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", value["registry_epoch"])
            or not isinstance(value["registry_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["registry_sha256"])
            or not isinstance(value["targets"], list) or len(value["targets"]) != 4
            or set(value["targets"]) != set(TARGETS)):
        raise MigrationError("CONTROLLER_AUTHORITY_OR_IDENTITY_CHANGED")
    return json.loads(encoded(value))


def _proof(value):
    required = {"admission_held", "updater_idle", "ledger_identity", "barrier_id"}
    if (not isinstance(value, dict) or set(value) != required
            or value["admission_held"] is not True or value["updater_idle"] is not True
            or any(not isinstance(value[key], str) or not 1 <= len(value[key]) <= 256
                   for key in ("ledger_identity", "barrier_id"))):
        raise NotReady("STABLE_ADMISSION_AND_EFFECT_BARRIER_REQUIRED")
    return dict(value)


def _same(left, right, keys):
    return all(key in left and key in right and left[key] == right[key] for key in keys)


def unit_plan(value, old, attempt_id):
    """Validate the immutable exact-map envelope, never an allowed-hash list."""
    keys = {"schema", "transition_id", "attempt_id", "target", "qualification_sha256", "context_sha256",
            "mapping_sha256", "candidate_hashes", "old_unit_map", "new_unit_map", "old_unit_identity",
            "new_unit_identity", "plan_sha256"}
    roles = {"worker", "updater", "recovery_timer"}
    context = {"controller_epoch": old["controller"]["epoch"],
               "controller_sha256": old["controller"]["release"]["manifest_sha256"],
               "registry_epoch": old["controller"]["registry_epoch"],
               "registry_sha256": old["controller"]["registry_sha256"]}
    if (not isinstance(value, dict) or set(value) != keys or value["schema"] != 1
            or value["target"] != TARGET or value["attempt_id"] != attempt_id or value["transition_id"] != attempt_id
            or value["context_sha256"] != digest(context)
            or not isinstance(value["candidate_hashes"], dict) or set(value["candidate_hashes"]) != roles
            or not isinstance(value["old_unit_map"], dict) or not isinstance(value["new_unit_map"], dict)
            or len(value["new_unit_map"]) != 3 or not set(value["old_unit_map"]) <= set(value["new_unit_map"])):
        raise MigrationError("CONTROLLER_UNIT_PLAN_BINDING_INVALID")
    for name in ("qualification_sha256", "context_sha256", "mapping_sha256", "old_unit_identity", "new_unit_identity", "plan_sha256"):
        if not isinstance(value[name], str) or not re.fullmatch(r"[0-9a-f]{64}", value[name]):
            raise MigrationError("CONTROLLER_UNIT_PLAN_HASH_INVALID")
    for sha in value["candidate_hashes"].values():
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise MigrationError("CONTROLLER_UNIT_PLAN_HASH_INVALID")
    for mapping in (value["old_unit_map"], value["new_unit_map"]):
        for name, identity in mapping.items():
            if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}\.(?:service|timer)", name)
                    or not isinstance(identity, dict) or set(identity) != {"sha256", "size", "mode", "uid", "gid"}
                    or not isinstance(identity["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", identity["sha256"])
                    or type(identity["size"]) is not int or not 0 < identity["size"] <= 65536
                    or type(identity["mode"]) is not int or not 0 <= identity["mode"] <= 0o777
                    or any(type(identity[key]) is not int or identity[key] < 0 for key in ("uid", "gid"))):
                raise MigrationError("CONTROLLER_UNIT_PLAN_MAP_INVALID")
    if (digest(value["old_unit_map"]) != value["old_unit_identity"]
            or digest(value["new_unit_map"]) != value["new_unit_identity"]
            or value["old_unit_identity"] != old["unit_identity"]
            or digest({key: item for key, item in value.items() if key != "plan_sha256"}) != value["plan_sha256"]):
        raise MigrationError("CONTROLLER_UNIT_PLAN_MAP_IDENTITY_MISMATCH")
    return json.loads(encoded(value))


class MigrationJournal:
    """Separate durable database; never changes the v1 request/outbox schema."""
    def __init__(self, path):
        self.path = os.path.abspath(os.fspath(path))
        self.db = sqlite3.connect(self.path, isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        if self.db.execute("PRAGMA user_version").fetchone()[0] not in (0, SCHEMA):
            raise MigrationError("MIGRATION_SCHEMA_UNSUPPORTED")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS migrations (
          migration_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
          phase TEXT NOT NULL, record_json TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS migration_slot (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), active_id TEXT, quarantined INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO migration_slot(singleton) VALUES(1);
        CREATE TABLE IF NOT EXISTS migration_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, migration_id TEXT NOT NULL,
          phase TEXT NOT NULL, details_json TEXT NOT NULL, recorded_at REAL NOT NULL);
        PRAGMA user_version=1;
        """)
        fd = os.open(os.path.dirname(self.path), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        else:
            self.db.execute("COMMIT")

    @staticmethod
    def _row(row):
        if row is None:
            return None
        value = dict(row)
        value["record"] = json.loads(value.pop("record_json"))
        return value

    def get(self, migration_id):
        return self._row(self.db.execute("SELECT * FROM migrations WHERE migration_id=?", (migration_id,)).fetchone())

    def active(self):
        row = self.db.execute("SELECT active_id FROM migration_slot WHERE singleton=1").fetchone()
        return self.get(row[0]) if row and row[0] else None

    def prepare(self, migration_id, request_digest, record):
        now = time.time()
        if len(encoded({"prepared": record}).encode()) > MAX_RECORD:
            raise MigrationError("MIGRATION_RECORD_BOUND_EXCEEDED")
        with self.transaction():
            existing = self.get(migration_id)
            if existing:
                if existing["request_digest"] != request_digest or existing["record"].get("prepared") != record:
                    raise MigrationError("MIGRATION_ID_REUSED")
                return existing
            slot = self.db.execute("SELECT * FROM migration_slot WHERE singleton=1").fetchone()
            if slot["active_id"] or slot["quarantined"]:
                raise NotReady("CONTROLLER_MIGRATION_OWNED_OR_QUARANTINED")
            self.db.execute("INSERT INTO migrations VALUES(?,?,'PREPARED',?,?,?)",
                            (migration_id, request_digest, encoded({"prepared": record}), now, now))
            self.db.execute("UPDATE migration_slot SET active_id=? WHERE singleton=1", (migration_id,))
            self._event(migration_id, "PREPARED", record, now)
        return self.get(migration_id)

    def _event(self, migration_id, phase, details, now):
        self.db.execute("INSERT INTO migration_events(migration_id,phase,details_json,recorded_at) VALUES(?,?,?,?)",
                        (migration_id, phase, encoded(details), now))

    def advance(self, migration_id, phase, **details):
        allowed = {"PREPARED": {"ACTIVATE_PREPARED", "NOT_APPLIED"},
                   "ACTIVATE_PREPARED": {"ACTIVATED", "NOT_APPLIED"},
                   "ACTIVATED": {"VERIFYING", "RESTORE_PREPARED", "COMMITTED"},
                   "VERIFYING": {"RESTORE_PREPARED", "COMMITTED"},
                   "RESTORE_PREPARED": {"RESTORED"}, "RESTORED": {"ROLLED_BACK"}}
        now = time.time()
        with self.transaction():
            current = self.get(migration_id)
            if not current or current["phase"] in TERMINAL:
                raise MigrationError("MIGRATION_IS_MISSING_OR_TERMINAL")
            if phase != "QUARANTINED" and phase not in allowed.get(current["phase"], set()):
                raise MigrationError("MIGRATION_TRANSITION_INVALID")
            record = current["record"]
            if "prepared" in details:
                raise MigrationError("PREPARED_IDENTITIES_ARE_IMMUTABLE")
            record.update(details)
            if len(encoded(record).encode()) > MAX_RECORD:
                raise MigrationError("MIGRATION_RECORD_BOUND_EXCEEDED")
            self.db.execute("UPDATE migrations SET phase=?,record_json=?,updated_at=? WHERE migration_id=?",
                            (phase, encoded(record), now, migration_id))
            self._event(migration_id, phase, details, now)
            if phase == "QUARANTINED":
                self.db.execute("UPDATE migration_slot SET quarantined=1 WHERE singleton=1")
            elif phase in TERMINAL:
                self.db.execute("UPDATE migration_slot SET active_id=NULL WHERE singleton=1")
        return self.get(migration_id)

    def capture(self, migration_id, key, value):
        """Write an immutable observation/deadline once, outside the old ledger."""
        if key not in ("new_service", "restored_service", "health_deadline", "rollback_deadline", "fault_binding", "transition_deadline", "restore_deadline"):
            raise MigrationError("MIGRATION_CAPTURE_KEY_INVALID")
        return self._record_field(migration_id, key, value)

    def _record_field(self, migration_id, key, value):
        with self.transaction():
            entry = self.get(migration_id)
            if not entry or entry["phase"] in TERMINAL:
                raise MigrationError("MIGRATION_IS_MISSING_OR_TERMINAL")
            record = entry["record"]
            if key in record:
                if record[key] != value:
                    raise MigrationError("MIGRATION_CAPTURE_CHANGED")
                return entry
            record[key] = value
            raw = encoded(record)
            if len(raw.encode()) > MAX_RECORD:
                raise MigrationError("MIGRATION_RECORD_BOUND_EXCEEDED")
            now = time.time()
            self.db.execute("UPDATE migrations SET record_json=?,updated_at=? WHERE migration_id=?", (raw, now, migration_id))
            self._event(migration_id, "CAPTURED", {key: value}, now)
        return self.get(migration_id)

    def prepare_effect(self, migration_id, name, intent):
        if name not in ("activate", "restart", "restore", "restart_old", "fault_arm", "fault_retire"):
            raise MigrationError("MIGRATION_EFFECT_INVALID")
        with self.transaction():
            entry = self.get(migration_id)
            if not entry or entry["phase"] in TERMINAL:
                raise MigrationError("MIGRATION_IS_MISSING_OR_TERMINAL")
            record = entry["record"]
            effects = record.setdefault("effects", {})
            if name in effects:
                if effects[name]["intent"] != intent:
                    raise MigrationError("MIGRATION_EFFECT_INTENT_CHANGED")
                return False
            now = time.time()
            effects[name] = {"intent": intent, "state": "PREPARED", "prepared_at": now}
            raw = encoded(record)
            if len(raw.encode()) > MAX_RECORD:
                raise MigrationError("MIGRATION_RECORD_BOUND_EXCEEDED")
            self.db.execute("UPDATE migrations SET record_json=?,updated_at=? WHERE migration_id=?", (raw, now, migration_id))
            self._event(migration_id, "EFFECT_PREPARED", {"name": name, "intent": intent}, now)
        return True

    def complete_effect(self, migration_id, name):
        with self.transaction():
            entry = self.get(migration_id)
            if not entry or entry["phase"] in TERMINAL:
                raise MigrationError("MIGRATION_IS_MISSING_OR_TERMINAL")
            record = entry["record"]
            effect = record.get("effects", {}).get(name)
            if not effect:
                raise MigrationError("MIGRATION_EFFECT_NOT_PREPARED")
            if effect["state"] == "RETURNED":
                return
            effect["state"] = "RETURNED"
            now = time.time()
            self.db.execute("UPDATE migrations SET record_json=?,updated_at=? WHERE migration_id=?", (encoded(record), now, migration_id))
            self._event(migration_id, "EFFECT_RETURNED", {"name": name}, now)


def recovery_selector(journal_path):
    """Read-only bootstrap contract. No candidate import and no ledger creation.

    A malformed/missing active record is an error, never permission to fall
    through to the new pointer. Missing journal means no migration was prepared.
    """
    journal_path = _canonical(journal_path)
    if not os.path.lexists(str(journal_path)):
        return {"controller": None, "disposition": "USE_ACTIVE", "quarantined": False}
    db = _readonly(journal_path)
    try:
        db.execute("BEGIN")
        if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA:
            raise MigrationError("MIGRATION_SCHEMA_UNSUPPORTED")
        slot = db.execute("SELECT CASE WHEN length(active_id)<=256 THEN active_id ELSE NULL END,quarantined,length(active_id) FROM migration_slot WHERE singleton=1").fetchone()
        if slot is None or slot[1] not in (0, 1) or (slot[2] is not None and not 1 <= slot[2] <= 256):
            raise MigrationError("MIGRATION_SLOT_MISSING")
        if not slot[0]:
            if slot[1]:
                raise MigrationError("QUARANTINED_MIGRATION_ID_MISSING")
            return {"controller": None, "disposition": "USE_ACTIVE", "quarantined": False}
        row = db.execute("SELECT phase,length(CAST(record_json AS BLOB)) FROM migrations WHERE migration_id=?", (slot[0],)).fetchone()
        phases = {"PREPARED", "ACTIVATE_PREPARED", "ACTIVATED", "VERIFYING", "RESTORE_PREPARED", "RESTORED", "QUARANTINED"}
        if not row or row[0] not in phases or type(row[1]) is not int or not 0 < row[1] <= MAX_RECORD:
            raise MigrationError("MIGRATION_SLOT_INCONSISTENT")
        if (row[0] == "QUARANTINED") != bool(slot[1]):
            raise MigrationError("MIGRATION_QUARANTINE_INCONSISTENT")
        raw = db.execute("SELECT record_json FROM migrations WHERE migration_id=?", (slot[0],)).fetchone()[0]
        prepared = json.loads(raw)["prepared"]
        old = descriptor(prepared["old_controller"], EPOCH)
        return {"controller": old, "disposition": "RECOVER_OLD", "migration_id": slot[0],
                "phase": row[0], "quarantined": bool(slot[1])}
    finally:
        db.close()


class Migration:
    """Barrier and journal adapter around the existing trusted Engine/Host."""
    def __init__(self, journal, host, legacy_path, authority_epoch=EPOCH, clock=time.time,
                 allowed_request_id=None, allowed_digest=None):
        if authority_epoch != EPOCH:
            raise MigrationError("OUTER_AUTHORITY_EPOCH_IS_FIXED")
        self.journal, self.host = journal, host
        self.legacy_path, self.authority_epoch, self.clock = legacy_path, authority_epoch, clock
        self.allowed_request_id, self.allowed_digest = allowed_request_id, allowed_digest

    def _barrier(self):
        proof = _proof(self.host.quiescence_proof())
        ledger = legacy_snapshot(self.legacy_path, allowed_request_id=self.allowed_request_id, allowed_digest=self.allowed_digest)
        if proof["ledger_identity"] != ledger["identity"]:
            raise NotReady("HELD_BARRIER_DOES_NOT_IDENTIFY_THIS_LEDGER")
        if ledger["open_requests"] or ledger["undelivered_outbox"] or ledger["owned_targets"]:
            raise NotReady("LEGACY_REQUESTS_OUTBOX_OR_RECOVERY_STILL_PENDING")
        return proof, ledger

    def prepare(self, migration_id, request_digest, job):
        if (self.allowed_request_id is not None
                and (migration_id, request_digest) != (self.allowed_request_id, self.allowed_digest)):
            raise MigrationError("MIGRATION_DOES_NOT_MATCH_ACCEPTED_REQUEST")
        existing = self.journal.get(migration_id)
        if existing:
            if existing["request_digest"] != request_digest:
                raise MigrationError("MIGRATION_ID_REUSED")
            return existing
        if self.journal.active() is not None:
            raise NotReady("CONTROLLER_MIGRATION_ALREADY_OWNED_OR_QUARANTINED")
        old = self.host.snapshot(TARGET)
        old_controller = descriptor(old["controller"], self.authority_epoch)
        if old_controller["release"] != old["release"]:
            raise MigrationError("SNAPSHOT_CONTROLLER_RELEASE_MISMATCH")
        proof, ledger = self._barrier()
        new = descriptor(self.host.stage_controller(job), self.authority_epoch)
        request = job.get("request", job)
        operation = job.get("operation", request.get("operation"))
        if (operation in ("deploy.update_self", "deploy.migrate_registry", "deploy.test_recovery")
                and new["release"]["sha"] != request.get("sha")):
            raise MigrationError("STAGED_CONTROLLER_DOES_NOT_MATCH_ACCEPTED_SHA")
        report = self.host.check_candidate_controller(new)
        required = {"ok": True, "store_schema": 1, "engine_api": 1,
                    "legacy_preserved": True, "no_job_host_calls": 0}
        if (not isinstance(report, dict) or any(report.get(key) != value for key, value in required.items())
                or report.get("controller") != new):
            raise MigrationError("CANDIDATE_CONTROLLER_INTERFACE_PROBE_FAILED")
        attempt_id = uuid.uuid4().hex
        prepare_units = getattr(self.host, "prepare_unit_transition", None)
        units = unit_plan(prepare_units(new, attempt_id), old, attempt_id) if callable(prepare_units) else None
        final_proof, final_ledger = self._barrier()
        current = self.host.snapshot(TARGET)
        if (proof != final_proof or ledger != final_ledger
                or not _same(old, current, POINTER_KEYS + SERVICE_KEYS)):
            raise NotReady("STATE_CHANGED_DURING_CONTROLLER_STAGING")
        record = {"schema": 1, "attempt_id": attempt_id, "prepared_at": self.clock(),
                  "old_controller": old_controller, "new_controller": new, "old_snapshot": old,
                  "barrier": proof, "legacy_snapshot": ledger, "candidate_probe": report}
        if units is not None:
            record["unit_transition"] = units
        return self.journal.prepare(migration_id, request_digest, record)

    def before_activation(self, migration_id):
        entry = self.journal.get(migration_id)
        if not entry or entry["phase"] != "PREPARED":
            raise MigrationError("ACTIVATION_ALREADY_PREPARED_OR_INVALID")
        prepared = entry["record"]["prepared"]
        proof, ledger = self._barrier()
        current = self.host.observe(TARGET)
        if prepared.get("unit_transition"):
            proof_units = self._unit_proof(prepared, current)
            if (proof_units["state"] != "OLD" or proof_units["unit_map"] != prepared["unit_transition"]["old_unit_map"]
                    or proof_units.get("effective_unit_identity") != prepared["unit_transition"]["old_unit_identity"]):
                raise NotReady("CONTROLLER_UNITS_CHANGED_BEFORE_ACTIVATION")
        if (proof != prepared["barrier"] or ledger != prepared["legacy_snapshot"]
                or not _same(current, prepared["old_snapshot"], POINTER_KEYS + SERVICE_KEYS)):
            self.journal.advance(migration_id, "QUARANTINED", reason="PRE_ACTIVATION_BARRIER_OR_STATE_CHANGED")
            raise NotReady("PRE_ACTIVATION_BARRIER_OR_STATE_CHANGED")
        return self.journal.advance(migration_id, "ACTIVATE_PREPARED")

    def _unit_proof(self, prepared, current):
        plan = unit_plan(prepared["unit_transition"], prepared["old_snapshot"], prepared["attempt_id"])
        proof = self.host.unit_transition_proof(plan)
        if (not isinstance(proof, dict) or proof.get("verified") is not True
                or proof.get("state") not in ("OLD", "PARTIAL", "APPLIED", "RESTORED")
                or proof.get("plan_sha256") != plan["plan_sha256"]
                or proof.get("transition_id") != plan["transition_id"] or proof.get("attempt_id") != plan["attempt_id"]
                or proof.get("qualification_sha256") != plan["qualification_sha256"]
                or not isinstance(proof.get("unit_map"), dict)
                or proof.get("unit_map_identity") != digest(proof["unit_map"])
                or proof["unit_map_identity"] != current["unit_identity"]
                or not isinstance(proof.get("positions"), dict)
                or set(proof["positions"]) != set(plan["candidate_hashes"])
                or any(position not in ("OLD", "NEW", "RESTORED") for position in proof["positions"].values())):
            raise MigrationError("OWNED_CONTROLLER_UNIT_TRANSITION_NOT_PROVEN")
        for name, identity in proof["unit_map"].items():
            if identity not in (plan["old_unit_map"].get(name), plan["new_unit_map"].get(name)):
                raise MigrationError("CONTROLLER_UNIT_MAP_OUTSIDE_EXACT_PLAN")
        if not set(plan["old_unit_map"]) <= set(proof["unit_map"]) <= set(plan["new_unit_map"]):
            raise MigrationError("CONTROLLER_UNIT_MAP_OUTSIDE_EXACT_PLAN")
        if proof["state"] in ("APPLIED", "RESTORED"):
            expected = plan["new_unit_map"] if proof["state"] == "APPLIED" else plan["old_unit_map"]
            if proof.get("complete") is not True or proof["unit_map"] != expected:
                raise MigrationError("CONTROLLER_UNIT_COMPLETE_MAP_MISMATCH")
        return proof

    def classify_recovery(self, migration_id):
        entry = self.journal.get(migration_id)
        if not entry:
            raise MigrationError("MIGRATION_MISSING")
        if entry["phase"] == "QUARANTINED":
            return {"classification": "QUARANTINED"}
        prepared, record = entry["record"]["prepared"], entry["record"]
        current = self.host.observe(TARGET)
        old = prepared["old_snapshot"]
        units = self._unit_proof(prepared, current) if prepared.get("unit_transition") else None
        if entry["phase"] == "PREPARED" and (not _same(current, old, POINTER_KEYS)
                                               or units is not None and units["state"] != "OLD"):
            return self._quarantine(migration_id, "CONTROLLER_CHANGED_WITHOUT_ACTIVATION_INTENT")
        if units is None and current.get("unit_identity") != old.get("unit_identity"):
            return self._quarantine(migration_id, "CONTROLLER_UNIT_CHANGED")
        if _same(current, old, POINTER_KEYS):
            if entry["phase"] not in ("PREPARED", "ACTIVATE_PREPARED"):
                return self._quarantine(migration_id, "OLD_POINTER_RETURNED_OUTSIDE_RESTORE")
            if units is not None and entry["phase"] == "ACTIVATE_PREPARED" and units["state"] in ("PARTIAL", "APPLIED"):
                if not _same(current, old, PROCESS_KEYS):
                    return self._quarantine(migration_id, "CONTROLLER_PROCESS_CHANGED_DURING_UNIT_APPLY")
                return {"classification": "UNIT_TRANSITION_OWNED", "direction": "apply", "snapshot": current, "proof": units}
            if not _same(current, old, SERVICE_KEYS):
                return self._quarantine(migration_id, "OLD_CONTROLLER_SERVICE_CHANGED")
            return {"classification": "OLD_UNCHANGED", "snapshot": current}
        attempt = prepared["attempt_id"]
        if (current.get("controller") == prepared["new_controller"]
                and current.get("release") == prepared["new_controller"]["release"] and current.get("pointer_owner") == attempt):
            if units is not None and entry["phase"] == "RESTORE_PREPARED":
                if not _same(current, record["failed_snapshot"], PROCESS_KEYS):
                    return self._quarantine(migration_id, "CONTROLLER_PROCESS_CHANGED_DURING_UNIT_RESTORE")
                return {"classification": "UNIT_TRANSITION_OWNED", "direction": "restore", "snapshot": current, "proof": units}
            if units is not None and (units["state"] != "APPLIED" or units.get("effective_unit_identity") != prepared["unit_transition"]["new_unit_identity"]):
                return self._quarantine(migration_id, "NEW_POINTER_BEFORE_NEW_EFFECTIVE_UNITS")
            captured = record.get("new_snapshot")
            if captured and not _same(captured, current, POINTER_KEYS):
                return self._quarantine(migration_id, "CANDIDATE_POINTER_GENERATION_CHANGED")
            if entry["phase"] == "ACTIVATE_PREPARED":
                self.journal.advance(migration_id, "ACTIVATED", new_snapshot=current)
            return {"classification": "NEW_OWNED", "snapshot": current}
        if (current.get("controller") == prepared["old_controller"]
                and current.get("release") == old["release"] and current.get("pointer_owner") == attempt + ":rollback"
                and entry["phase"] in ("RESTORE_PREPARED", "RESTORED")):
            if units is not None and (units["state"] != "RESTORED" or units.get("effective_unit_identity") != prepared["unit_transition"]["old_unit_identity"]):
                return self._quarantine(migration_id, "OLD_POINTER_BEFORE_RESTORED_EFFECTIVE_UNITS")
            captured = record.get("restored_snapshot")
            if captured and not _same(captured, current, POINTER_KEYS):
                return self._quarantine(migration_id, "RESTORED_POINTER_GENERATION_CHANGED")
            if entry["phase"] == "RESTORE_PREPARED":
                self.journal.advance(migration_id, "RESTORED", restored_snapshot=current)
            return {"classification": "OLD_RESTORED", "snapshot": current}
        return self._quarantine(migration_id, "CONTROLLER_POINTER_OWNERSHIP_UNKNOWN")

    def _quarantine(self, migration_id, reason):
        entry = self.journal.get(migration_id)
        if entry["phase"] != "QUARANTINED":
            self.journal.advance(migration_id, "QUARANTINED", reason=reason)
        return {"classification": "QUARANTINED", "reason": reason}

    def _current_receipt(self, receipt, current, status, minimum):
        now = self.clock()
        observed = receipt.get("observed_at") if isinstance(receipt, dict) else None
        return (isinstance(receipt, dict) and receipt.get("status") == status and current.get("settled") is True
                and _same(receipt, current, SERVICE_KEYS + ("release",))
                and bool(current.get("invocation_id")) and type(current.get("pid")) is int and current["pid"] > 0
                and type(current.get("started_at")) in (int, float) and current["started_at"] > 0
                and isinstance(observed, (int, float)) and max(minimum, now - 10) <= observed <= now + 1)

    def restore_failed(self, migration_id, failure_kind="service"):
        """Only positive current-process failure permits restoring the old pointer.

        The existing updater subsequently restarts/verifies old and calls finish.
        A prepared restoration is never repeated following a timeout or crash.
        """
        entry = self.journal.get(migration_id)
        if not entry or entry["phase"] not in ("ACTIVATED", "VERIFYING"):
            raise MigrationError("RESTORE_ALREADY_PREPARED_OR_INVALID")
        prepared = entry["record"]["prepared"]
        classified = self.classify_recovery(migration_id)
        if classified["classification"] != "NEW_OWNED":
            raise MigrationError("FAILED_CANDIDATE_NOT_OWNED")
        current = classified["snapshot"]
        receipt = self.host.health(TARGET, current["release"], prepared["attempt_id"])
        interface_failure = None
        if failure_kind == "candidate_interface":
            interface_failure = self.host.check_candidate_controller(prepared["new_controller"])
            if (not isinstance(interface_failure, dict) or interface_failure.get("ok") is not False
                    or interface_failure.get("controller") != prepared["new_controller"]):
                return self._quarantine(migration_id, "POSITIVE_CANDIDATE_INTERFACE_FAILURE_NOT_PROVEN")
        elif failure_kind != "service":
            raise MigrationError("FIXED_ROLLBACK_FAILURE_KIND_REQUIRED")
        proof, ledger = self._barrier()
        after = self.host.observe(TARGET)
        if (proof != prepared["barrier"] or ledger != prepared["legacy_snapshot"]
                or not _same(current, after, POINTER_KEYS + SERVICE_KEYS)
                or current["invocation_id"] == prepared["old_snapshot"]["invocation_id"]
                or not self._current_receipt(receipt, current, "healthy" if interface_failure else "unhealthy", prepared["prepared_at"])):
            return self._quarantine(migration_id, "POSITIVE_FAILURE_OR_BARRIER_NOT_PROVEN")
        self.journal.advance(migration_id, "RESTORE_PREPARED", failed_snapshot=current, failure_receipt=receipt,
                             failure_kind=failure_kind, interface_failure=interface_failure)
        try:
            self.host.restore(TARGET, prepared["old_controller"], current,
                              current["unit_identity"], prepared["attempt_id"] + ":rollback")
        except Exception:
            return self._quarantine(migration_id, "RESTORE_OUTCOME_UNCERTAIN")
        return self.classify_recovery(migration_id)

    def finish(self, migration_id, restored=False):
        entry = self.journal.get(migration_id)
        if not entry or entry["phase"] not in (("RESTORED",) if restored else ("ACTIVATED", "VERIFYING")):
            raise MigrationError("MIGRATION_NOT_READY_TO_FINISH")
        prepared = entry["record"]["prepared"]
        classified = self.classify_recovery(migration_id)
        expected = "OLD_RESTORED" if restored else "NEW_OWNED"
        if classified["classification"] != expected:
            raise MigrationError("FINISH_POINTER_NOT_OWNED")
        current = classified["snapshot"]
        attempt = prepared["attempt_id"] + (":rollback" if restored else "")
        receipt = self.host.health(TARGET, current["release"], attempt)
        proof, ledger = self._barrier()
        after = self.host.observe(TARGET)
        baseline = entry["record"].get("failed_snapshot", prepared["old_snapshot"]) if restored else prepared["old_snapshot"]
        if (proof != prepared["barrier"] or ledger != prepared["legacy_snapshot"]
                or not _same(current, after, POINTER_KEYS + SERVICE_KEYS)
                or current["invocation_id"] == baseline["invocation_id"]
                or not self._current_receipt(receipt, current, "healthy", prepared["prepared_at"])):
            return self._quarantine(migration_id, "FRESH_HEALTH_OR_PRESERVED_LEDGER_NOT_PROVEN")
        return self.journal.advance(migration_id, "ROLLED_BACK" if restored else "COMMITTED", final_receipt=receipt)


def exercise_candidate(store_type, engine_type, self_check, legacy_store_type, workspace):
    """Exercise actual candidate interfaces using isolated, disposable fixtures.

    The pinned launcher supplies the old Store class; candidate modules are loaded
    only after the outer authority verified their exact package. Never point this
    helper at the real request database. No candidate self-report alone can pass.
    """
    class NoHost:
        calls = 0

        def __getattr__(self, name):
            self.calls += 1
            raise MigrationError("NO_JOB_ENGINE_CALLED_HOST")

    with tempfile.TemporaryDirectory(prefix="migration-fixture-", dir=workspace) as directory:
        empty_path = Path(directory) / "empty.sqlite"
        old = legacy_store_type(empty_path)
        old.close()
        before = legacy_snapshot(empty_path)
        candidate = store_type(empty_path)
        no_host = NoHost()
        try:
            check = self_check()
            if check != {"ok": True, "store_schema": 1, "engine_api": 1}:
                raise MigrationError("CANDIDATE_SELF_CHECK_CONTRACT_CHANGED")
            if engine_type(candidate, no_host).run_pending() != [] or no_host.calls:
                raise MigrationError("CANDIDATE_NO_JOB_ENGINE_FAILED")
        finally:
            candidate.close()
        if legacy_snapshot(empty_path) != before:
            raise MigrationError("CANDIDATE_NO_JOB_ENGINE_CHANGED_LEDGER")
        path = Path(directory) / "pending.sqlite"
        old = legacy_store_type(path)
        request = {"id": "fixture-pending", "operation": "deploy.update_self", "target": "worker", "sha": "a" * 40}
        old.accept("fixture-pending", "fixture-digest", "fixture-comment", request)
        old.prepare("fixture-pending", {"schema": 1, "old": {"release": {"sha": "b" * 40}}, "new": {"sha": "a" * 40}})
        old.prepare_command("fixture-pending", "activate", {"fixed_fixture": True})
        old.enqueue_outbox("fixture-result", "fixture-pending", "fixture body", "fixture-marker")
        old.outbox_uncertain("fixture-result")
        expected = {"job": old.get("fixture-pending"), "jobs": old.jobs(),
                    "command": old.command("fixture-pending", "activate"), "outbox": old.outbox_pending(),
                    "recovery": old.recovery_release("worker")}
        old.close()
        before = legacy_snapshot(path)
        candidate = store_type(path)
        try:
            actual = {"job": candidate.get("fixture-pending"), "jobs": candidate.jobs(),
                      "command": candidate.command("fixture-pending", "activate"), "outbox": candidate.outbox_pending(),
                      "recovery": candidate.recovery_release("worker")}
            if actual != expected:
                raise MigrationError("CANDIDATE_PENDING_V1_INTERFACES_CHANGED")
        finally:
            candidate.close()
        if legacy_snapshot(path) != before:
            raise MigrationError("CANDIDATE_REWROTE_PENDING_V1_LEDGER")
    return {"ok": True, "store_schema": 1, "engine_api": 1, "legacy_preserved": True, "no_job_host_calls": 0}
