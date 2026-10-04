"""Qualified Linux unit-file transitions, with no systemctl or enablement calls.

The outer fixed-target unit envelope supplies the entire trusted mapping and
prevalidates candidate template bytes. Requests cannot supply paths or roles.
Each unit spec is {name,path,role,old,allow_absent,new_mode}; old is the exact
read-only inspect_unit() identity, or null for an explicitly qualified new unit.
An absent unit additionally requires new_owner:{uid,gid} from qualification.
Mapping = {target,qualification_sha256,units:{role:spec}}. Context pins controller
and registry epochs/digests. Pass unchanged units too when a complete target's
canonical map identity is needed. ACL/xattr-bearing units are refused rather
than silently losing metadata. Existing mode/UID/GID are never changed.
Retained unit bytes may include existing inline configuration: backups stay in
0700 transaction directories with 0400 files on the qualified private host.
They are not publication artifacts and must never be exported with reports.
The outer unit envelope must reject new credentials/environment expansion.

begin(id, candidate_bytes_by_role), apply_one(id), restore_one(id) are durable,
bounded mutations. observe(id) is read-only and computes identity only for a
fully verified map. A recorded local replacement may resume only when exact
old or controller-owned new inode/hash/metadata proves its outcome. UNKNOWN
never authorizes overwrite. The qualified host owns separate prepared-command
journals for daemon reload, service stop/start and watcher coordination.
"""
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid


ROLES = {"HERMES_API": {"api", "relay", "watchdog_service", "watchdog_timer"},
         "HERMES_DISCORD_RELAY": {"api", "relay", "watchdog_service", "watchdog_timer"},
         "KIS": {"api", "relay", "watchdog_service", "watchdog_timer"},
         "DEPLOY_WORKER": {"worker", "updater", "recovery_timer"}}
CONTEXT_KEYS = {"controller_epoch", "controller_sha256", "registry_epoch", "registry_sha256"}
MAX_UNIT = 64 * 1024
REASON_CODES = frozenset("""
UNIT_DIRECTORY_UNQUALIFIED UNIT_FILE_METADATA_UNQUALIFIED UNIT_CHANGED_DURING_READ UNIT_JOURNAL_BOUND
ATOMIC_NEW_UNIT_PUBLICATION_UNAVAILABLE NEW_UNIT_APPEARED_OUTSIDE_ATTEMPT UNIT_CONTEXT_UNQUALIFIED
UNIT_TARGET_UNQUALIFIED UNIT_ROLES_UNQUALIFIED UNIT_SPEC_UNQUALIFIED UNIT_PATH_UNQUALIFIED
UNIT_MODE_UNQUALIFIED NEW_UNIT_NOT_EXPLICITLY_QUALIFIED EXISTING_UNIT_MODE_OR_OWNER_CHANGE_REFUSED
UNIT_TRANSITION_ID_INVALID DUPLICATE_UNIT_JOURNAL_FIELD UNIT_TRANSITION_CONTEXT_CHANGED
EXACT_REVIEWED_UNIT_BYTES_REQUIRED UNIT_TRANSITION_ID_REUSED QUALIFIED_OLD_UNIT_CHANGED
UNIT_CHANGED_OUTSIDE_TRANSITION REMOVED_UNIT_OWNERSHIP_NOT_PROVEN RETAINED_UNIT_BYTES_CHANGED
UNIT_OWNER_OR_MODE_WOULD_CHANGE UNIT_MAP_CHANGED_BEFORE_REPLACE REMOVED_UNIT_OWNERSHIP_CHANGED
UNIT_TEMPORARY_CHANGED UNIT_CAS_FAILED UNIT_RESTORE_CANNOT_BECOME_APPLY UNIT_MAP_NOT_OWNED
UNIT_OPERATION_FAILED UNIT_PLAN_INCOMPLETE UNIT_PLAN_CHANGED NEW_UNIT_OWNER_UNQUALIFIED
""".split())


