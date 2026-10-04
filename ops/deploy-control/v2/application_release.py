"""Held application releases over a separately qualified, fixed host adapter.

This module contains no service names, VM destinations, shell commands, drain
API, trading resume, or broker calls. It is not a VM qualification or adapter.

Host contract (all observations independent of the caller's desired state):
  qualify(request) -> {binding, files}; files are exact-SHA verified bytes, keyed
    by the binding's fixed logical source names. validate_binding(binding) must
    recheck the approved registry, units, selectors, layout and old/new hold
    compatibility. An absent/unqualified adapter fails closed.
  observe(binding) -> fresh snapshot: binding_id, unit_identity,
    selector_identity, lease_owner (approved request ID), operator_generation,
    observed_at, services, watchers, hold, ingress_excluded, quiescence,
    preserved_identity and effect_receipts. Service facts include state,
    settled, invocation_id, pid and started_at. Watcher facts include active,
    enabled and settled. Quiescence is independently observed, never inferred
    from a successful pause request or from empty process-name matches alone.
    preserved_identity binds the qualified protected-state semantics: bounded
    hold/history/model/order-flag and DB inode/schema/idempotency audit facts.
    It must not require hashing a live database or all incidental state-file
    metadata on every poll. The qualified field contract excludes legitimate
    noncritical startup metadata and never returns account rows or secrets.
  suspend_watchers / enter_hold / exclude_ingress / stop_services / start_held /
    restore_watchers(binding, expected_snapshot, attempt_id, effect_id, details)
    perform ONLY qualified actions with approved-job-lease and snapshot CAS.
    The host durably reports {attempt_id,effect_id,complete:true} under that
    effect_id in subsequent observations, even when its caller times out.
    Watcher suspension covers BOTH timer and an already-running oneshot and
    preserves persistent enablement. enter_hold uses the existing exact reason.
  health(binding, snapshot, attempt_id, release_identity) -> fresh receipt with
    status, attempt_id, release_identity, services, preserved_identity,
    held:true, scheduler_count:1, tasks_registered:true, compatibility:true,
    observed_at. Positive failure must identify the actual new invocation.

The fixed transactions directory is selected by registry/bootstrap, not by a
request. All three application targets share its durable lease. Controller or
registry migration must refuse while has_active() is true. Same-UID locks are
coordination, not a security boundary against hostile same-user code.
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
import time
import uuid


TARGETS = frozenset(("HERMES_API", "HERMES_DISCORD_RELAY", "KIS"))
HOLD_REASON = "operator_prod_transition_preparation"
CONTEXT_KEYS = {"controller_epoch", "controller_sha256", "registry_epoch", "registry_sha256"}
QUIET_KEYS = {"pending_recovery", "node_work", "python_work", "active_runs", "writer_locks", "other_work"}
TERMINAL = frozenset(("HELD_DEPLOYED", "HELD_ROLLED_BACK", "UNKNOWN_OUTCOME"))
MAX_FILES, MAX_FILE, MAX_TOTAL = 64, 2 * 1024 * 1024, 16 * 1024 * 1024
REASON_CODES = frozenset("""
UNQUALIFIED_DIRECTORY UNQUALIFIED_FILE FILE_CHANGED_WHILE_READING DUPLICATE_JOURNAL_FIELD
JOURNAL_OBJECT_REQUIRED JOURNAL_BOUND CONTROLLER_CONTEXT_REQUIRED CONTROLLER_DIGEST_REQUIRED
REQUEST_ID_INVALID APPLICATION_TRANSACTION_REQUIRES_RETAINED_CONTROLLER CONTROLLER_OR_REGISTRY_CHANGED
APPLICATION_NOT_QUALIFIED COUPLED_SERVICE_QUALIFICATION_REQUIRED FIVE_FIXED_TASKS_REQUIRED
EXACT_CODE_FILE_SET_REQUIRED CODE_FILE_MAPPING_REFUSED CODE_FILE_DESTINATION_REFUSED
QUALIFIED_SOURCE_OR_LAYOUT_REFUSED FIXED_APPLICATION_REQUEST_REQUIRED REQUEST_ID_REUSED
SHARED_APPLICATION_LEASE_BUSY INITIAL_SERVICES_NOT_QUALIFIED_RUNNING OPERATOR_OR_QUALIFIED_FACTS_CHANGED
OBSERVATION_NOT_FRESH QUALIFIED_BINDING_CHANGED SERVICE_PROCESS_OBSERVATION_INVALID
WATCHER_OBSERVATION_INVALID PRESERVED_STATE_CHANGED WATCHER_PERSISTENT_ENABLEMENT_CHANGED
EXACT_MAINTENANCE_HOLD_CHANGED WATCHERS_CHANGED_DURING_MAINTENANCE SERVICE_CHANGED_OUTSIDE_ATTEMPT
CODE_FILE_CHANGED_OUTSIDE_ATTEMPT EXTERNAL_EFFECT_OUTCOME_UNKNOWN
PUBLICATION_REQUIRES_STOPPED_QUIET_HELD_SERVICES RETAINED_CODE_CHANGED PUBLICATION_TEMPORARY_CHANGED
PUBLICATION_GUARD_CHANGED FILE_CAS_FAILED SERVICE_CHANGED_DURING_HEALTH HEALTH_PROCESS_IDENTITY_INVALID
RESTORED_APPLICATION_UNHEALTHY APPLICATION_HEALTH_UNKNOWN WATCHERS_NOT_SUSPENDED MAINTENANCE_HOLD_CHANGED
STOP_REQUIRES_INDEPENDENT_QUIESCENCE START_REQUIRES_HELD_MODE HELD_HEALTH_CHANGED_BEFORE_WATCHER_RESTORE
HELD_RESULT_CHANGED INCOMPLETE_APPLICATION_PREPARATION QUALIFIED_HOST_OR_JOURNAL_ERROR
LOCAL_APPLICATION_SOURCE_REQUIRED LOCAL_SOURCE_CHANGED LOCAL_BASELINE_CHANGED
RETAINED_PREIMAGE_UNAVAILABLE RETAINED_PREIMAGE_AMBIGUOUS RETAINED_PREIMAGE_CHANGED
RESTART_HELD_HEALTH_FAILED APPLICATION_OBSERVATION_UNKNOWN
REOPEN_REQUIRES_COMMITTED_RELEASE COMMITTED_RELEASE_CHANGED
""".split())


class Refused(RuntimeError):
    pass


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def _hex(value, length=64):
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{%d}" % length, value) is not None


def local_request(value):
    """Validate the tagged local-source ABI without inventing a Git commit."""
    if not isinstance(value, dict) or value.get('schema') != 2 or type(value.get('schema')) is not int:
        return False
    if (set(value) != {'schema', 'id', 'target', 'operation', 'source'}
            or value.get('target') not in TARGETS
            or value.get('operation') not in ('deploy.rollback', 'deploy.restart_service')
            or not isinstance(value.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', value['id'])):
        return False
    source = value['source']
    if not isinstance(source, dict) or not _hex(source.get('release_identity')):
        return False
    if value['operation'] == 'deploy.restart_service':
        return (set(source) == {'kind', 'release_identity', 'baseline_sha256'}
                and source['kind'] == 'verified-current' and _hex(source['baseline_sha256']))
    return (set(source) == {'kind', 'journal_id', 'journal_sha256', 'release_identity'}
            and source['kind'] == 'retained-preimage'
            and isinstance(source['journal_id'], str)
            and re.fullmatch(r'[A-Za-z0-9_-]{8,64}', source['journal_id']) is not None
            and _hex(source['journal_sha256']))


def _directory(path):
    path = Path(path)
    facts = path.lstat()
    if (not stat.S_ISDIR(facts.st_mode) or facts.st_uid != os.getuid()
            or facts.st_mode & 0o022 or path.resolve() != path):
        raise Refused("UNQUALIFIED_DIRECTORY")
    return path


def _read(path, maximum=MAX_FILE):
    path = Path(path)
    _directory(path.parent)
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or before.st_nlink != 1 or before.st_mode & 0o7022 or before.st_size > maximum):
            raise Refused("UNQUALIFIED_FILE")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    if len(raw) > maximum or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise Refused("FILE_CHANGED_WHILE_READING")
    identity = {"sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw),
                "inode": after.st_ino, "device": after.st_dev,
                "mode": stat.S_IMODE(after.st_mode), "mtime_ns": after.st_mtime_ns}
    return raw, identity


def _sync(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _exclusive(path, raw, mode=0o600):
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())


def _json(path):
    raw, _ = _read(path, 1024 * 1024)
    def strict(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise Refused("DUPLICATE_JOURNAL_FIELD")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=strict)
    if not isinstance(value, dict):
        raise Refused("JOURNAL_OBJECT_REQUIRED")
    return value


def _atomic(path, value):
    raw = encode(value)
    if len(raw) > 1024 * 1024:
        raise Refused("JOURNAL_BOUND")
    temporary = path.parent / (".journal-" + uuid.uuid4().hex)
    _exclusive(temporary, raw)
    os.replace(str(temporary), str(path))
    _sync(path.parent)


class ApplicationRelease:
    """One bounded phase/effect/file per step; unfinished holds never auto-resume."""
    def __init__(self, journal_dir, host, context, clock=time.time, crash_hook=None):
        self.root = _directory(Path(journal_dir))
        if set(context) != CONTEXT_KEYS or any(not isinstance(value, str) or not value for value in context.values()):
            raise Refused("CONTROLLER_CONTEXT_REQUIRED")
        if not _hex(context["controller_sha256"]) or not _hex(context["registry_sha256"]):
            raise Refused("CONTROLLER_DIGEST_REQUIRED")
        self.context, self.host, self.clock = dict(context), host, clock
        self.crash_hook = crash_hook or (lambda point: None)

    @contextlib.contextmanager
    def _lock(self, create=True):
        flags = os.O_RDWR | os.O_CREAT if create else os.O_RDONLY
        descriptor = os.open(str(self.root / ".lock"), flags | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(descriptor)

    def _path(self, request_id):
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", request_id):
            raise Refused("REQUEST_ID_INVALID")
        return self.root / request_id

    def coordination_lock(self):
        """Public shared lock; hold through has_active() AND migration commit."""
        return self._lock()

    def has_active(self):
        """Read state; callers making migration decisions must hold coordination_lock()."""
        for path in self.root.iterdir():
            if not path.name.startswith("."):
                _directory(path)
                if not (path / "journal.json").exists() or _json(path / "journal.json").get("state") not in ("HELD_DEPLOYED", "HELD_ROLLED_BACK"):
                    return True
        return False

    @contextlib.contextmanager
    def migration_guard(self):
        """Hold this through controller/registry migration, preventing new work."""
        with self._lock():
            if self.has_active():
                raise Refused("APPLICATION_TRANSACTION_REQUIRES_RETAINED_CONTROLLER")
            yield

    def _load(self, request_id):
        path = _directory(self._path(request_id))
        value = _json(path / "journal.json")
        if (value.get("schema") != 1 or value.get("context") != self.context
                or value.get("request", {}).get("id") != request_id
                or value.get("binding_digest") != digest(value.get("binding"))):
            raise Refused("CONTROLLER_OR_REGISTRY_CHANGED")
        return value

    def status(self, request_id):
        """Read a persisted result without source access or filesystem writes."""
        path = self._path(request_id)
        if not path.exists():
            return None
        with self._lock(create=False):
            return self._result(self._load(request_id))

    def _save(self, journal):
        journal["revision"] = journal.get("revision", 0) + 1
        _atomic(self._path(journal["request"]["id"]) / "journal.json", journal)

    def _directory_backend(self, target):
        factory = getattr(self.host, 'directory_backend', None)
        return factory(target) if callable(factory) else None

    def _local_current(self, target):
        method = getattr(self.host, 'local_current', None)
        if not callable(method): raise Refused('LOCAL_APPLICATION_SOURCE_REQUIRED')
        current = method(target)
        if (not isinstance(current, dict)
                or set(current) != {'binding_template', 'files', 'identities', 'baseline_sha256'}
                or not _hex(current['baseline_sha256']) or not isinstance(current['binding_template'], dict)
                or not isinstance(current['files'], dict) or not 1 <= len(current['files']) <= MAX_FILES
                or set(current['files']) != set(current['identities'])
                or set(current['files']) != set(current['binding_template'].get('files', {}))):
            raise Refused('LOCAL_APPLICATION_SOURCE_REQUIRED')
        total = 0
        for name, data in current['files'].items():
            path = current['binding_template']['files'][name]['path']
            raw, identity = _read(path)
            if data != raw or current['identities'][name] != identity:
                raise Refused('LOCAL_BASELINE_CHANGED')
            total += len(raw)
        if total > MAX_TOTAL: raise Refused('LOCAL_APPLICATION_SOURCE_REQUIRED')
        current = dict(current)
        current['release_identity'] = digest({name: hashlib.sha256(raw).hexdigest()
                                              for name, raw in current['files'].items()})
        return current

    def _preimage(self, journal_id, target, current, expected_sha=None):
        path = self._path(journal_id)
        raw, unused = _read(path / 'journal.json', 1024 * 1024)
        actual_sha = hashlib.sha256(raw).hexdigest()
        if expected_sha is not None and actual_sha != expected_sha:
            raise Refused('RETAINED_PREIMAGE_CHANGED')
        journal = _json(path / 'journal.json')
        binding = journal.get('binding', {})
        if (journal.get('schema') != 1 or journal.get('state') != 'HELD_DEPLOYED'
                or journal.get('phase') != 'COMPLETE' or journal.get('request', {}).get('target') != target
                or journal.get('request', {}).get('operation') == 'deploy.restart_service'
                or journal.get('binding_digest') != digest(binding)
                or binding.get('files') != current['binding_template']['files']
                or binding.get('application_scope_sha256') != current['binding_template'].get('application_scope_sha256')
                or not isinstance(journal.get('files'), list)
                or len(journal['files']) != len(current['files'])
                or journal.get('new_release') != current['release_identity']):
            return None
        files, names, indices = {}, set(), set()
        for item in journal['files']:
            name, index = item.get('name'), item.get('index')
            if (name not in current['files'] or name in names or type(index) is not int
                    or not 0 <= index < MAX_FILES or index in indices
                    or item.get('path') != current['binding_template']['files'][name]['path']
                    or item.get('state') != 'NEW' or item.get('published') != current['identities'][name]):
                return None
            names.add(name); indices.add(index)
            old, unused = _read(path / (str(index) + '.old'))
            if (hashlib.sha256(old).hexdigest() != item['old']['sha256'] or len(old) != item['old']['size']
                    or item['new_sha256'] != hashlib.sha256(current['files'][name]).hexdigest()):
                raise Refused('RETAINED_PREIMAGE_CHANGED')
            files[name] = old
        release = digest({name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()})
        if release != journal.get('old_release'):
            raise Refused('RETAINED_PREIMAGE_CHANGED')
        return {'source': {'kind': 'retained-preimage', 'journal_id': journal_id,
                           'journal_sha256': actual_sha, 'release_identity': release}, 'files': files,
                'original_request': journal['request']}

    def local_request(self, job):
        """Resolve an accepted rollback/restart to verified local provenance.

        This is called once before begin. A durable journal is authoritative on
        recovery, so neither this resolver nor a source reader is rerun then.
        """
        target, operation, request_id = job.get('target'), job.get('operation'), job.get('request_id')
        if target not in TARGETS or operation not in ('deploy.rollback', 'deploy.restart_service'):
            raise Refused('FIXED_APPLICATION_REQUEST_REQUIRED')
        self._path(request_id)
        with self._lock():
            if self.has_active(): raise Refused('SHARED_APPLICATION_LEASE_BUSY')
            backend = self._directory_backend(target)
            if backend is not None:
                return backend.local_request(job)
            current = self._local_current(target)
            if operation == 'deploy.restart_service':
                source = {'kind': 'verified-current', 'release_identity': current['release_identity'],
                          'baseline_sha256': current['baseline_sha256']}
            else:
                choices = []; count = 0
                for path in self.root.iterdir():
                    if path.name.startswith('.'): continue
                    count += 1
                    if count > 1024: raise Refused('JOURNAL_BOUND')
                    _directory(path)
                    candidate = self._preimage(path.name, target, current)
                    if candidate is not None: choices.append(candidate)
                if len(choices) != 1:
                    raise Refused('RETAINED_PREIMAGE_AMBIGUOUS' if choices else 'RETAINED_PREIMAGE_UNAVAILABLE')
                source = choices[0]['source']
            return {'schema': 2, 'id': request_id, 'target': target, 'operation': operation, 'source': source}

    def _qualify_local(self, request):
        current = self._local_current(request['target'])
        source = request['source']
        if request['operation'] == 'deploy.restart_service':
            if source != {'kind': 'verified-current', 'release_identity': current['release_identity'],
                          'baseline_sha256': current['baseline_sha256']}:
                raise Refused('LOCAL_BASELINE_CHANGED')
            files = current['files']; origin = None
        else:
            selected = self._preimage(source['journal_id'], request['target'], current, source['journal_sha256'])
            if selected is None or selected['source'] != source:
                raise Refused('RETAINED_PREIMAGE_CHANGED')
            files, origin = selected['files'], selected['original_request']
        method = getattr(self.host, 'qualify_local', None)
        if not callable(method): raise Refused('LOCAL_APPLICATION_SOURCE_REQUIRED')
        qualified = method(request, files)
        if not isinstance(qualified, dict) or qualified.get('files') != files:
            raise Refused('LOCAL_SOURCE_CHANGED')
        # The forward request identifies where the preimage was retained. It
        # does not assert that its Git SHA was the unknown preimage's commit.
        return qualified, {'source': source, 'preimage_commit': None, 'retained_from_request': origin,
                           'current_identities': current['identities'], 'current_release': current['release_identity']}

    def _validate_binding(self, request, binding, files):
        if (not isinstance(binding, dict) or binding.get("qualified") is not True
                or binding.get("context") != self.context or binding.get("target") != request["target"]
                or binding.get("source") != (request["source"] if local_request(request) else {key: request[key] for key in ("repo", "sha", "manifest_sha256")})
                or local_request(request) and binding.get("operation") != request["operation"]
                or not _hex(binding.get("binding_id")) or not _hex(binding.get("unit_identity"))
                or not _hex(binding.get("selector_identity"))
                or binding.get("old_hold_compatible") is not True or binding.get("new_hold_compatible") is not True):
            raise Refused("APPLICATION_NOT_QUALIFIED")
        if (not isinstance(binding.get("services"), dict) or set(binding["services"]) != {"HERMES_API", "HERMES_DISCORD_RELAY"}
                or not isinstance(binding.get("watchers"), dict) or set(binding["watchers"]) != {"timer", "oneshot"}
                or len(set(binding["services"].values()) | set(binding["watchers"].values())) != 4):
            raise Refused("COUPLED_SERVICE_QUALIFICATION_REQUIRED")
        if (not isinstance(binding.get("task_ids"), list) or len(binding["task_ids"]) != 5
                or any(not isinstance(item, str) or not item for item in binding["task_ids"])
                or len(set(binding["task_ids"])) != 5):
            raise Refused("FIVE_FIXED_TASKS_REQUIRED")
        mapping = binding.get("files")
        backend = self._directory_backend(request["target"])
        if backend is not None:
            if backend.validate_binding(binding, files) is not True or self.host.validate_binding(binding) is not True:
                raise Refused("QUALIFIED_SOURCE_OR_LAYOUT_REFUSED")
            return
        if not isinstance(mapping, dict) or not 1 <= len(mapping) <= MAX_FILES or set(mapping) != set(files):
            raise Refused("EXACT_CODE_FILE_SET_REQUIRED")
        paths, total = set(), 0
        for name, item in mapping.items():
            if (not isinstance(name, str) or not name or name.startswith("/") or ".." in name.split("/")
                    or not isinstance(item, dict) or set(item) != {"path", "kind"}
                    or item["kind"] not in ("code", "compatibility_manifest")
                    or type(files[name]) is not bytes or not 0 < len(files[name]) <= MAX_FILE):
                raise Refused("CODE_FILE_MAPPING_REFUSED")
            path = Path(item["path"])
            if (not path.is_absolute() or path.resolve() != path or path in paths
                    or path == self.root or self.root in path.parents):
                raise Refused("CODE_FILE_DESTINATION_REFUSED")
            paths.add(path)
            total += len(files[name])
        if total > MAX_TOTAL or self.host.validate_binding(binding) is not True:
            raise Refused("QUALIFIED_SOURCE_OR_LAYOUT_REFUSED")

    def begin(self, request):
        is_local = local_request(request)
        if not is_local and (not isinstance(request, dict) or set(request) != {"id", "target", "repo", "sha", "manifest_sha256"}
                or request["target"] not in TARGETS or not isinstance(request["repo"], str)
                or not _hex(request["sha"], 40) or not _hex(request["manifest_sha256"])):
            raise Refused("FIXED_APPLICATION_REQUEST_REQUIRED")
        path = self._path(request["id"])
        with self._lock():
            if path.exists():
                journal = self._load(request["id"])
                if journal["request"] != request:
                    raise Refused("REQUEST_ID_REUSED")
                backend = self._directory_backend(request["target"])
                if backend is not None and journal["phase"] == "PREPARING":
                    journal.update(backend.prepare(journal))
                    journal["phase"] = "SUSPEND_WATCHERS"
                    self._save(journal)
                return self._result(journal)
            if self.has_active():
                raise Refused("SHARED_APPLICATION_LEASE_BUSY")
            backend = self._directory_backend(request["target"])
            if is_local and backend is not None:
                qualified, provenance = self.host.qualify_local(request, {}), None
            elif is_local:
                qualified, provenance = self._qualify_local(request)
            else:
                qualified, provenance = self.host.qualify(request), None
            binding, files = qualified["binding"], qualified["files"]
            self._validate_binding(request, binding, files)
            initial = self.host.observe(binding)
            journal = {"schema": 1, "context": self.context, "request": dict(request),
                       "binding": binding, "binding_digest": digest(binding), "attempt_id": uuid.uuid4().hex,
                       "state": "RUNNING", "phase": "PREPARING", "initial": initial,
                       "files": [], "effects": {}, "created_at": self.clock(), "rollback": False}
            if is_local: journal['local_provenance'] = provenance
            self._check_observation(journal, initial, check_files=False)
            allowed_initial = {'running', 'stopped'} if is_local and request['operation'] == 'deploy.restart_service' else {'running'}
            if any(value.get("state") not in allowed_initial or not value.get("settled") for value in initial["services"].values()):
                raise Refused("INITIAL_SERVICES_NOT_QUALIFIED_RUNNING")
            path.mkdir(mode=0o700)
            _sync(self.root)
            self._save(journal)
            if backend is not None:
                journal.update(backend.prepare(journal))
                journal["phase"] = "SUSPEND_WATCHERS"
                self._save(journal)
                return self._result(journal)
            for index, name in enumerate(sorted(files)):
                destination = Path(binding["files"][name]["path"])
                old, identity = _read(destination)
                if is_local and identity != provenance['current_identities'][name]:
                    raise Refused('LOCAL_BASELINE_CHANGED')
                _exclusive(path / (str(index) + ".old"), old, 0o400)
                _exclusive(path / (str(index) + ".new"), files[name], 0o400)
                journal["files"].append({"name": name, "path": str(destination), "index": index,
                                         "old": identity, "new_sha256": hashlib.sha256(files[name]).hexdigest(),
                                         "new_size": len(files[name]), "state": "OLD"})
                self._save(journal)
            _sync(path)
            journal["old_release"] = digest({item["name"]: item["old"]["sha256"] for item in journal["files"]})
            journal["new_release"] = digest({item["name"]: item["new_sha256"] for item in journal["files"]})
            if is_local and (journal['old_release'] != provenance['current_release']
                             or journal['new_release'] != request['source']['release_identity']):
                raise Refused('LOCAL_SOURCE_CHANGED')
            journal["phase"] = "SUSPEND_WATCHERS"
            self._save(journal)
            return self._result(journal)

    def _check_observation(self, journal, current, check_files=True):
        binding = journal["binding"]
        if (not isinstance(current, dict) or any(current.get(key) != binding[key] for key in ("binding_id", "unit_identity", "selector_identity"))
                or current.get("lease_owner") != journal["request"]["id"]
                or current.get("operator_generation") != journal["initial"].get("operator_generation")
                or not isinstance(current.get("operator_generation"), str)
                or set(current.get("services", {})) != set(binding["services"].values())
                or set(current.get("watchers", {})) != set(binding["watchers"].values())
                or not _hex(current.get("preserved_identity"))):
            raise Refused("OPERATOR_OR_QUALIFIED_FACTS_CHANGED")
        observed = current.get("observed_at")
        if type(observed) not in (int, float) or not math.isfinite(observed) or not self.clock() - 5 <= observed <= self.clock() + 1:
            raise Refused("OBSERVATION_NOT_FRESH")
        if self.host.validate_binding(binding) is not True:
            raise Refused("QUALIFIED_BINDING_CHANGED")
        for value in current["services"].values():
            started = value.get("started_at")
            if (value.get("state") not in ("running", "stopped", "failed")
                    or type(value.get("settled")) is not bool
                    or not isinstance(value.get("invocation_id"), str)
                    or type(value.get("pid")) is not int or value["pid"] < 0
                    or type(started) not in (int, float) or not math.isfinite(started) or started < 0
                    or (value["state"] in ("running", "failed") and (not value["invocation_id"] or value["pid"] <= 0 or started <= 0))):
                raise Refused("SERVICE_PROCESS_OBSERVATION_INVALID")
        if any(type(value.get(key)) is not bool for value in current["watchers"].values() for key in ("active", "enabled", "settled")):
            raise Refused("WATCHER_OBSERVATION_INVALID")
        if journal.get("preserved_identity") and current["preserved_identity"] != journal["preserved_identity"]:
            raise Refused("PRESERVED_STATE_CHANGED")
        if any(type(value.get("enabled")) is not bool or value["enabled"] != journal["initial"]["watchers"][unit].get("enabled")
               for unit, value in current["watchers"].items()):
            raise Refused("WATCHER_PERSISTENT_ENABLEMENT_CHANGED")
        if journal["phase"] in ("EXCLUDE_INGRESS", "WAIT_QUIESCENT", "STOP_SERVICES", "PUBLISH", "START_NEW", "START_OLD", "HEALTH", "STOP_FOR_ROLLBACK", "RESTORE_WATCHERS", "COMMIT_RELEASE", "REOPEN_INGRESS", "COMPLETE") and not self._held(journal, current):
            raise Refused("EXACT_MAINTENANCE_HOLD_CHANGED")
        if journal["phase"] in ("ENTER_HOLD", "EXCLUDE_INGRESS", "WAIT_QUIESCENT", "STOP_SERVICES", "PUBLISH", "START_NEW", "START_OLD", "HEALTH", "STOP_FOR_ROLLBACK") and not self._watchers_suspended(current):
            raise Refused("WATCHERS_CHANGED_DURING_MAINTENANCE")
        if journal["phase"] in ("HEALTH", "RESTORE_WATCHERS", "COMMIT_RELEASE", "REOPEN_INGRESS", "COMPLETE") and current["services"] != journal.get("service_identity"):
            raise Refused("SERVICE_CHANGED_OUTSIDE_ATTEMPT")
        if check_files:
            backend = self._directory_backend(journal["request"]["target"])
            if backend is not None and "publication" in journal:
                backend.check(journal)
            for item in journal["files"]:
                _, actual = _read(item["path"])
                allowed = [item["old"]] if item["state"] == "OLD" else [item["published"]] if item["state"] == "NEW" else [item["restored"]] if item["state"] == "RESTORED" else [item["before"], item["replacement"]]
                if actual not in allowed:
                    raise Refused("CODE_FILE_CHANGED_OUTSIDE_ATTEMPT")

    def _held(self, journal, current):
        hold = current.get("hold", {})
        return (hold.get("reason") == HOLD_REASON and hold.get("global") == "PAUSED"
                and hold.get("tasks") == {task: "PAUSED" for task in journal["binding"]["task_ids"]})

    @staticmethod
    def _watchers_suspended(current):
        return all(value.get("active") is False and value.get("settled") is True for value in current["watchers"].values())

    def _quiet(self, journal, current):
        quiet = current.get("quiescence", {})
        return (self._held(journal, current) and current.get("ingress_excluded") is True
                and quiet.get("independently_observed") is True
                and set(quiet) == QUIET_KEYS | {"independently_observed"}
                and all(type(quiet[key]) is int and quiet[key] == 0 for key in QUIET_KEYS))

    @staticmethod
    def _stopped(current):
        return all(value.get("state") == "stopped" and value.get("settled") is True for value in current["services"].values())

    def _effect(self, journal, current, name, action, details, predicate, next_phase):
        effect = journal["effects"].get(name)
        if effect is None:
            effect = {"effect_id": uuid.uuid4().hex, "attempt_id": journal["attempt_id"],
                      "expected": current, "deadline": self.clock() + 120}
            journal["effects"][name] = effect
            self._save(journal)
            self.crash_hook("before_" + name)
            try:
                getattr(self.host, action)(journal["binding"], current, journal["attempt_id"], effect["effect_id"], details)
            except TimeoutError:
                pass
            self.crash_hook("after_" + name)
            return
        proof = current.get("effect_receipts", {}).get(effect["effect_id"])
        if proof == {"effect_id": effect["effect_id"], "attempt_id": journal["attempt_id"], "complete": True} and predicate(current):
            journal["phase"], journal["state"] = next_phase, "RUNNING"
            if next_phase == "HEALTH":
                journal["service_identity"] = current["services"]
            self._save(journal)
        elif self.clock() >= effect["deadline"]:
            raise Refused("EXTERNAL_EFFECT_OUTCOME_UNKNOWN")

    def _publish_one(self, journal, current):
        if not self._watchers_suspended(current) or not self._quiet(journal, current) or not self._stopped(current):
            raise Refused("PUBLICATION_REQUIRES_STOPPED_QUIET_HELD_SERVICES")
        backend = self._directory_backend(journal["request"]["target"])
        if backend is not None:
            def checked_observation():
                observed = self.host.observe(journal["binding"])
                self._check_observation(journal, observed)
                return observed
            journal.update(backend.publish(journal, checked_observation))
            self._save(journal)
            return
        rollback = journal["rollback"]
        for item in journal["files"]:
            if item["state"] == ("RESTORED" if rollback else "NEW"):
                continue
            if rollback and item["state"] == "OLD":
                item["restored"], item["state"] = item["old"], "RESTORED"
                self._save(journal)
                return
            destination = Path(item["path"])
            if item["state"] not in ("PUBLISHING", "RESTORING"):
                suffix = "old" if rollback else "new"
                raw, _ = _read(self._path(journal["request"]["id"]) / (str(item["index"]) + "." + suffix))
                wanted = item["old"]["sha256"] if rollback else item["new_sha256"]
                if hashlib.sha256(raw).hexdigest() != wanted:
                    raise Refused("RETAINED_CODE_CHANGED")
                temporary = destination.parent / (".deploy-" + journal["attempt_id"] + "-" + str(item["index"]) + "-" + suffix)
                _exclusive(temporary, raw, item["old"]["mode"])
                _sync(destination.parent)
                _, replacement = _read(temporary)
                item.update(state="RESTORING" if rollback else "PUBLISHING", temporary=str(temporary),
                            before=item["published"] if rollback else item["old"], replacement=replacement)
                self._save(journal)
                self.crash_hook("before_file_replace")
            _, actual = _read(destination)
            if actual == item["before"]:
                _, staged = _read(item["temporary"])
                if staged != item["replacement"]:
                    raise Refused("PUBLICATION_TEMPORARY_CHANGED")
                # Re-observe immediately before the CAS; no service/hold drift
                # may be hidden by time spent retaining or hashing code.
                again = self.host.observe(journal["binding"])
                self._check_observation(journal, again)
                if not self._quiet(journal, again) or not self._stopped(again) or not self._watchers_suspended(again):
                    raise Refused("PUBLICATION_GUARD_CHANGED")
                os.replace(item["temporary"], str(destination))
                _sync(destination.parent)
                self.crash_hook("after_file_replace")
            elif actual != item["replacement"]:
                raise Refused("FILE_CAS_FAILED")
            item["restored" if rollback else "published"] = item["replacement"]
            item["state"] = "RESTORED" if rollback else "NEW"
            self._save(journal)
            return
        journal["phase"] = "START_OLD" if rollback else "START_NEW"
        self._save(journal)

    def _health(self, journal, current):
        release = journal["old_release"] if journal["rollback"] else journal["new_release"]
        result = self.host.health(journal["binding"], current, journal["attempt_id"], release)
        again = self.host.observe(journal["binding"])
        self._check_observation(journal, again)
        if current["services"] != again["services"] or not self._held(journal, again) or again.get("ingress_excluded") is not True:
            raise Refused("SERVICE_CHANGED_DURING_HEALTH")
        observed = result.get("observed_at") if isinstance(result, dict) else None
        valid = (isinstance(result, dict) and result.get("attempt_id") == journal["attempt_id"]
                 and result.get("release_identity") == release and result.get("services") == current["services"]
                 and result.get("preserved_identity") == journal["preserved_identity"]
                 and type(observed) in (int, float) and math.isfinite(observed)
                 and self.clock() - 10 <= observed <= self.clock() + 1
                 and observed >= journal["health_started_at"])
        status = result.get("status") if valid else "unknown"
        if status == "healthy" and all(result.get(key) is True for key in ("held", "tasks_registered", "compatibility")) and type(result.get("scheduler_count")) is int and result["scheduler_count"] == 1:
            if any(value.get("state") != "running" or not value.get("settled") or not value.get("invocation_id") or value.get("pid", 0) <= 0 for value in current["services"].values()):
                raise Refused("HEALTH_PROCESS_IDENTITY_INVALID")
            journal["phase"], journal["held_health"] = "RESTORE_WATCHERS", result
            self._save(journal)
            return True
        elif status == "unhealthy":
            if journal['request'].get('operation') == 'deploy.restart_service':
                raise Refused('RESTART_HELD_HEALTH_FAILED')
            if journal["rollback"]:
                raise Refused("RESTORED_APPLICATION_UNHEALTHY")
            journal["rollback"], journal["phase"] = True, "STOP_FOR_ROLLBACK"
            self._save(journal)
        elif self.clock() >= journal["health_started_at"] + 120:
            raise Refused("APPLICATION_HEALTH_UNKNOWN")
        return False

    def step(self, request_id):
        with self._lock():
            journal = self._load(request_id)
            if journal["state"] in TERMINAL:
                return self._result(journal)
            try:
                try:
                    current = self.host.observe(journal["binding"])
                    self._check_observation(journal, current)
                except TimeoutError:
                    # Only this read-only entry observation may wait. Retain
                    # its first deadline across process recovery, and never
                    # advance a phase or reissue an effect without fresh facts.
                    deadline = journal.get("observation_timeout_deadline")
                    if deadline is None:
                        journal["observation_timeout_deadline"] = self.clock() + 120
                        self._save(journal)
                    elif self.clock() >= deadline:
                        raise Refused("APPLICATION_OBSERVATION_UNKNOWN")
                    return self._result(journal)
                if "observation_timeout_deadline" in journal:
                    del journal["observation_timeout_deadline"]
                    self._save(journal)
                phase = journal["phase"]
                if phase == "PREPARING" and self._directory_backend(journal["request"]["target"]) is not None:
                    journal.update(self._directory_backend(journal["request"]["target"]).prepare(journal))
                    journal["phase"] = "SUSPEND_WATCHERS"
                    self._save(journal)
                elif phase == "SUSPEND_WATCHERS":
                    self._effect(journal, current, "suspend_watchers", "suspend_watchers", {}, self._watchers_suspended, "ENTER_HOLD")
                elif phase == "ENTER_HOLD":
                    if not self._watchers_suspended(current):
                        raise Refused("WATCHERS_NOT_SUSPENDED")
                    self._effect(journal, current, "enter_hold", "enter_hold", {"reason": HOLD_REASON}, lambda value: self._held(journal, value), "EXCLUDE_INGRESS")
                elif phase == "EXCLUDE_INGRESS":
                    self._effect(journal, current, "exclude_ingress", "exclude_ingress", {}, lambda value: value.get("ingress_excluded") is True, "WAIT_QUIESCENT")
                elif phase == "WAIT_QUIESCENT":
                    if not self._watchers_suspended(current) or not self._held(journal, current):
                        raise Refused("MAINTENANCE_HOLD_CHANGED")
                    if self._quiet(journal, current):
                        journal.update(phase="STOP_SERVICES", state="RUNNING", preserved_identity=current["preserved_identity"])
                    else:
                        journal["state"] = "HELD_PENDING"
                    self._save(journal)
                elif phase in ("STOP_SERVICES", "STOP_FOR_ROLLBACK"):
                    if not self._watchers_suspended(current) or not self._quiet(journal, current):
                        raise Refused("STOP_REQUIRES_INDEPENDENT_QUIESCENCE")
                    name = "stop_old" if phase == "STOP_SERVICES" else "stop_new"
                    next_phase = 'START_NEW' if journal['request'].get('operation') == 'deploy.restart_service' else 'PUBLISH'
                    self._effect(journal, current, name, "stop_services", {}, self._stopped, next_phase)
                elif phase == "PUBLISH":
                    self._publish_one(journal, current)
                elif phase in ("START_NEW", "START_OLD"):
                    if not self._held(journal, current) or not current.get("ingress_excluded") or not self._watchers_suspended(current):
                        raise Refused("START_REQUIRES_HELD_MODE")
                    name = "start_old" if phase == "START_OLD" else "start_new"
                    if name not in journal["effects"]:
                        journal["health_started_at"] = self.clock()
                    previous = journal["effects"].get(name, {}).get("expected", current)["services"]
                    def new_invocations(value):
                        return all(facts.get("settled") and facts.get("invocation_id") and facts["invocation_id"] != previous[unit].get("invocation_id") and facts.get("pid", 0) > 0 and facts.get("started_at", 0) > 0 for unit, facts in value["services"].items())
                    self._effect(journal, current, name, "start_held", {"release_identity": journal["old_release"] if journal["rollback"] else journal["new_release"]}, new_invocations, "HEALTH")
                elif phase == "HEALTH":
                    self._health(journal, current)
                elif phase == "RESTORE_WATCHERS":
                    if not self._held(journal, current) or current["services"] != journal["held_health"]["services"] or current.get("ingress_excluded") is not True:
                        raise Refused("HELD_HEALTH_CHANGED_BEFORE_WATCHER_RESTORE")
                    # A previous good receipt is insufficient after a long
                    # interruption. Check held health immediately before asking
                    # the host to restore its captured watcher state.
                    if "restore_watchers" not in journal["effects"] and not self._health(journal, current):
                        return self._result(journal)
                    expected = journal["initial"]["watchers"]
                    def restored(value):
                        return all(facts.get("settled") is True and all(facts.get(key) == expected[unit].get(key) for key in ("active", "enabled")) for unit, facts in value["watchers"].items())
                    next_phase = "COMMIT_RELEASE" if journal["binding"].get("managed_ingress") is True else "COMPLETE"
                    self._effect(journal, current, "restore_watchers", "restore_watchers", {"watchers": expected}, restored, next_phase)
                elif phase == "COMMIT_RELEASE":
                    if (journal["binding"].get("managed_ingress") is not True
                            or not self._held(journal, current) or current.get("ingress_excluded") is not True
                            or current["services"] != journal["held_health"]["services"]):
                        raise Refused("REOPEN_REQUIRES_COMMITTED_RELEASE")
                    # Commit code before either process can admit new work. From
                    # this point recovery may reconcile reopening, never perform
                    # an automatic code rollback against newly admitted work.
                    journal["committed_release"] = journal["old_release"] if journal["rollback"] else journal["new_release"]
                    journal["committed_at"] = self.clock()
                    journal["phase"] = "REOPEN_INGRESS"
                    self._save(journal)
                    self.crash_hook("after_release_commit")
                elif phase == "REOPEN_INGRESS":
                    release = journal["old_release"] if journal["rollback"] else journal["new_release"]
                    if (journal["binding"].get("managed_ingress") is not True
                            or journal.get("committed_release") != release):
                        raise Refused("COMMITTED_RELEASE_CHANGED")
                    self._effect(journal, current, "reopen_ingress", "reopen_ingress",
                                 {"release_identity": release},
                                 lambda value: value.get("ingress_excluded") is False, "COMPLETE")
                elif phase == "COMPLETE":
                    ingress = current.get("ingress_excluded")
                    managed = journal["binding"].get("managed_ingress") is True
                    if (not self._held(journal, current) or ingress is not (False if managed else True)
                            or current["services"] != journal["held_health"]["services"]
                            or managed and journal.get("committed_release") != (journal["old_release"] if journal["rollback"] else journal["new_release"])):
                        raise Refused("HELD_RESULT_CHANGED")
                    journal["state"] = "HELD_ROLLED_BACK" if journal["rollback"] else "HELD_DEPLOYED"
                    self._save(journal)
                else:
                    raise Refused("INCOMPLETE_APPLICATION_PREPARATION")
            except Exception as error:
                journal["state"] = "UNKNOWN_OUTCOME"
                # Host exceptions are not a reporting channel for tokens, raw
                # health bodies, unit contents or private filesystem paths.
                code = str(error) if type(error) is Refused else None
                journal["reason"] = code if code in REASON_CODES else "QUALIFIED_HOST_OR_JOURNAL_ERROR"
                self._save(journal)
            return self._result(journal)

    @staticmethod
    def _result(journal):
        result = {"request_id": journal["request"]["id"], "target": journal["request"]["target"],
                "state": journal["state"], "phase": journal["phase"], "attempt_id": journal["attempt_id"],
                "held": None if journal["state"] == "UNKNOWN_OUTCOME" else journal["phase"] not in ("PREPARING", "SUSPEND_WATCHERS", "ENTER_HOLD"),
                "reason": journal.get("reason") if journal.get("reason") in REASON_CODES else None,
                "financial_activation": False}
        if journal["binding"].get("managed_ingress") is True:
            result["maintenance_reopened"] = journal["state"] in ("HELD_DEPLOYED", "HELD_ROLLED_BACK")
            result["code_committed"] = "committed_release" in journal
        if local_request(journal['request']):
            result['operation'] = journal['request']['operation']
            result['source'] = dict(journal['request']['source'])
            result['source_commit'] = None
        return result
