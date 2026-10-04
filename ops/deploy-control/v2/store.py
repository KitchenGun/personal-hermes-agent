"""Durable schema-1 control ledger. Python 3.8+, standard library only.

The updater owns mutations; the request worker only admits requests and delivers
results. Nothing in this module deletes history or clears an uncertain target.
"""
import contextlib
import fcntl
import json
import os
import sqlite3
import stat
import time


TERMINAL = frozenset(("SUCCEEDED", "FAILED", "ROLLED_BACK", "UNKNOWN_OUTCOME",
                      "MANUAL_RECOVERY_REQUIRED", "BLOCKED"))
READ_ONLY = frozenset(("deploy.status", "deploy.health", "deploy.verify"))


class Conflict(RuntimeError):
    pass


class Busy(RuntimeError):
    pass


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


class Store:
    def __init__(self, path):
        self.path = os.path.abspath(os.fspath(path))
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1):
            raise Conflict("unsupported ledger schema")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS requests (
          request_id TEXT PRIMARY KEY, digest TEXT NOT NULL,
          comment_id TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL,
          target TEXT NOT NULL, operation TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'QUEUED', phase TEXT NOT NULL DEFAULT 'QUEUED',
          intent_json TEXT NOT NULL DEFAULT '{}', result_json TEXT,
          created_at REAL NOT NULL, updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS targets (
          target TEXT PRIMARY KEY, active_job TEXT, quarantined INTEGER NOT NULL DEFAULT 0,
          reason TEXT, updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS journal (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
          phase TEXT NOT NULL, details_json TEXT NOT NULL, recorded_at REAL NOT NULL,
          FOREIGN KEY(request_id) REFERENCES requests(request_id));
        CREATE TABLE IF NOT EXISTS commands (
          request_id TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL,
          intent_json TEXT NOT NULL, result_json TEXT, prepared_at REAL NOT NULL,
          completed_at REAL, PRIMARY KEY(request_id,name),
          FOREIGN KEY(request_id) REFERENCES requests(request_id));
        CREATE TABLE IF NOT EXISTS outbox (
          item_key TEXT PRIMARY KEY, request_id TEXT NOT NULL, body TEXT NOT NULL,
          marker TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'PENDING',
          comment_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
          FOREIGN KEY(request_id) REFERENCES requests(request_id));
        PRAGMA user_version=1;
        """)
        directory = os.open(os.path.dirname(self.path), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

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

    @contextlib.contextmanager
    def engine_lock(self):
        """Process lock, deliberately independent of the worker's lifetime."""
        descriptor = os.open(self.path + ".updater.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "a+b") as lock:
            identity = os.fstat(lock.fileno())
            if (not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid()
                    or identity.st_nlink != 1 or identity.st_mode & 0o022):
                raise Conflict("updater lock identity refused")
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Busy("another updater is running")
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _job(row):
        if row is None:
            return None
        job = dict(row)
        for source, destination in (("request_json", "request"), ("intent_json", "intent"),
                                    ("result_json", "result")):
            value = job.pop(source)
            job[destination] = json.loads(value) if value is not None else None
        return job

    def get(self, request_id):
        return self._job(self.db.execute("SELECT * FROM requests WHERE request_id=?", (request_id,)).fetchone())

    def accept(self, request_id, digest, comment_id, request):
        """Admit a guard-normalized request. Replays must match all three IDs."""
        comment_id = str(comment_id)
        target, operation = request["target"], request["operation"]
        now = time.time()
        with self.transaction():
            row = self.db.execute("SELECT * FROM requests WHERE request_id=? OR comment_id=?",
                                  (request_id, comment_id)).fetchone()
            if row:
                if (row["request_id"], row["digest"], row["comment_id"], row["request_json"]) != (request_id, digest, comment_id, encode(request)):
                    raise Conflict("request ID, digest, or source comment was reused with different content")
                return self._job(row), False
            target_row = self.db.execute("SELECT * FROM targets WHERE target=?", (target,)).fetchone()
            if operation not in READ_ONLY and target_row and target_row["quarantined"]:
                raise Conflict("target is quarantined; a new request ID cannot bypass recovery")
            self.db.execute("INSERT INTO requests(request_id,digest,comment_id,request_json,target,operation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                            (request_id, digest, comment_id, encode(request), target, operation, now, now))
            self._journal(request_id, "QUEUED", {"owner": "updater"}, now)
        return self.get(request_id), True

    def jobs(self, include_terminal=False):
        rows = self.db.execute("SELECT * FROM requests ORDER BY created_at,request_id").fetchall()
        return [self._job(row) for row in rows if include_terminal or row["state"] not in TERMINAL]

    def _journal(self, request_id, phase, details, now):
        self.db.execute("INSERT INTO journal(request_id,phase,details_json,recorded_at) VALUES(?,?,?,?)",
                        (request_id, phase, encode(details), now))

    def prepare(self, request_id, intent):
        """Claim a fixed target and fsync old/new identities before side effects."""
        now = time.time()
        with self.transaction():
            job = self.get(request_id)
            if not job or job["state"] != "QUEUED":
                raise Conflict("request is not queued")
            target = self.db.execute("SELECT * FROM targets WHERE target=?", (job["target"],)).fetchone()
            if target and (target["quarantined"] or target["active_job"] not in (None, request_id)):
                raise Busy("target is owned by another operation or quarantined")
            self.db.execute("INSERT INTO targets(target,active_job,updated_at) VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET active_job=excluded.active_job,updated_at=excluded.updated_at",
                            (job["target"], request_id, now))
            self.db.execute("UPDATE requests SET state='RUNNING',phase='PREPARED',intent_json=?,updated_at=? WHERE request_id=?",
                            (encode(intent), now, request_id))
            self._journal(request_id, "PREPARED", intent, now)
        return self.get(request_id)

    def set_phase(self, request_id, phase, **fields):
        now = time.time()
        with self.transaction():
            job = self.get(request_id)
            if not job or job["state"] in TERMINAL:
                raise Conflict("cannot change a terminal or missing request")
            intent = dict(job["intent"])
            intent.update(fields)
            self.db.execute("UPDATE requests SET phase=?,intent_json=?,updated_at=? WHERE request_id=?",
                            (phase, encode(intent), now, request_id))
            self._journal(request_id, phase, fields, now)
        return self.get(request_id)

    def command(self, request_id, name):
        row = self.db.execute("SELECT * FROM commands WHERE request_id=? AND name=?", (request_id, name)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["intent"] = json.loads(result.pop("intent_json"))
        raw = result.pop("result_json")
        result["result"] = json.loads(raw) if raw is not None else None
        return result

    def prepare_command(self, request_id, name, intent):
        now = time.time()
        with self.transaction():
            existing = self.command(request_id, name)
            if existing:
                if existing["intent"] != intent:
                    raise Conflict("command intent changed")
                return False
            self.db.execute("INSERT INTO commands(request_id,name,state,intent_json,prepared_at) VALUES(?,?,'PREPARED',?,?)",
                            (request_id, name, encode(intent), now))
            self._journal(request_id, "COMMAND_PREPARED", {"name": name, "intent": intent}, now)
        return True

    def complete_command(self, request_id, name, result=None):
        now = time.time()
        with self.transaction():
            command = self.command(request_id, name)
            if not command:
                raise Conflict("command has no prepared intent")
            if command["state"] == "COMPLETED":
                if command["result"] != result:
                    raise Conflict("command result changed")
                return
            self.db.execute("UPDATE commands SET state='COMPLETED',result_json=?,completed_at=? WHERE request_id=? AND name=?",
                            (encode(result), now, request_id, name))
            self._journal(request_id, "COMMAND_COMPLETED", {"name": name, "result": result}, now)

    def finish(self, request_id, status, result):
        if status not in TERMINAL:
            raise ValueError("invalid terminal status")
        now = time.time()
        with self.transaction():
            job = self.get(request_id)
            if not job:
                raise Conflict("missing request")
            if job["state"] in TERMINAL:
                if job["state"] != status or job["result"] != result:
                    raise Conflict("terminal result is immutable")
                return job
            self.db.execute("UPDATE requests SET state=?,phase=?,result_json=?,updated_at=? WHERE request_id=?",
                            (status, status, encode(result), now, request_id))
            self._journal(request_id, status, result, now)
            self.db.execute("UPDATE targets SET active_job=NULL,updated_at=? WHERE target=? AND active_job=? AND quarantined=0",
                            (now, job["target"], request_id))
        return self.get(request_id)

    def quarantine(self, target, request_id, reason):
        now = time.time()
        with self.transaction():
            row = self.db.execute("SELECT * FROM targets WHERE target=?", (target,)).fetchone()
            if row and row["active_job"] not in (None, request_id):
                raise Conflict("cannot quarantine another operation's target")
            self.db.execute("INSERT INTO targets(target,active_job,quarantined,reason,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(target) DO UPDATE SET active_job=excluded.active_job,quarantined=1,reason=excluded.reason,updated_at=excluded.updated_at",
                            (target, request_id, reason, now))
            self._journal(request_id, "TARGET_QUARANTINED", {"target": target, "reason": reason}, now)

    def target_state(self, target):
        row = self.db.execute("SELECT * FROM targets WHERE target=?", (target,)).fetchone()
        return dict(row) if row else {"target": target, "active_job": None, "quarantined": 0, "reason": None}

    def recovery_release(self, target="worker"):
        """Bootstrap launcher must use this retained updater after an interruption."""
        target_row = self.target_state(target)
        job = self.get(target_row["active_job"]) if target_row["active_job"] else None
        return job["intent"].get("old", {}).get("release") if job else None

    def enqueue_outbox(self, key, request_id, body, marker):
        now = time.time()
        with self.transaction():
            row = self.db.execute("SELECT * FROM outbox WHERE item_key=? OR marker=?", (key, marker)).fetchone()
            if row:
                if (row["item_key"], row["request_id"], row["body"], row["marker"]) != (key, request_id, body, marker):
                    raise Conflict("outbox identity reused with different content")
                return dict(row)
            self.db.execute("INSERT INTO outbox(item_key,request_id,body,marker,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                            (key, request_id, body, marker, now, now))
        return self.outbox_item(key)

    def outbox_item(self, key):
        row = self.db.execute("SELECT * FROM outbox WHERE item_key=?", (key,)).fetchone()
        return dict(row) if row else None

    def outbox_pending(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM outbox WHERE state!='DELIVERED' ORDER BY created_at,item_key")]

    def outbox_uncertain(self, key):
        """Commit BEFORE HTTP POST. A crash is reconciled by marker, never reposted."""
        with self.transaction():
            row = self.outbox_item(key)
            if not row or row["state"] != "PENDING":
                raise Conflict("only a pending result may begin posting")
            self.db.execute("UPDATE outbox SET state='UNCERTAIN',updated_at=? WHERE item_key=?", (time.time(), key))

    def outbox_delivered(self, key, comment_id):
        with self.transaction():
            row = self.outbox_item(key)
            if not row or row["state"] == "PENDING":
                raise Conflict("result was not marked uncertain before posting")
            if row["state"] == "DELIVERED" and row["comment_id"] != str(comment_id):
                raise Conflict("outbox already reconciled to a different comment")
            self.db.execute("UPDATE outbox SET state='DELIVERED',comment_id=?,updated_at=? WHERE item_key=?",
                            (str(comment_id), time.time(), key))