class Refused(RuntimeError):
    pass


def _encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _digest(value):
    return hashlib.sha256(_encode(value)).hexdigest()


def _directory(path):
    path = Path(path)
    value = path.lstat()
    if (not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid() or value.st_mode & 0o022
            or not path.is_absolute() or path.resolve() != path):
        raise Refused("UNIT_DIRECTORY_UNQUALIFIED")
    return path


def _read(path, maximum=MAX_UNIT):
    path = Path(path)
    _directory(path.parent)
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or before.st_nlink != 1 or before.st_mode & 0o7022 or before.st_size > maximum
                or os.listxattr(stream.fileno())):
            raise Refused("UNIT_FILE_METADATA_UNQUALIFIED")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    if (len(raw) > maximum or (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
        raise Refused("UNIT_CHANGED_DURING_READ")
    return raw, {"sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw),
                 "mode": stat.S_IMODE(after.st_mode), "uid": after.st_uid, "gid": after.st_gid,
                 "inode": after.st_ino, "device": after.st_dev, "mtime_ns": after.st_mtime_ns}


def inspect_unit(path):
    """Fresh bounded read for an already-qualified unit path; never mutates."""
    try:
        return _read(path)[1]
    except FileNotFoundError:
        # A missing ancestor is not evidence of a qualified absent file.
        _directory(Path(path).parent)
        return None


def _canonical(identity):
    return None if identity is None else {key: identity[key] for key in ("sha256", "size", "mode", "uid", "gid")}


def _sync(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _exclusive(path, raw, mode, owner=None):
    # Keep bytes private until inherited ownership has been checked. A group
    # mismatch must not expose an old inline value through a temporary file.
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        facts = os.fstat(stream.fileno())
        if owner is not None and (facts.st_uid, facts.st_gid) != owner:
            raise Refused("UNIT_OWNER_OR_MODE_WOULD_CHANGE")
        stream.write(raw)
        stream.flush()
        # Only the new private temporary inode receives its preserved mode.
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())


def _atomic(path, value):
    raw = _encode(value)
    if len(raw) > 1024 * 1024:
        raise Refused("UNIT_JOURNAL_BOUND")
    temporary = path.parent / (".journal-" + uuid.uuid4().hex)
    _exclusive(temporary, raw, 0o600)
    os.replace(str(temporary), str(path))
    _sync(path.parent)


def _rename_absent(source, destination):
    """Linux RENAME_NOREPLACE: an absent-unit publish must never clobber a race."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise Refused("ATOMIC_NEW_UNIT_PUBLICATION_UNAVAILABLE")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise Refused("NEW_UNIT_APPEARED_OUTSIDE_ATTEMPT")
        raise OSError(error, "atomic unit publication failed")


class UnitTransition:
    def __init__(self, journal_dir, qualified_mapping, context, crash_hook=None):
        self.root = _directory(Path(journal_dir))
        self.mapping = json.loads(_encode(qualified_mapping))
        self.context = json.loads(_encode(context))
        self.crash_hook = crash_hook or (lambda point: None)
        if (set(self.context) != CONTEXT_KEYS or any(not isinstance(value, str) or not value for value in self.context.values())
                or any(not re.fullmatch("[0-9a-f]{64}", self.context[key]) for key in ("controller_sha256", "registry_sha256"))):
            raise Refused("UNIT_CONTEXT_UNQUALIFIED")
        if (set(self.mapping) != {"target", "qualification_sha256", "units"}
                or self.mapping["target"] not in ROLES
                or not isinstance(self.mapping["qualification_sha256"], str)
                or not re.fullmatch("[0-9a-f]{64}", self.mapping["qualification_sha256"])):
            raise Refused("UNIT_TARGET_UNQUALIFIED")
        units = self.mapping["units"]
        if not isinstance(units, dict) or not 1 <= len(units) <= 8 or not set(units) <= ROLES[self.mapping["target"]]:
            raise Refused("UNIT_ROLES_UNQUALIFIED")
        names, paths = set(), set()
        for role, spec in units.items():
            required = {"name", "path", "role", "old", "allow_absent", "new_mode"}
            if (not isinstance(spec, dict) or not required <= set(spec) <= required | {"new_owner"}
                    or spec["role"] != role or not isinstance(spec["name"], str)
                    or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,96}\.(?:service|timer)", spec["name"])
                    or "phone" in spec["name"].lower() or type(spec["allow_absent"]) is not bool):
                raise Refused("UNIT_SPEC_UNQUALIFIED")
            path = Path(spec["path"])
            if (not path.is_absolute() or path.name != spec["name"] or path.resolve() != path
                    or path in paths or spec["name"] in names or self.root == path or self.root in path.parents):
                raise Refused("UNIT_PATH_UNQUALIFIED")
            _directory(path.parent)
            names.add(spec["name"])
            paths.add(path)
            if type(spec["new_mode"]) is not int or spec["new_mode"] not in (0o600, 0o640, 0o644):
                raise Refused("UNIT_MODE_UNQUALIFIED")
            if spec["old"] is None:
                if not spec["allow_absent"] or spec["new_mode"] != 0o600:
                    raise Refused("NEW_UNIT_NOT_EXPLICITLY_QUALIFIED")
                owner = spec.get("new_owner")
                if (not isinstance(owner, dict) or set(owner) != {"uid", "gid"}
                        or type(owner["uid"]) is not int or owner["uid"] != os.getuid()
                        or type(owner["gid"]) is not int or owner["gid"] < 0):
                    raise Refused("NEW_UNIT_OWNER_UNQUALIFIED")
            elif (not isinstance(spec["old"], dict) or spec["old"].get("mode") != spec["new_mode"]
                  or spec["old"].get("uid") != os.getuid()):
                raise Refused("EXISTING_UNIT_MODE_OR_OWNER_CHANGE_REFUSED")

    @contextlib.contextmanager
    def coordination_lock(self):
        descriptor = os.open(str(self.root / ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(descriptor)

    def _path(self, transition_id):
        if not isinstance(transition_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", transition_id):
            raise Refused("UNIT_TRANSITION_ID_INVALID")
        return self.root / transition_id

    def _load(self, transition_id):
        path = _directory(self._path(transition_id))
        raw, _ = _read(path / "journal.json", 1024 * 1024)
        def strict(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise Refused("DUPLICATE_UNIT_JOURNAL_FIELD")
                result[key] = value
            return result
        journal = json.loads(raw, object_pairs_hook=strict)
        if (journal.get("schema") != 1 or journal.get("context") != self.context
                or journal.get("mapping") != self.mapping or journal.get("id") != transition_id):
            raise Refused("UNIT_TRANSITION_CONTEXT_CHANGED")
        return journal

    def _save(self, journal):
        _atomic(self._path(journal["id"]) / "journal.json", journal)

    def begin(self, transition_id, candidates, attempt_id=None):
        if (not isinstance(candidates, dict) or set(candidates) != set(self.mapping["units"])
                or any(type(raw) is not bytes or not 0 < len(raw) <= MAX_UNIT for raw in candidates.values())):
            raise Refused("EXACT_REVIEWED_UNIT_BYTES_REQUIRED")
        if attempt_id is not None and (not isinstance(attempt_id, str) or not re.fullmatch("[0-9a-f]{32}", attempt_id)):
            raise Refused("UNIT_TRANSITION_ID_INVALID")
        with self.coordination_lock():
            path = self._path(transition_id)
            expected = {role: hashlib.sha256(raw).hexdigest() for role, raw in candidates.items()}
            if path.exists():
                journal = self._load(transition_id)
                if journal["candidate_hashes"] != expected or (attempt_id is not None and journal["attempt_id"] != attempt_id):
                    raise Refused("UNIT_TRANSITION_ID_REUSED")
                return self._observe(journal)
            for role, spec in self.mapping["units"].items():
                if inspect_unit(spec["path"]) != spec["old"]:
                    raise Refused("QUALIFIED_OLD_UNIT_CHANGED")
            path.mkdir(mode=0o700)
            _sync(self.root)
            journal = {"schema": 1, "id": transition_id, "attempt_id": attempt_id or uuid.uuid4().hex,
                       "mapping": self.mapping, "context": self.context, "candidate_hashes": expected,
                       "direction": "apply", "state": "PREPARING", "units": {}}
            self._save(journal)
            for index, role in enumerate(sorted(candidates)):
                spec = self.mapping["units"][role]
                if spec["old"] is not None:
                    old, actual = _read(spec["path"])
                    if actual != spec["old"]:
                        raise Refused("QUALIFIED_OLD_UNIT_CHANGED")
                    _exclusive(path / (str(index) + ".old"), old, 0o400)
                _exclusive(path / (str(index) + ".new"), candidates[role], 0o400)
                journal["units"][role] = {"index": index, "state": "OLD", "old": spec["old"], "path": spec["path"], "new_sha256": expected[role]}
                self._save(journal)
            _sync(path)
            journal["state"] = "ACTIVE"
            self._save(journal)
            return self._observe(journal)

    def _observe(self, journal):
        verified, positions = {}, {}
        if journal["state"] in ("PREPARING", "UNKNOWN") or set(journal["units"]) != set(self.mapping["units"]):
            return {"state": "UNKNOWN", "complete": False, "unit_map_identity": None, "positions": {}}
        try:
            for role, item in journal["units"].items():
                actual = inspect_unit(item["path"])
                state = item["state"]
                allowed = [item["old"]] if state == "OLD" else [item["new"]] if state == "NEW" else [item["restored"]] if state == "RESTORED" else [item["before"], item["replacement"]]
                if actual not in allowed:
                    raise Refused("UNIT_CHANGED_OUTSIDE_TRANSITION")
                if state == "REMOVING" and actual is None and inspect_unit(item["temporary"]) != item["before"]:
                    raise Refused("REMOVED_UNIT_OWNERSHIP_NOT_PROVEN")
                if state in ("APPLYING", "RESTORING", "REMOVING"):
                    position = ("RESTORED" if journal["direction"] == "restore" else "NEW") if actual == item["replacement"] else ("NEW" if journal["direction"] == "restore" else "OLD")
                else:
                    position = state
                positions[role] = position
                if actual is not None:
                    verified[self.mapping["units"][role]["name"]] = _canonical(actual)
        except (OSError, Refused, KeyError, TypeError):
            return {"state": "UNKNOWN", "complete": False, "unit_map_identity": None, "positions": positions}
        desired = "RESTORED" if journal["direction"] == "restore" else "NEW"
        complete = all(position == desired for position in positions.values())
        state = "RESTORED" if complete and desired == "RESTORED" else "APPLIED" if complete else "OLD" if set(positions.values()) == {"OLD"} else "PARTIAL"
        return {"state": state, "complete": complete, "unit_map_identity": _digest(verified),
                "unit_map": verified, "positions": positions, "attempt_id": journal["attempt_id"],
                "qualification_sha256": self.mapping["qualification_sha256"]}

    def observe(self, transition_id):
        return self._observe(self._load(transition_id))

    def _plan(self, journal):
        if set(journal["units"]) != set(self.mapping["units"]):
            raise Refused("UNIT_PLAN_INCOMPLETE")
        old_map, new_map = {}, {}
        for role, item in journal["units"].items():
            spec = self.mapping["units"][role]
            base = self._path(journal["id"])
            new_raw, _ = _read(base / (str(item["index"]) + ".new"))
            if hashlib.sha256(new_raw).hexdigest() != journal["candidate_hashes"][role]:
                raise Refused("RETAINED_UNIT_BYTES_CHANGED")
            if item["old"] is not None:
                old_raw, _ = _read(base / (str(item["index"]) + ".old"))
                if hashlib.sha256(old_raw).hexdigest() != item["old"]["sha256"]:
                    raise Refused("RETAINED_UNIT_BYTES_CHANGED")
                old_map[spec["name"]] = _canonical(item["old"])
                owner = {key: item["old"][key] for key in ("uid", "gid")}
            else:
                owner = spec["new_owner"]
            new_map[spec["name"]] = dict(owner, mode=spec["new_mode"], size=len(new_raw), sha256=journal["candidate_hashes"][role])
        plan = {"schema": 1, "transition_id": journal["id"], "attempt_id": journal["attempt_id"],
                "target": self.mapping["target"], "qualification_sha256": self.mapping["qualification_sha256"],
                "context_sha256": _digest(self.context), "mapping_sha256": _digest(self.mapping),
                "candidate_hashes": journal["candidate_hashes"], "old_unit_map": old_map, "new_unit_map": new_map,
                "old_unit_identity": _digest(old_map), "new_unit_identity": _digest(new_map)}
        plan["plan_sha256"] = _digest(plan)
        return plan

    def prepare_plan(self, transition_id, candidates, attempt_id=None):
        """Retain reviewed bytes, then bind this immutable plan into migration intent.

        No live unit path changes here. The plan never substitutes for a fresh
        proof; its old/new hashes alone do not authorize a changed observation.
        """
        self.begin(transition_id, candidates, attempt_id=attempt_id)
        with self.coordination_lock():
            journal = self._load(transition_id)
            if self._observe(journal)["state"] == "UNKNOWN":
                raise Refused("UNIT_MAP_NOT_OWNED")
            return self._plan(journal)

    def proof(self, transition_id, expected_plan):
        """Read-only fresh file ownership proof bound to exact migration intent.

        APPLIED+complete with new_unit_identity permits the host's separately
        journaled reload step. RESTORED+complete with old_unit_identity permits
        rollback reload. PARTIAL is recovery evidence only. None of these
        states proves that systemd has loaded the files or a service is healthy.
        """
        journal = self._load(transition_id)
        plan = self._plan(journal)
        if expected_plan != plan:
            raise Refused("UNIT_PLAN_CHANGED")
        result = self._observe(journal)
        result.update(plan_sha256=plan["plan_sha256"], transition_id=transition_id,
                      verified=result["state"] != "UNKNOWN")
        if result["complete"]:
            wanted = plan["old_unit_identity"] if result["state"] == "RESTORED" else plan["new_unit_identity"]
            if result["unit_map_identity"] != wanted:
                raise Refused("UNIT_PLAN_CHANGED")
        return result

    def _unknown(self, journal, reason):
        reason = reason if reason in REASON_CODES else "UNIT_OPERATION_FAILED"
        journal["state"], journal["reason"] = "UNKNOWN", reason
        self._save(journal)
        result = self._observe(journal)
        result["reason"] = reason
        return result

    def _replace_one(self, journal, role, restore):
        item = journal["units"][role]
        spec = self.mapping["units"][role]
        destination = Path(item["path"])
        desired = "RESTORED" if restore else "NEW"
        if item["state"] not in ("APPLYING", "RESTORING", "REMOVING"):
            before = item["new"] if restore else item["old"]
            if restore and item["old"] is None:
                # Retain the exact created inode under a private non-unit name.
                # No unrelated or irrecoverable file deletion is necessary.
                temporary = destination.parent / (".deploy-unit-" + journal["attempt_id"] + "-" + str(item["index"]) + "-removed")
                item.update(state="REMOVING", before=before, replacement=None, temporary=str(temporary))
            else:
                suffix = "old" if restore else "new"
                raw, _ = _read(self._path(journal["id"]) / (str(item["index"]) + "." + suffix))
                expected = item["old"]["sha256"] if restore else item["new_sha256"]
                if hashlib.sha256(raw).hexdigest() != expected:
                    raise Refused("RETAINED_UNIT_BYTES_CHANGED")
                temporary = destination.parent / (".deploy-unit-" + journal["attempt_id"] + "-" + str(item["index"]) + "-" + suffix)
                owner_facts = item["old"] if item["old"] is not None else spec["new_owner"]
                owner = (owner_facts["uid"], owner_facts["gid"])
                _exclusive(temporary, raw, spec["new_mode"], owner=owner)
                _sync(destination.parent)
                replacement = inspect_unit(temporary)
                if item["old"] is not None and any(replacement[key] != item["old"][key] for key in ("uid", "gid", "mode")):
                    raise Refused("UNIT_OWNER_OR_MODE_WOULD_CHANGE")
                item.update(state="RESTORING" if restore else "APPLYING", before=before,
                            replacement=replacement, temporary=str(temporary))
            self._save(journal)
            self.crash_hook("before_unit_replace")
        observed = self._observe(journal)
        if observed["state"] == "UNKNOWN":
            raise Refused("UNIT_MAP_CHANGED_BEFORE_REPLACE")
        actual = inspect_unit(destination)
        if actual == item["before"]:
            if item["replacement"] is None:
                _rename_absent(destination, item["temporary"])
                if inspect_unit(item["temporary"]) != item["before"]:
                    raise Refused("REMOVED_UNIT_OWNERSHIP_CHANGED")
            else:
                if inspect_unit(item["temporary"]) != item["replacement"]:
                    raise Refused("UNIT_TEMPORARY_CHANGED")
                if item["before"] is None:
                    _rename_absent(item["temporary"], destination)
                else:
                    # The host's qualified lease excludes other writers; the
                    # final exact identity check also detects operator drift.
                    if inspect_unit(destination) != item["before"]:
                        raise Refused("UNIT_CAS_FAILED")
                    os.replace(item["temporary"], str(destination))
            _sync(destination.parent)
            self.crash_hook("after_unit_replace")
        elif actual != item["replacement"]:
            raise Refused("UNIT_CAS_FAILED")
        item["restored" if restore else "new"] = item["replacement"]
        item["state"] = desired
        self._save(journal)

    def _advance(self, transition_id, restore):
        with self.coordination_lock():
            journal = self._load(transition_id)
            observation = self._observe(journal)
            if observation["state"] == "UNKNOWN":
                return self._unknown(journal, "UNIT_MAP_NOT_OWNED")
            if not restore and journal["direction"] != "apply":
                raise Refused("UNIT_RESTORE_CANNOT_BECOME_APPLY")
            try:
                if restore and journal["direction"] != "restore":
                    # Reconcile an interrupted publication from exact identity;
                    # no pending unknown external command is retried here.
                    for role, position in observation["positions"].items():
                        item = journal["units"][role]
                        if position == "NEW":
                            item["new"] = inspect_unit(item["path"])
                            item["state"] = "NEW"
                        else:
                            item["state"] = "OLD"
                    journal["direction"] = "restore"
                    self._save(journal)
                for role in sorted(journal["units"]):
                    item = journal["units"][role]
                    if item["state"] == ("RESTORED" if restore else "NEW"):
                        continue
                    if restore and item["state"] == "OLD":
                        item["restored"], item["state"] = item["old"], "RESTORED"
                        self._save(journal)
                    else:
                        self._replace_one(journal, role, restore)
                    break
                return self._observe(journal)
            except Exception as error:
                return self._unknown(journal, str(error) if type(error) is Refused else "UNIT_OPERATION_FAILED")

    def apply_one(self, transition_id):
        return self._advance(transition_id, False)

    def restore_one(self, transition_id):
        return self._advance(transition_id, True)
