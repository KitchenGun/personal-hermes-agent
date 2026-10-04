"""Filesystem/systemd adapter for the independently selected v2 controller.

Construction and validate_configuration are pure. Effects require the accepted
Store row, the shared admission lock and a separate controller effect lock.
All durable recovery inputs are local; recovery never refreshes GitHub or TTL.
Application lifecycles are deliberately supplied by a separate adapter factory.
"""
import base64
import contextlib
import hashlib
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
import uuid

import authority
import initial_recovery
import kernel
import kernel_runtime
import registry
import unit_envelope
from application_release import ApplicationRelease
from github_transport import GitHub, Sources
from migration import (Migration, MigrationJournal, MigrationError, NotReady,
                       POINTER_KEYS, PROCESS_KEYS, SERVICE_KEYS, TARGET, MIGRATION_OPERATIONS, _same)
from qualification_observer import Observer, ObservationRefused
from store import Busy, TERMINAL
from unit_transition import UnitTransition, inspect_unit
import worker

SERVICES = {'worker': 'hermes-deploy-worker.service',
            'updater': 'hermes-deploy-updater.service',
            'recovery_timer': 'hermes-deploy-updater.timer'}
APPLICATION_MANIFESTS = {'HERMES_API': 'application-release-hermes-api.json',
                         'HERMES_DISCORD_RELAY': 'application-release-hermes-discord-relay.json',
                         'KIS': 'application-release-kis.json'}
ROLES = tuple(sorted(SERVICES))
CANONICAL = ('sha256', 'size', 'mode', 'uid', 'gid')
PROPERTIES = ('Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload',
              'ActiveState', 'SubState', 'Job', 'InvocationID', 'ExecMainPID',
              'ExecMainStartTimestampMonotonic')
RECEIPT_KEYS = {'schema', 'controller', 'release', 'registry_sha256',
                'pointer_generation', 'attempt_id', 'unit_identity', 'invocation_id',
                'pid', 'started_at', 'observed_at', 'status', 'admission_mode', 'transport'}


class HostRefused(MigrationError):
    pass


def validate_configuration(policy):
    """Validate fixed routing without touching files, processes or credentials."""
    if not isinstance(policy, dict):
        raise HostRefused('FIXED_POLICY_REQUIRED')
    for key in ('root', 'unit_dir', 'bootstrap_dir', 'kernel', 'askpass'):
        value = policy.get(key)
        if (not isinstance(value, str) or not value.startswith('/') or
                str(Path(value)) != value or any(part in ('.', '..') for part in value.split('/'))):
            raise HostRefused('FIXED_POLICY_PATH_REQUIRED')
    root, bootstrap = Path(policy['root']), Path(policy['bootstrap_dir'])
    if (bootstrap != root / 'bootstrap-v2' or policy['kernel'] != str(bootstrap / 'kernel.py')
            or policy['askpass'] != str(bootstrap / 'askpass.py')
            or policy.get('services') != SERVICES or policy.get('authority_epoch') != authority.EPOCH
            or policy.get('source_paths') != {TARGET: authority.SOURCE_PREFIXES[TARGET]}):
        raise HostRefused('FIXED_CONTROLLER_SCOPE_REQUIRED')
    control = policy.get('control', {})
    authority.validate_control({'repo': control.get('repo'), 'id': control.get('repo_id'),
                                'issue': control.get('issue'), 'author': control.get('author')})
    if set(policy.get('repos', {})) != set(authority.REPOSITORIES):
        raise HostRefused('FIXED_REPOSITORIES_REQUIRED')
    for alias, definition in policy['repos'].items():
        authority.validate_repository(alias, {key: definition.get(key) for key in ('repo', 'id', 'branch')})
        if definition.get('private') is not (alias == 'KIS'):
            raise HostRefused('FIXED_REPOSITORY_VISIBILITY_REQUIRED')
    return {'ok': True, 'host_api': 1, 'target': TARGET}


def validate_implementation(manifest):
    value = authority.object_value(manifest['implementation_manifest'], 65536)
    if (set(value) - {'schema', 'controller_epoch', 'unit_overrides', 'registry'}
            or value.get('schema') != 1 or type(value.get('schema')) is not int
            or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', str(value.get('controller_epoch', '')))):
        raise HostRefused('CONTROLLER_IMPLEMENTATION_SCHEMA_REFUSED')
    if 'unit_overrides' in value:
        overrides = value['unit_overrides']
        if not isinstance(overrides, dict) or not set(overrides) <= set(ROLES):
            raise HostRefused('CONTROLLER_UNIT_OVERRIDES_REFUSED')
        for role, directives in overrides.items():
            if not isinstance(directives, dict) or not directives:
                raise HostRefused('CONTROLLER_UNIT_OVERRIDES_REFUSED')
            for name, setting in directives.items():
                key = tuple(name.split('.'))
                if key not in unit_envelope.BOUNDS and key != ('Unit', 'Description'):
                    raise HostRefused('CONTROLLER_UNIT_OVERRIDE_AUTHORITY_REFUSED')
                if not isinstance(setting, str) or any(c in setting for c in ('\n', '\r')):
                    raise HostRefused('CONTROLLER_UNIT_OVERRIDE_VALUE_REFUSED')
                if key[0] == 'Timer' and role != 'recovery_timer':
                    raise HostRefused('CONTROLLER_UNIT_OVERRIDE_ROLE_REFUSED')
    if 'registry' in value:
        proposal = value['registry']
        if (not isinstance(proposal, dict) or set(proposal) != {'epoch', 'path'}
                or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', str(proposal.get('epoch', '')))
                or proposal.get('path') not in manifest['files'] or not proposal['path'].endswith('.json')):
            raise HostRefused('CONTROLLER_REGISTRY_PROPOSAL_REFUSED')
    return value


def apply_overrides(raw, directives):
    """Edit bounded directives without copying private launch settings to source."""
    parsed = unit_envelope.parse(raw)
    if not directives: return raw
    changes = {tuple(name.split('.')): setting for name, setting in directives.items()}
    if any(key not in unit_envelope.BOUNDS and key != ('Unit', 'Description') for key in changes):
        raise HostRefused('CONTROLLER_UNIT_OVERRIDE_AUTHORITY_REFUSED')
    sections = {key[0] for key in parsed}
    if any(key[0] not in sections for key in changes):
        raise HostRefused('NEW_UNIT_SECTION_REQUIRES_LOCAL_QUALIFICATION')
    remaining = dict(changes); lines, section = [], None
    def append_new(current):
        for key in sorted(list(remaining)):
            if key[0] == current and key not in parsed:
                lines.append(key[1] + '=' + remaining.pop(key))
    for line in raw.decode().splitlines():
        stripped = line.strip()
        if stripped.startswith('['):
            append_new(section); section = stripped[1:-1]
        if '=' in stripped and not stripped.startswith(('#', ';')):
            name = stripped.split('=', 1)[0].strip(); key = (section, name)
            if key in remaining: line = name + '=' + remaining.pop(key)
        lines.append(line)
    append_new(section)
    if remaining: raise HostRefused('UNIT_OVERRIDE_NOT_APPLIED')
    return ('\n'.join(lines) + '\n').encode()


def registry_delta(old, delta):
    """Logical deltas preserve roots; new code paths are derived beneath them."""
    if (not isinstance(delta, dict) or set(delta) != {'schema', 'revision', 'targets'}
            or type(delta['schema']) is not int or delta['schema'] != 1
            or type(delta['revision']) is not int or delta['revision'] != old['revision'] + 1
            or not isinstance(delta['targets'], dict) or not delta['targets']
            or not set(delta['targets']) <= authority.TARGETS):
        raise HostRefused('REGISTRY_LOGICAL_DELTA_REFUSED')
    value = authority.object_value(old); value['revision'] = delta['revision']
    for target, changes in delta['targets'].items():
        if (value['targets'][target] is None or not isinstance(changes, dict) or not changes
                or not set(changes) <= {'profile', 'permissions', 'health_contract_sha256', 'source_files'}):
            raise HostRefused('REGISTRY_SCOPE_EXPANSION_REQUIRES_LOCAL_QUALIFICATION')
        profile = value['targets'][target]
        for name, setting in changes.items():
            if name == 'health_contract_sha256':
                profile['runtime']['health']['contract_sha256'] = setting
            elif name == 'source_files':
                authority.validate_source(target, profile['repo'], profile['source']['prefix'], setting)
                previous = set(profile['source']['files'])
                if target != TARGET and set(setting) - previous:
                    # The current application journal ABI retains a real old
                    # inode for every owned file. A future reviewed engine may
                    # add explicit absent-preimage/recoverable-removal support.
                    raise HostRefused('APPLICATION_ADDITION_REQUIRES_ABSENT_BASELINE_SCHEMA')
                if not previous <= set(setting):
                    raise HostRefused('OWNED_SOURCE_REMOVAL_REQUIRES_LOCAL_REVIEW')
                resolver = profile['runtime'].get('source_resolver')
                for source in set(setting) - previous:
                    parts = source.lower().split('/')
                    if any(part.rsplit('.', 1)[0] in ('credentials', 'credential', 'secrets', 'secret', 'tokens', 'token')
                           or part.endswith(('.pem', '.key')) for part in parts):
                        raise HostRefused('SOURCE_CREDENTIAL_PATH_REFUSED')
                    if resolver is None:
                        profile['runtime']['owned_code_paths'][source] = profile['runtime']['workdir'] + '/' + source
                profile['source']['files'] = list(setting)
            else:
                profile[name] = setting
    return registry._structure(value)


def _sync(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def _mkdir(path):
    path = Path(path)
    kernel.directory(path.parent)
    try: path.mkdir(mode=0o700)
    except FileExistsError: pass
    return kernel.directory(path)


def _immutable(path, raw):
    path = Path(path)
    kernel.directory(path.parent)
    if path.exists() or path.is_symlink():
        if kernel.read_file(path, max(len(raw), authority.MAX_JSON)) != raw:
            raise HostRefused('RETAINED_ARTIFACT_CHANGED')
        return
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    _sync(path.parent)


class ControllerHost:
    """A Host for DEPLOY_WORKER only; no guessed application runtime defaults."""
    def __init__(self, context, store):
        validate_configuration(context.policy)
        self.context, self.store, self.policy = context, store, context.policy
        self.root = Path(context.policy['root'])
        self.bootstrap = Path(context.policy['bootstrap_dir'])
        self.clock = getattr(context, 'clock', time.time)
        self.monotonic = getattr(context, 'monotonic', time.monotonic)
        runner = getattr(context, 'runner', None)
        self.runner = Observer.capture if runner in (None, subprocess.run) else runner
        self._github = None
        self._held = None
        self._journal = None
        self._rollback_units = None
        self.application_baseline_validator = getattr(context, 'application_baseline_validator', None)

    def validate_configuration(self):
        return validate_configuration(self.policy)

    def _validate_local(self):
        kernel_runtime.validate_policy(self.policy, self.bootstrap)
        if Path(self.store.path) != self.root / worker.LEDGER_NAME:
            raise HostRefused('ACCEPTED_LEDGER_PATH_CHANGED')
        worker.ledger_path(self.root)

    def _remaining(self, maximum=10):
        deadline = getattr(self.context, 'invocation_deadline', None)
        if deadline is None or type(deadline) not in (int, float) or not math.isfinite(deadline):
            raise HostRefused('BOUNDED_INVOCATION_REQUIRED')
        remaining = min(maximum, deadline - self.monotonic())
        if remaining <= 0: raise TimeoutError('CONTROLLER_INVOCATION_DEADLINE')
        return remaining

    def _command(self, argv, maximum=10):
        try:
            result = self.runner(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 timeout=self._remaining(maximum))
        except subprocess.TimeoutExpired:
            raise TimeoutError('CONTROLLER_COMMAND_OUTCOME_UNKNOWN') from None
        except ObservationRefused as error:
            if 'TIMEOUT' in str(error): raise TimeoutError('CONTROLLER_COMMAND_OUTCOME_UNKNOWN') from None
            raise HostRefused('CONTROLLER_COMMAND_OUTPUT_REFUSED') from None
        if not isinstance(result.stdout, bytes) or len(result.stdout) > 16384:
            raise HostRefused('CONTROLLER_COMMAND_OUTPUT_BOUND')
        return result

    def _remote(self):
        if self._held is not None and self._held['recovery']:
            raise HostRefused('NETWORK_FORBIDDEN_DURING_RECOVERY')
        if self._github is None:
            deadline = min(getattr(self.context, 'invocation_deadline'), self.monotonic() + 120)
            token = self.context.auth_reader(deadline=deadline)
            self._github = GitHub(token, self.policy, deadline=deadline)
        return self._github

    def admit(self, job):
        self._validate_local()
        if job.get('target') not in authority.TARGETS or self.store.get(job['request_id']) != job:
            raise HostRefused('EXACT_ACCEPTED_CONTROLLER_REQUEST_REQUIRED')
        remote = self._remote()
        remote.preflight()
        comment = remote.comment(int(job['comment_id']))
        request = authority.admit_comment(comment, self.clock())
        accepted = (request == job['request'] and authority.digest(request) == job['digest']
                    and str(comment.get('id')) == job['comment_id'])
        if accepted and job['operation'] == 'deploy.test_recovery':
            if job['target'] != TARGET: return False
            if request['sha'] == kernel_runtime.active_pointer(self.policy)['controller']['release']['sha']: return False
            gate = self._fault_module().FaultGate(self.root / 'worker-recovery-test')
            return gate.authorization_available()
        return accepted

    def sources(self):
        return Sources(self._remote(), self.policy)

    def source_reader(self, request, profile):
        target = request.get('target')
        if target not in authority.TARGETS - {TARGET} or request.get('repo') != authority.TARGET_REPOS[target]:
            raise HostRefused('FIXED_APPLICATION_SOURCE_REQUIRED')
        sha = request.get('sha')
        if not isinstance(sha, str) or not authority.SHA1.fullmatch(sha):
            raise HostRefused('EXACT_APPLICATION_SHA_REQUIRED')
        authority.validate_source(target, profile['repo'], profile['source']['prefix'], profile['source']['files'])
        if profile['repo'] != request['repo']: raise HostRefused('APPLICATION_SOURCE_PROFILE_MISMATCH')
        sources = self.sources(); cache = sources.verify(request['repo'], sha)
        prefix = profile['source']['prefix']
        path = lambda name: prefix + '/' + name if prefix else name
        raw = sources.blob(cache, sha, path(APPLICATION_MANIFESTS[target]), 65536)
        manifest = authority.object_value(raw, 65536)
        expected = {'schema', 'target', 'repo', 'files', 'compatibility'}
        if (set(manifest) != expected or manifest['schema'] not in (1, 2) or type(manifest['schema']) is not int
                or manifest['target'] != target or manifest['repo'] != request['repo']
                or not isinstance(manifest['files'], dict) or set(manifest['files']) != set(profile['source']['files'])):
            raise HostRefused('APPLICATION_MANIFEST_SCOPE_REFUSED')
        files, total = {}, 0
        for name, metadata in manifest['files'].items():
            fields = {'kind', 'sha256', 'size', 'output'} if manifest['schema'] == 2 else {'sha256', 'size'}
            if (not isinstance(metadata, dict) or set(metadata) != fields
                    or type(metadata['size']) is not int or not 0 < metadata['size'] <= 512 * 1024):
                raise HostRefused('APPLICATION_FILE_BOUND_REFUSED')
            if manifest['schema'] == 2:
                output = metadata['output']
                if (metadata['kind'] != 'byte_patch_v1' or type(output) is not dict
                        or set(output) != {'sha256', 'size'} or type(output['size']) is not int
                        or not 0 < output['size'] <= 2 * 1024 * 1024
                        or (output['sha256'] is not None and (type(output['sha256']) is not str
                            or not re.fullmatch(r'[0-9a-f]{64}', output['sha256'])))):
                    raise HostRefused('APPLICATION_PATCH_METADATA_REFUSED')
            total += metadata['size']
            if total > 8 * 1024 * 1024: raise HostRefused('APPLICATION_PACKAGE_BOUND_REFUSED')
            value = sources.blob(cache, sha, path(name), metadata['size'])
            if (type(value) is not bytes or len(value) != metadata['size']
                    or metadata['sha256'] != hashlib.sha256(value).hexdigest()):
                raise HostRefused('APPLICATION_SOURCE_HASH_MISMATCH')
            files[name] = value
        if request.get('manifest_sha256') is not None and hashlib.sha256(raw).hexdigest() != request['manifest_sha256']:
            raise HostRefused('APPLICATION_MANIFEST_IDENTITY_MISMATCH')
        return {'manifest': raw, 'files': files}

    @contextlib.contextmanager
    def operation(self, job, recovery=False):
        self._validate_local()
        if self._held is not None or job.get('target') != TARGET:
            raise HostRefused('CONTROLLER_OPERATION_SCOPE_REFUSED')
        self._rollback_units = None
        try:
            with contextlib.ExitStack() as stack:
                for name in ('admission.lock', 'controller-effects.lock'):
                    stack.enter_context(worker._lock(self.root / name))
                # A second descriptor proves these exact lock inodes are still
                # held. A replaced path cannot be mistaken for our barrier.
                identities = {name: (self.root / name).stat().st_ino for name in
                              ('admission.lock', 'controller-effects.lock')}
                if job['operation'] in MIGRATION_OPERATIONS:
                    controller = kernel_runtime.active_pointer(self.policy)['controller']
                    context = {'controller_epoch': controller['epoch'],
                               'controller_sha256': controller['release']['manifest_sha256'],
                               'registry_epoch': controller['registry_epoch'],
                               'registry_sha256': controller['registry_sha256']}
                    adapter = ApplicationRelease(_mkdir(self.root / 'application-transactions'), None, context)
                    stack.enter_context(adapter.migration_guard())
                    identities['application-transactions/.lock'] = (self.root / 'application-transactions/.lock').stat().st_ino
                self._held = {'job': job['request_id'], 'digest': job['digest'],
                              'recovery': bool(recovery), 'identities': identities}
                try: yield self
                finally:
                    self._held = None
                    if self._journal is not None:
                        self._journal.close(); self._journal = None
        except BlockingIOError:
            raise Busy('CONTROLLER_ADMISSION_OR_EFFECT_LOCK_BUSY') from None

    def _require_held(self):
        if self._held is None: raise HostRefused('HELD_CONTROLLER_LOCKS_REQUIRED')
        for name, inode in self._held['identities'].items():
            if (self.root / name).lstat().st_ino != inode:
                raise HostRefused('CONTROLLER_LOCK_REPLACED')
            try:
                with worker._lock(self.root / name): pass
            except BlockingIOError: continue
            raise HostRefused('CONTROLLER_LOCK_NOT_HELD')
        try:
            with worker._lock(self.store.path + '.updater.lock'): pass
        except BlockingIOError: pass
        else: raise HostRefused('ENGINE_LOCK_NOT_HELD')
        accepted = self.store.get(self._held['job'])
        if (accepted is None or accepted['digest'] != self._held['digest']
                or accepted['target'] != TARGET or accepted['state'] in TERMINAL):
            raise HostRefused('ACCEPTED_CONTROLLER_OWNERSHIP_CHANGED')
        return accepted

    def quiescence_proof(self):
        job = self._require_held()
        identity = worker.ledger_path(self.root).lstat()
        return {'admission_held': True, 'updater_idle': True,
                'ledger_identity': str(identity.st_dev) + ':' + str(identity.st_ino),
                'barrier_id': authority.digest({'request_id': job['request_id'], 'digest': job['digest']})}

    def recovery_job(self):
        result = self.context.reader.recovery_selector(self.root / 'controller-migrations.sqlite3')
        if result['disposition'] == 'RECOVER_OLD': return result['migration_id']
        return None

    def controller_migration(self, job):
        self._require_held()
        if self._journal is None:
            path = self.root / 'controller-migrations.sqlite3'
            if path.exists() or path.is_symlink(): kernel.read_file(path, 256 * 1024 * 1024)
            self._journal = MigrationJournal(path)
        return Migration(self._journal, self, self.store.path, clock=self.clock,
                         allowed_request_id=job['request_id'], allowed_digest=job['digest'])

    def _unit(self, role):
        name = SERVICES[role]
        result = self._command(['/usr/bin/systemctl', '--user', 'show', name,
                                '--property=' + ','.join(PROPERTIES)])
        if result.returncode: raise HostRefused('CONTROLLER_UNIT_QUERY_FAILED')
        try:
            value = authority.strict_object(line.split('=', 1) for line in result.stdout.decode('ascii').splitlines() if '=' in line)
        except (UnicodeError, ValueError):
            raise HostRefused('CONTROLLER_UNIT_QUERY_INVALID') from None
        if (set(value) != set(PROPERTIES) or value['Id'] != name or value['LoadState'] != 'loaded'
                or value['FragmentPath'] != str(Path(self.policy['unit_dir']) / name)
                or value['DropInPaths'] != '' or value['NeedDaemonReload'] not in ('yes', 'no')):
            raise HostRefused('CONTROLLER_EFFECTIVE_UNIT_SCOPE_CHANGED')
        return value

    def _unit_map(self):
        result = {}
        for role in ROLES:
            identity = inspect_unit(Path(self.policy['unit_dir']) / SERVICES[role])
            if identity is None: raise HostRefused('QUALIFIED_CONTROLLER_UNIT_MISSING')
            result[SERVICES[role]] = {key: identity[key] for key in CANONICAL}
        return result

    def snapshot(self, target):
        if target != TARGET: raise HostRefused('FIXED_CONTROLLER_TARGET_REQUIRED')
        pointer = kernel_runtime.active_pointer(self.policy)
        units = self._unit_map()
        facts = self._unit('worker')
        try:
            pid = int(facts['ExecMainPID']); started = int(facts['ExecMainStartTimestampMonotonic'])
        except ValueError: raise HostRefused('CONTROLLER_PROCESS_IDENTITY_INVALID') from None
        invocation = facts['InvocationID']
        if (invocation and not re.fullmatch(r'[0-9a-f]{32}', invocation)) or pid < 0 or started < 0:
            raise HostRefused('CONTROLLER_PROCESS_IDENTITY_INVALID')
        if kernel_runtime.active_pointer(self.policy) != pointer or self._unit_map() != units or self._unit('worker') != facts:
            raise NotReady('CONTROLLER_CHANGED_DURING_OBSERVATION')
        return {'controller': pointer['controller'], 'release': pointer['controller']['release'],
                'pointer_owner': pointer['owner'], 'pointer_generation': pointer['generation'],
                'unit_identity': authority.digest(units), 'invocation_id': invocation,
                'pid': pid, 'started_at': started,
                'settled': facts['Job'] in ('', '0') and facts['ActiveState'] not in ('activating', 'deactivating', 'reloading'),
                'active_state': facts['ActiveState'], 'sub_state': facts['SubState']}

    observe = snapshot

    def _fetch_package(self, sha):
        if not isinstance(sha, str) or not authority.SHA1.fullmatch(sha):
            raise HostRefused('EXACT_CONTROLLER_SHA_REQUIRED')
        sources = self.sources()
        cache = sources.verify('Hermes', sha)
        prefix = authority.SOURCE_PREFIXES[TARGET] + '/'
        raw = sources.blob(cache, sha, prefix + 'manifest.json', 128 * 1024)
        manifest = authority.object_value(raw, 128 * 1024)
        files = manifest.get('files')
        if not isinstance(files, dict) or not 1 <= len(files) <= authority.MAX_PACKAGE_FILES:
            raise HostRefused('CONTROLLER_FILES_REQUIRED')
        total, values = 0, {}
        for name, meta in files.items():
            authority.relative_path(name)
            if (not isinstance(meta, dict) or set(meta) != {'sha256', 'size'}
                    or type(meta['size']) is not int or not 1 <= meta['size'] <= authority.MAX_PACKAGE_FILE):
                raise HostRefused('CONTROLLER_FILE_BOUND_REFUSED')
            total += meta['size']
            if total > authority.MAX_PACKAGE_BYTES: raise HostRefused('CONTROLLER_PACKAGE_TOO_LARGE')
            values[name] = sources.blob(cache, sha, prefix + name, meta['size'])
        authority.validate_outer_envelope(manifest, values)
        validate_implementation(manifest)
        release = {'sha': sha, 'manifest_sha256': hashlib.sha256(raw).hexdigest(), 'package': 'controller-' + sha}
        parent = _mkdir(self.root / 'controllers'); folder = parent / sha
        if folder.exists() or folder.is_symlink():
            kernel.load_package(self.root, release)
            return release, manifest
        temporary = Path(tempfile.mkdtemp(prefix='.controller-', dir=str(parent)))
        # An interrupted staging directory is private inert data. It is never
        # selected and is deliberately retained rather than guessed/reused.
        for name, data in values.items():
            destination = temporary / name
            for directory in reversed(destination.parent.relative_to(temporary).parents):
                if str(directory) != '.': _mkdir(temporary / directory)
            if destination.parent != temporary: destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            _immutable(destination, data)
        _immutable(temporary / 'manifest.json', raw)
        if folder.exists() or folder.is_symlink(): raise HostRefused('CONTROLLER_STAGE_RACE')
        os.rename(temporary, folder); _sync(parent)
        kernel.load_package(self.root, release)
        return release, manifest

    def _check_new_sources(self, old, new):
        """Observe absence independently before expanding an owned-file mapping."""
        witnesses = {}
        for target, profile in new['targets'].items():
            if profile is None: continue
            previous = old['targets'][target]
            if previous is None:
                raise HostRefused('NEW_RUNTIME_SCOPE_REQUIRES_INDEPENDENT_QUALIFICATION')
            if profile['runtime'].get('source_resolver') is not None:
                # Resolver only reads the verified currently selected package;
                # no runtime destination is introduced by its source allowlist.
                continue
            before = previous['runtime']['owned_code_paths']
            if set(profile['runtime']['owned_code_paths']) <= set(before): continue
            workdir = kernel.directory(profile['runtime']['workdir'])
            for source, destination in profile['runtime']['owned_code_paths'].items():
                if source in before:
                    if before[source] != destination: raise HostRefused('EXISTING_SOURCE_DESTINATION_CHANGED')
                    continue
                path = Path(destination)
                if str(path) != str(workdir / source): raise HostRefused('DERIVED_SOURCE_DESTINATION_CHANGED')
                parents = []
                for parent in [path.parent] + list(path.parent.parents):
                    if parent == workdir.parent: break
                    identity = kernel.directory(parent).lstat()
                    if os.listxattr(str(parent)):
                        raise HostRefused('NEW_SOURCE_PARENT_EXTENDED_ACCESS_UNQUALIFIED')
                    parents.append({'path': str(parent), 'device': identity.st_dev, 'inode': identity.st_ino,
                                    'mode': stat.S_IMODE(identity.st_mode), 'uid': identity.st_uid, 'gid': identity.st_gid})
                if path.exists() or path.is_symlink():
                    raise HostRefused('NEW_SOURCE_DESTINATION_NOT_INDEPENDENTLY_ABSENT')
                witnesses[destination] = parents
        return witnesses

    def _registry_baseline(self, old):
        current = self.snapshot(TARGET)
        self._qualified_units(current)
        kernel.load_package(self.root, current['release'])
        if kernel.load_registry(self.root, current['controller']) != old:
            raise HostRefused('ACTIVE_REGISTRY_BASELINE_CHANGED')
        if any(profile is not None for target, profile in old['targets'].items() if target != TARGET):
            check = self.application_baseline_validator
            if not callable(check) or check(old) is not True:
                raise HostRefused('INDEPENDENT_APPLICATION_BASELINE_VALIDATOR_REQUIRED')
        return current

    def _qualification(self, value, observation):
        observed = observation['observed_at']
        qualification = {'schema': 1, 'authority_epoch': authority.EPOCH,
                         'registry_revision': value['revision'], 'registry_sha256': authority.digest(value),
                         'observed_at': observed, 'expires_at': observed + 300,
                         'boot_id': observation['boot_id'], 'targets': {}}
        for target, profile in value['targets'].items():
            if profile is None: continue
            qualification['targets'][target] = dict(observation['targets'][target],
                scope_sha256=authority.digest(registry.profile_scope(profile)))
            qualification['targets'][target]['binding_id'] = registry.qualification_binding(qualification, target)
        registry.validate_registry(value, qualification, now=self.clock())
        return qualification

    def stage_controller(self, job):
        self._require_held()
        old = kernel_runtime.active_pointer(self.policy)['controller']
        operation = job['operation']
        if operation == 'deploy.restart_service': return old
        if operation == 'deploy.rollback':
            if self._journal is None: raise HostRefused('RETAINED_ROLLBACK_JOURNAL_REQUIRED')
            rows = self._journal.db.execute("SELECT migration_id FROM migrations WHERE phase='COMMITTED' ORDER BY updated_at DESC LIMIT 100").fetchall()
            for row in rows:
                record = self._journal.get(row[0])['record']['prepared']
                if record['new_controller'] == old and record['old_controller'] != old:
                    desired = record['old_controller']
                    kernel.load_package(self.root, desired['release']); kernel.load_registry(self.root, desired)
                    retained = self._transition_record(record['unit_transition'])
                    self._rollback_units = retained['old_templates']
                    return desired
            raise HostRefused('EXACT_RETAINED_CONTROLLER_ROLLBACK_UNAVAILABLE')
        request = job['request']
        if request.get('repo') != 'Hermes': raise HostRefused('FIXED_CONTROLLER_SOURCE_REQUIRED')
        release, manifest = self._fetch_package(request.get('sha'))
        implementation = validate_implementation(manifest)
        new = dict(old, release=release, epoch=implementation['controller_epoch'])
        if operation == 'deploy.migrate_registry':
            proposal = implementation.get('registry')
            if proposal is None: raise HostRefused('EXPLICIT_REGISTRY_PROPOSAL_REQUIRED')
            folder, unused_manifest = kernel.load_package(self.root, release)
            old_registry = kernel.load_registry(self.root, old)
            delta = authority.object_value(kernel.read_file(folder / proposal['path']))
            value = registry_delta(old_registry, delta)
            absent = self._check_new_sources(old_registry, value)
            baseline = self._registry_baseline(old_registry)
            if registry.application_scope(old_registry) != registry.application_scope(value):
                check = self.application_baseline_validator
                if not callable(check) or check(value) is not True:
                    raise HostRefused('CANDIDATE_APPLICATION_CONTRACT_NOT_QUALIFIED')
            observer = Observer(runner=self.runner, clock=self.clock, monotonic=self.monotonic)
            observation = observer.observe(value)
            qualification = self._qualification(value, observation)
            registry.validate_registry(value, qualification, now=self.clock())
            if any(value['targets'][target] is None for target in authority.TARGETS):
                raise HostRefused('REGISTRY_CANNOT_DISABLE_QUALIFIED_TARGETS')
            new.update(registry_epoch=proposal['epoch'], registry_sha256=authority.digest(value))
            parent = _mkdir(self.root / 'registries')
            _immutable(parent / (new['registry_epoch'] + '-' + new['registry_sha256'] + '.json'), authority.encoded(value))
            check = self.check_candidate_controller(new)
            report = {'old_registry_sha256': authority.digest(old_registry),
                      'new_registry_sha256': authority.digest(value),
                      'validator_sha256': manifest['files'].get('registry.py', {}).get('sha256'),
                      'accepted': check.get('ok') is True,
                      'recovery_compatible': check == dict(kernel_runtime.CHECK_REPORT, controller=new)}
            fresh = observer.observe(value)
            registry.validate_migration(old_registry, value, qualification, fresh, report, now=self.clock())
            if not _same(self._registry_baseline(old_registry), baseline, POINTER_KEYS + SERVICE_KEYS):
                raise HostRefused('REGISTRY_BASELINE_CHANGED_DURING_PREFLIGHT')
            if self._check_new_sources(old_registry, value) != absent:
                raise HostRefused('NEW_SOURCE_ABSENCE_CHANGED_DURING_PREFLIGHT')
            checkpoint = {'old_registry_sha256': authority.digest(old_registry), 'controller': new,
                          'qualification': qualification, 'new_sources': absent}
            _mkdir(self.root / 'qualifications')
            initial_recovery.atomic(self.root / 'qualifications' / ('registry-' + new['registry_sha256'] + '.json'),
                                    authority.encoded(checkpoint))
        kernel.selected_descriptor(new, None); kernel.load_registry(self.root, new)
        return new

    def check_candidate_controller(self, descriptor):
        kernel.selected_descriptor(descriptor, None)
        kernel.load_package(self.root, descriptor['release']); kernel.load_registry(self.root, descriptor)
        release = descriptor['release']
        argv = ['/usr/bin/python3', '-I', '-S', '-B', str(self.bootstrap / 'kernel.py'),
                'check-controller', release['sha'], release['manifest_sha256'], descriptor['epoch'],
                descriptor['registry_epoch'], descriptor['registry_sha256']]
        result = self._command(argv, maximum=40)
        if result.returncode: return {'ok': False, 'controller': descriptor}
        report = authority.object_value(result.stdout, 16384)
        if report != dict(kernel_runtime.CHECK_REPORT, controller=descriptor):
            raise HostRefused('CANDIDATE_PROBE_REPORT_INVALID')
        return report

    def _transition_path(self, attempt):
        if not isinstance(attempt, str) or not re.fullmatch(r'[0-9a-f]{32}', attempt):
            raise HostRefused('CONTROLLER_ATTEMPT_INVALID')
        return self.root / 'controller-transitions' / (attempt + '.json')

    def _qualified_units(self, snapshot):
        """Anchor current bytes in installation intent or a completed migration."""
        if self._journal is not None:
            rows = self._journal.db.execute(
                "SELECT migration_id FROM migrations WHERE phase IN ('COMMITTED','ROLLED_BACK') ORDER BY updated_at DESC LIMIT 100").fetchall()
            for row in rows:
                entry = self._journal.get(row[0]); record = entry['record']
                receipt = record.get('final_receipt', {})
                if (receipt.get('controller') == snapshot['controller']
                        and receipt.get('pointer_generation') == snapshot['pointer_generation']):
                    plan = record['prepared']['unit_transition']
                    expected = plan['new_unit_map' if entry['phase'] == 'COMMITTED' else 'old_unit_map']
                    if self._unit_map() != expected:
                        raise HostRefused('QUALIFIED_CONTROLLER_UNIT_BYTES_CHANGED')
                    return
        specification = self.policy['initial_migration']
        raw = kernel.read_file(specification['intent_path'])
        if hashlib.sha256(raw).hexdigest() != specification['intent_sha256']:
            raise HostRefused('INITIAL_UNIT_QUALIFICATION_CHANGED')
        intent = authority.object_value(raw)
        expected = {'controller': snapshot['controller'], 'owner': snapshot['pointer_owner'],
                    'generation': snapshot['pointer_generation']}
        if intent.get('candidate_pointer') != expected:
            raise HostRefused('CONTROLLER_UNITS_NOT_IN_RETAINED_QUALIFICATION')
        for role in ROLES:
            name = SERVICES[role]
            if kernel.read_file(Path(self.policy['unit_dir']) / name, 32768) != base64.b64decode(intent['units'][name]['new'], validate=True):
                raise HostRefused('QUALIFIED_CONTROLLER_UNIT_BYTES_CHANGED')

    def prepare_unit_transition(self, desired, attempt):
        self._require_held()
        old = self.snapshot(TARGET)
        self._qualified_units(old)
        folder, manifest = kernel.load_package(self.root, desired['release'])
        implementation = validate_implementation(manifest)
        templates = self._rollback_units
        overrides = implementation.get('unit_overrides', {})
        mapping, old_templates, candidates = {}, {}, {}
        for role in ROLES:
            path = Path(self.policy['unit_dir']) / SERVICES[role]
            facts = self._unit(role)
            if facts['NeedDaemonReload'] != 'no': raise NotReady('CONTROLLER_DAEMON_RELOAD_PENDING')
            raw = kernel.read_file(path, 32768)
            identity = inspect_unit(path)
            if identity['sha256'] != hashlib.sha256(raw).hexdigest(): raise NotReady('CONTROLLER_UNIT_CHANGED')
            parsed = unit_envelope.parse(raw)
            candidate = (apply_overrides(raw, overrides.get(role, {})) if templates is None
                         else templates[role].encode())
            qualification = {'role': role, 'old_unit_sha256': identity['sha256'],
                             'exec_start': parsed.get(('Service', 'ExecStart')),
                             'dropins_sha256': authority.digest([])}
            unit_envelope.validate_revision(raw, candidate, qualification)
            mapping[role] = {'name': SERVICES[role], 'path': str(path), 'role': role,
                             'old': identity, 'allow_absent': False, 'new_mode': identity['mode']}
            old_templates[role] = raw.decode(); candidates[role] = candidate
        context = {'controller_epoch': old['controller']['epoch'],
                   'controller_sha256': old['controller']['release']['manifest_sha256'],
                   'registry_epoch': old['controller']['registry_epoch'],
                   'registry_sha256': old['controller']['registry_sha256']}
        mapping = {'target': TARGET, 'units': mapping,
                   'qualification_sha256': authority.digest({'old': old, 'mapping': mapping})}
        parent = _mkdir(self.root / 'unit-transactions')
        transition = UnitTransition(parent, mapping, context)
        plan = transition.prepare_plan(attempt, candidates, attempt_id=attempt)
        _mkdir(self.root / 'controller-transitions')
        _immutable(self._transition_path(attempt), authority.encoded({'schema': 1, 'mapping': mapping,
                   'context': context, 'plan': plan, 'desired': desired, 'old_templates': old_templates}))
        return plan

    def _transition_record(self, plan):
        value = kernel_runtime.read_json(self._transition_path(plan['attempt_id']), 262144)
        if (set(value) != {'schema', 'mapping', 'context', 'plan', 'desired', 'old_templates'}
                or value['schema'] != 1 or value['plan'] != plan
                or authority.digest(value['mapping']) != plan['mapping_sha256']
                or authority.digest(value['context']) != plan['context_sha256']):
            raise HostRefused('RETAINED_UNIT_TRANSITION_CHANGED')
        mapping = value['mapping']
        if mapping.get('target') != TARGET or set(mapping.get('units', {})) != set(ROLES):
            raise HostRefused('RETAINED_UNIT_MAPPING_CHANGED')
        for role, spec in mapping['units'].items():
            if (spec['role'] != role or spec['name'] != SERVICES[role]
                    or spec['path'] != str(Path(self.policy['unit_dir']) / SERVICES[role])):
                raise HostRefused('RETAINED_UNIT_SCOPE_CHANGED')
        return value

    def _transition(self, plan):
        retained = self._transition_record(plan)
        return UnitTransition(self.root / 'unit-transactions', retained['mapping'], retained['context'])

    def _effective(self, expected):
        before = self._unit_map()
        if authority.digest(before) != expected: return False
        facts = [self._unit(role) for role in ROLES]
        return all(value['NeedDaemonReload'] == 'no' for value in facts) and self._unit_map() == before

    def unit_transition_proof(self, plan):
        proof = self._transition(plan).proof(plan['transition_id'], plan)
        if proof.get('verified'):
            identity = proof['unit_map_identity']
            proof['effective_unit_identity'] = identity if self._effective(identity) else None
        return proof

    def _active_plan(self, attempt):
        if self._journal is None: raise HostRefused('CONTROLLER_MIGRATION_JOURNAL_REQUIRED')
        entry = self._journal.get(self._held['job'])
        if not entry or entry['record']['prepared']['attempt_id'] != attempt.split(':')[0]:
            raise HostRefused('CONTROLLER_MIGRATION_ATTEMPT_CHANGED')
        return entry['record']['prepared']['unit_transition']

    def _reload(self, plan, direction):
        expected = plan['new_unit_identity' if direction == 'apply' else 'old_unit_identity']
        state_path = self._transition_path(plan['attempt_id']).with_suffix('.' + direction + '-reload.json')
        intent = {'schema': 1, 'plan_sha256': plan['plan_sha256'], 'direction': direction, 'unit_identity': expected}
        if state_path.exists() or state_path.is_symlink():
            state = kernel_runtime.read_json(state_path, 16384)
            if state.get('intent') != intent or state.get('state') not in ('PREPARED', 'OBSERVED'):
                raise HostRefused('DAEMON_RELOAD_INTENT_CHANGED')
        else:
            state = {'intent': intent, 'state': 'PREPARED'}
            _immutable(state_path, authority.encoded(state))
        if not self._effective(expected):
            if state['state'] == 'OBSERVED': raise HostRefused('LOADED_CONTROLLER_UNITS_CHANGED')
            # Reload is idempotent. A retry is allowed only while all exact
            # owned files still match the durable plan under the same locks.
            if authority.digest(self._unit_map()) != expected: raise HostRefused('DAEMON_RELOAD_FILES_CHANGED')
            result = self._command(['/usr/bin/systemctl', '--user', 'daemon-reload'])
            if result.returncode: raise TimeoutError('DAEMON_RELOAD_NOT_CONFIRMED')
        if not self._effective(expected): raise TimeoutError('DAEMON_RELOAD_NOT_OBSERVED')
        initial_recovery.atomic(state_path, authority.encoded({'intent': intent, 'state': 'OBSERVED'}))

    def _registry_recheck_before_publish(self, desired):
        job = self._require_held()
        if job['operation'] != 'deploy.migrate_registry': return
        prepared = self._journal.get(job['request_id'])['record']['prepared']
        old = prepared['old_controller']
        if old['registry_sha256'] == desired['registry_sha256']: return
        checkpoint = kernel_runtime.read_json(self.root / 'qualifications' / ('registry-' + desired['registry_sha256'] + '.json'))
        old_registry, value = kernel.load_registry(self.root, old), kernel.load_registry(self.root, desired)
        if checkpoint['controller'] != desired or checkpoint['old_registry_sha256'] != authority.digest(old_registry):
            raise HostRefused('REGISTRY_QUALIFICATION_BINDING_CHANGED')
        if self._check_new_sources(old_registry, value) != checkpoint['new_sources']:
            raise HostRefused('NEW_SOURCE_ABSENCE_CHANGED_BEFORE_PUBLICATION')
        if any(profile is not None for name, profile in old_registry['targets'].items() if name != TARGET):
            check = self.application_baseline_validator
            if not callable(check) or check(old_registry) is not True:
                raise HostRefused('INDEPENDENT_APPLICATION_BASELINE_VALIDATOR_REQUIRED')
        observation = Observer(runner=self.runner, clock=self.clock, monotonic=self.monotonic).observe(value)
        retained = checkpoint['qualification']
        if observation['boot_id'] != retained['boot_id']:
            raise HostRefused('REGISTRY_QUALIFIED_BOOT_CHANGED')
        # Our worker's files were just changed by the exact retained UnitTransition
        # plan. That proof covers their metadata; all other targets must still
        # match the independently qualified observations, even after a crash.
        for name, item in retained['targets'].items():
            fields = ('process_identity', 'source_identity') if name == TARGET else registry.IDENTITIES
            if any(observation['targets'].get(name, {}).get(key) != item[key] for key in fields):
                raise HostRefused('REGISTRY_QUALIFIED_IDENTITIES_CHANGED')

    def _publish(self, desired, expected, attempt):
        self._require_held()
        kernel.selected_descriptor(desired, None)
        kernel.load_package(self.root, desired['release']); kernel.load_registry(self.root, desired)
        current = self.snapshot(TARGET)
        if not _same(current, expected, POINTER_KEYS + PROCESS_KEYS):
            raise HostRefused('CONTROLLER_DESCRIPTOR_CAS_FAILED')
        pointer = {'controller': expected['controller'], 'owner': expected['pointer_owner'],
                   'generation': expected['pointer_generation']}
        if kernel_runtime.active_pointer(self.policy) != pointer: raise HostRefused('CONTROLLER_POINTER_CAS_FAILED')
        initial_recovery.atomic(self.root / 'active' / 'controller.json', authority.encoded(
            {'controller': desired, 'owner': attempt, 'generation': uuid.uuid4().hex}))

    def resume_controller_transition(self, direction, desired, expected, attempt, plan):
        self._require_held()
        if direction not in ('apply', 'restore'): raise HostRefused('CONTROLLER_DIRECTION_INVALID')
        suffix = ':rollback' if direction == 'restore' else ''
        if attempt != plan['attempt_id'] + suffix or self._active_plan(attempt) != plan:
            raise HostRefused('CONTROLLER_TRANSITION_ATTEMPT_CHANGED')
        prepared = self._journal.get(self._held['job'])['record']['prepared']
        if desired != prepared['new_controller' if direction == 'apply' else 'old_controller']:
            raise HostRefused('CONTROLLER_TRANSITION_DESCRIPTOR_CHANGED')
        if not _same(self.snapshot(TARGET), expected, POINTER_KEYS + SERVICE_KEYS):
            raise HostRefused('CONTROLLER_TRANSITION_CAS_FAILED')
        transition = self._transition(plan)
        operation = transition.apply_one if direction == 'apply' else transition.restore_one
        for unused in range(10):
            proof = transition.proof(plan['transition_id'], plan)
            if not proof['verified']: raise HostRefused('CONTROLLER_UNIT_OWNERSHIP_UNKNOWN')
            desired_state = 'APPLIED' if direction == 'apply' else 'RESTORED'
            if proof['state'] == desired_state and proof['complete']: break
            operation(plan['transition_id'])
        else: raise NotReady('CONTROLLER_UNIT_TRANSITION_PENDING')
        try:
            self._reload(plan, direction)
        except TimeoutError:
            return None
        if direction == 'apply': self._registry_recheck_before_publish(desired)
        self._publish(desired, expected, attempt)

    def activate(self, target, desired, expected, unit_identity, attempt):
        if target != TARGET or unit_identity != expected['unit_identity']:
            raise HostRefused('CONTROLLER_ACTIVATION_SCOPE_CHANGED')
        if desired['registry_sha256'] != expected['controller']['registry_sha256']:
            job = self._require_held()
            if job['operation'] == 'deploy.migrate_registry':
                old_registry = kernel.load_registry(self.root, expected['controller'])
                value = kernel.load_registry(self.root, desired)
                checkpoint = kernel_runtime.read_json(self.root / 'qualifications' / ('registry-' + desired['registry_sha256'] + '.json'))
                if checkpoint['controller'] != desired or checkpoint['old_registry_sha256'] != authority.digest(old_registry):
                    raise HostRefused('REGISTRY_QUALIFICATION_BINDING_CHANGED')
                self._registry_baseline(old_registry)
                if self._check_new_sources(old_registry, value) != checkpoint['new_sources']:
                    raise HostRefused('NEW_SOURCE_ABSENCE_CHANGED_BEFORE_ACTIVATION')
                observation = Observer(runner=self.runner, clock=self.clock, monotonic=self.monotonic).observe(value)
                retained = checkpoint['qualification']
                if (observation['boot_id'] != retained['boot_id']
                        or any(observation['targets'].get(name) != {key: item[key] for key in registry.IDENTITIES}
                               for name, item in retained['targets'].items())):
                    raise HostRefused('REGISTRY_QUALIFIED_IDENTITIES_CHANGED')
                current_qualification = self._qualification(value, observation)
                for name, profile in value['targets'].items():
                    if profile is not None:
                        registry.validate_effects(value, current_qualification, observation, name, now=self.clock())
        return self.resume_controller_transition('apply', desired, expected, attempt, self._active_plan(attempt))

    def restore(self, target, desired, expected, unit_identity, attempt):
        if target != TARGET or unit_identity != expected['unit_identity']:
            raise HostRefused('CONTROLLER_RESTORE_SCOPE_CHANGED')
        try:
            return self.resume_controller_transition('restore', desired, expected, attempt, self._active_plan(attempt))
        except TimeoutError:
            return None  # Migration classifies the retained owned transition before retry.

    def restart(self, target, expected, unit_identity, attempt):
        self._require_held()
        if target != TARGET or unit_identity != expected['unit_identity']:
            raise HostRefused('CONTROLLER_RESTART_SCOPE_CHANGED')
        if not _same(self.snapshot(TARGET), expected, POINTER_KEYS + SERVICE_KEYS) or not self._effective(unit_identity):
            raise HostRefused('CONTROLLER_RESTART_CAS_FAILED')
        if not re.fullmatch(r'[0-9a-f]{32}(?::rollback)?', attempt): raise HostRefused('CONTROLLER_ATTEMPT_INVALID')
        _mkdir(self.root / 'challenges')
        challenge = {'controller': expected['controller'], 'pointer_generation': expected['pointer_generation'],
                     'attempt_id': attempt, 'requested_at': self.clock()}
        initial_recovery.atomic(self.root / 'challenges' / 'controller-worker.json', authority.encoded(challenge))
        result = self._command(['/usr/bin/systemctl', '--user', '--no-block', 'restart', SERVICES['worker']])
        if result.returncode: raise TimeoutError('WORKER_RESTART_OUTCOME_UNKNOWN')

    def health(self, target, release, attempt):
        current = self.snapshot(target)
        if current['release'] != release: return None
        path = self.root / 'receipts' / 'controller-worker.json'
        try: value = kernel_runtime.read_json(path, 16384)
        except FileNotFoundError: return None
        observed = value.get('observed_at')
        pointer = {'controller': current['controller'], 'owner': current['pointer_owner'], 'generation': current['pointer_generation']}
        challenge = kernel_runtime.challenge(self.policy, pointer)
        if (set(value) != RECEIPT_KEYS or value.get('schema') != 2 or type(value.get('schema')) is not int
                or value.get('controller') != current['controller'] or value.get('release') != release
                or value.get('registry_sha256') != current['controller']['registry_sha256']
                or value.get('pointer_generation') != current['pointer_generation']
                or value.get('attempt_id') != challenge['attempt_id']
                or attempt is not None and value.get('attempt_id') != attempt
                or not _same(value, current, SERVICE_KEYS)
                or not current['settled'] or not current['invocation_id'] or current['pid'] <= 0 or current['started_at'] <= 0
                or type(observed) not in (int, float) or not math.isfinite(observed)
                or not max(challenge['requested_at'], self.clock() - 10) <= observed <= self.clock() + 1
                or not self._effective(current['unit_identity'])):
            return None
        status = value['status']
        held = value['admission_mode'] == 'held' and value['transport'] == 'not_checked'
        ready = status == 'healthy' and value['admission_mode'] == 'open' and value['transport'] == 'ready'
        if not (status == 'code-ready' and held or status == 'unhealthy' and held or ready): return None
        if status != 'unhealthy' and (current['active_state'], current['sub_state']) != ('active', 'running'): return None
        if not _same(self.snapshot(target), current, POINTER_KEYS + SERVICE_KEYS): return None
        return dict(value, receipt_status=status, status='healthy' if status == 'code-ready' else status)

    def _fault_module(self):
        # Load the anchored module by its fixed bootstrap pathname. A package
        # cannot substitute a same-named module via sys.path.
        anchor = kernel_runtime.read_json(self.bootstrap / 'anchor.json', 16384)
        path = self.bootstrap / 'fault_gate.py'
        if hashlib.sha256(kernel.read_file(path)).hexdigest() != anchor.get('fault_gate.py'):
            raise HostRefused('ANCHORED_FAULT_GATE_CHANGED')
        return kernel_runtime.file_module(path, '_controller_anchored_fault_gate')

    def fault_gate(self):
        self._require_held()
        return self._fault_module().FaultGate(_mkdir(self.root / 'worker-recovery-test'))

    def fault_status(self, request_id):
        return self.fault_gate().status(request_id)

    def readonly(self, job):
        self._require_held()
        current = self.snapshot(TARGET)
        result = {'controller': current['controller'], 'financial_activation': False,
                  'health': self.health(TARGET, current['release'], None)}
        if result['health'] is not None:
            result['health']['status'] = result['health']['receipt_status']
            result['health']['operational_ready'] = (result['health']['status'] == 'healthy'
                and result['health']['admission_mode'] == 'open' and result['health']['transport'] == 'ready')
        if job['operation'] == 'deploy.verify':
            descriptor = self.stage_controller(job)
            result['candidate'] = self.check_candidate_controller(descriptor)
        return result
