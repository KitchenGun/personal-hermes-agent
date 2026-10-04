"""Production dispatcher composition inside the fixed four-target envelope.

Application contracts are content-addressed local qualification, not Issue
parameters. Controller recovery never depends on application eligibility.
"""
import contextlib
import hashlib
from pathlib import Path

import authority
import initial_recovery
import kernel
import kernel_runtime
import worker
import kis_application_backend
from application_host import ApplicationHost, HostRefused
from application_release import ApplicationRelease
from controller_host import ControllerHost, _mkdir
from migration import MigrationError, NotReady, TARGET
from maintenance_recovery import IdleMaintenanceRecovery, result as recovery_result
from store import TERMINAL

APPLICATIONS = authority.TARGETS - {TARGET}


class RuntimeHost:
    def __init__(self, context, store):
        self.context, self.store = context, store
        self.controller = ControllerHost(context, store)
        self.root = self.controller.root
        self._applications = {}
        self._source_cache = {}
        self._kis_source_cache = {}
        self._operation = None
        # This callback is used only for an explicit registry transition. An
        # unavailable application contract cannot strand own-worker recovery.
        self.controller.application_baseline_validator = self._validate_baseline

    def _descriptor(self):
        descriptor = getattr(self.context, 'controller', None)
        if not isinstance(descriptor, dict):
            raise MigrationError('KERNEL_SELECTED_CONTROLLER_REQUIRED')
        return descriptor

    def _registry(self):
        value = kernel.load_registry(self.root, self._descriptor())
        supplied = getattr(self.context, 'registry', value)
        if supplied != value:
            raise MigrationError('SELECTED_REGISTRY_CHANGED')
        return value

    def _application_context(self):
        selected = self._descriptor()
        return {'controller_epoch': selected['epoch'],
                'controller_sha256': selected['release']['manifest_sha256'],
                'registry_epoch': selected['registry_epoch'],
                'registry_sha256': selected['registry_sha256']}

    def _app(self, target, registry=None):
        if target not in APPLICATIONS:
            raise MigrationError('FIXED_APPLICATION_TARGET_REQUIRED')
        value = self._registry() if registry is None else registry
        if value['targets'].get(target) is None:
            raise MigrationError('APPLICATION_PROFILE_UNQUALIFIED')
        contract = value.get('contracts', {}).get('applications')
        authority.hash_value(contract, 'APPLICATION_CONTRACT_UNQUALIFIED')
        key = target, authority.digest(value), contract
        if key not in self._applications:
            context = self._application_context()
            context['registry_sha256'] = authority.digest(value)
            self._applications[key] = ApplicationHost(
                value, self.root / 'contracts' / (contract + '.json'), contract,
                context, self._source_reader, runner=self.controller.runner,
                kis_source_verifier=self._kis_verify_source,
                kis_initial_authority=lambda baseline: kis_application_backend.initial_authority(self.context.policy, baseline),
                existing_data_reads=self.context.policy.get('runtime_bounds', {}).get('existing_data_reads'),
                invocation_deadline=getattr(self.context, 'invocation_deadline', None))
            self._applications[key].target = target
        return self._applications[key]

    def _kis_verify_source(self, alias, sha):
        if alias != 'KIS' or not authority.SHA1.fullmatch(str(sha)):
            raise MigrationError('FIXED_APPLICATION_SOURCE_REQUIRED')
        if sha not in self._kis_source_cache:
            self._kis_source_cache[sha] = self.controller.sources().verify('KIS', sha)
        return self._kis_source_cache[sha]

    def _source_reader(self, request, profile):
        key = request['target'], request['repo'], request['sha'], authority.digest(profile)
        if key not in self._source_cache:
            self._source_cache[key] = self.controller.source_reader(request, profile)
        result = self._source_cache[key]
        expected = request.get('manifest_sha256')
        if expected is not None and hashlib.sha256(result['manifest']).hexdigest() != expected:
            raise MigrationError('APPLICATION_MANIFEST_CHANGED')
        return result

    def _validate_baseline(self, registry):
        enabled = [target for target in sorted(APPLICATIONS) if registry['targets'].get(target) is not None]
        if not enabled:
            return True
        return self._app(enabled[0], registry).validate_current_code()

    def validate_configuration(self):
        return self.controller.validate_configuration()

    def admit(self, job):
        return self.controller.admit(job)

    def recovery_job(self):
        return self.controller.recovery_job()

    def idle_recovery_configured(self):
        supplied = getattr(self.context, 'registry', None)
        return isinstance(supplied, dict) and any(
            supplied.get('targets', {}).get(target) is not None for target in APPLICATIONS)

    def idle_recovery_pending(self):
        if not self.idle_recovery_configured():
            return False
        metadata = IdleMaintenanceRecovery(self.root, None).status()
        return metadata['phase'] not in (None, 'COMPLETE') or metadata['code'] == 'JOURNAL_UNQUALIFIED'

    def idle_recovery(self):
        """Same-source maintenance only; never an admission or readonly path."""
        if not self.idle_recovery_configured():
            return None
        try:
            self.controller._validate_local()
            # The dispatcher already owns this lock. A direct call cannot grant
            # itself idle authority, and a replaced lock inode is refused.
            try:
                with worker._lock(self.store.path + '.updater.lock'):
                    pass
            except BlockingIOError:
                pass
            else:
                raise NotReady('IDLE_ENGINE_LOCK_REQUIRED')
            with contextlib.ExitStack() as stack:
                for name in ('admission.lock', 'controller-effects.lock'):
                    stack.enter_context(worker._lock(self.root / name))
                value = self._registry()
                target = next(target for target in sorted(APPLICATIONS) if value['targets'].get(target) is not None)
                app = self._app(target, value)
                if not app.managed_ingress:
                    return None
                adapter = ApplicationRelease(_mkdir(self.root / 'application-transactions'), app,
                                             self._application_context())
                stack.enter_context(adapter.coordination_lock())
                metadata = IdleMaintenanceRecovery(self.root, app, clock=app.clock).status()
                if metadata['code'] == 'JOURNAL_UNQUALIFIED':
                    self._idle_recovery_result = metadata
                    return metadata
                resuming = metadata['phase'] not in (None, 'COMPLETE')
                paths = [Path(self.store.path + '.updater.lock'), self.root / 'admission.lock',
                         self.root / 'controller-effects.lock', adapter.root / '.lock']
                identities = [(path.stat().st_dev, path.stat().st_ino) for path in paths]

                def guard():
                    for path, identity in zip(paths, identities):
                        if (path.lstat().st_dev, path.lstat().st_ino) != identity:
                            raise NotReady('IDLE_LOCK_CHANGED')
                        try:
                            with worker._lock(path): pass
                        except BlockingIOError: pass
                        else: raise NotReady('IDLE_LOCK_REQUIRED')
                    # An owned idle attempt may drain/reopen while new requests
                    # wait. It never starts over queued work or supersedes an
                    # accepted RUNNING application/controller transaction.
                    states = tuple(sorted(TERMINAL | ({'QUEUED'} if resuming else set())))
                    pending = self.store.db.execute('SELECT 1 FROM requests WHERE state NOT IN (' +
                        ','.join('?' for _ in states) + ') LIMIT 1', states).fetchone()
                    if pending is not None or any(self.store.target_state(item)['active_job'] is not None
                            or self.store.target_state(item)['quarantined'] for item in authority.TARGETS):
                        raise NotReady('IDLE_ACCEPTED_WORK_PENDING')
                    if (self.controller.recovery_job() is not None or adapter.has_active()
                            or initial_recovery.load(self.context.policy)[3]['phase'] != 'COMMITTED'):
                        raise NotReady('IDLE_RECOVERY_PENDING')
                    if (kernel_runtime.active_pointer(self.context.policy)['controller'] != self._descriptor()
                            or self._registry() != value):
                        raise NotReady('IDLE_CONTROLLER_CHANGED')

                guard()
                recovery = IdleMaintenanceRecovery(self.root, app, clock=app.clock, guard=guard)
                self._idle_recovery_result = recovery.step()
                return self._idle_recovery_result
        except (BlockingIOError, NotReady):
            self._idle_recovery_result = recovery_result(code='DEFERRED')
        except Exception:
            self._idle_recovery_result = recovery_result(code='RECOVERY_UNCERTAIN')
        return self._idle_recovery_result

    @contextlib.contextmanager
    def operation(self, job, recovery=False):
        if not recovery and job['operation'] not in ('deploy.status', 'deploy.health') \
                and self.idle_recovery_pending():
            raise NotReady('IDLE_MAINTENANCE_RECOVERY_TAKES_PRIORITY')
        if job['target'] == TARGET:
            with self.controller.operation(job, recovery=recovery):
                yield self
            return
        if job['target'] not in APPLICATIONS or self._operation is not None:
            raise MigrationError('APPLICATION_OPERATION_SCOPE_REFUSED')
        self.controller._validate_local()
        with contextlib.ExitStack() as stack:
            for name in ('admission.lock', 'controller-effects.lock'):
                stack.enter_context(worker._lock(self.root / name))
            if self.controller.recovery_job() is not None:
                raise NotReady('CONTROLLER_RECOVERY_TAKES_PRIORITY')
            if kernel_runtime.active_pointer(self.context.policy)['controller'] != self._descriptor():
                raise MigrationError('APPLICATION_CONTROLLER_CHANGED')
            if not recovery and job['operation'] not in ('deploy.status', 'deploy.health'):
                self._app(job['target']).validate_configuration()
            self._operation = job['request_id']
            try:
                yield self
            finally:
                self._operation = None
                self._source_cache.clear()
                self._kis_source_cache.clear()

    def application_release(self, job):
        if self._operation != job['request_id']:
            raise MigrationError('APPLICATION_OPERATION_LOCK_REQUIRED')
        return ApplicationRelease(_mkdir(self.root / 'application-transactions'),
                                  self._app(job['target']), self._application_context())

    def application_request(self, job):
        if self._operation != job['request_id']:
            raise MigrationError('APPLICATION_OPERATION_LOCK_REQUIRED')
        if job['operation'] in ('deploy.rollback', 'deploy.restart_service'):
            return self.application_release(job).local_request(job)
        if job['operation'] != 'deploy.apply':
            raise MigrationError('APPLICATION_OPERATION_REFUSED')
        request = {'id': job['request_id'], 'target': job['target'],
                   'repo': job['request']['repo'], 'sha': job['request']['sha']}
        profile = self._registry()['targets'][job['target']]
        self._app(job['target']).validate_configuration()
        backend = self._app(job['target']).directory_backend(job['target'])
        if backend is not None:
            request['manifest_sha256'] = backend.candidate_identity(request)
            return request
        source = self._source_reader(request, profile)
        request['manifest_sha256'] = hashlib.sha256(source['manifest']).hexdigest()
        return request

    def readonly(self, job):
        if job['target'] == TARGET:
            return self.controller.readonly(job)
        # Read the fixed journal independently so malformed application facts
        # cannot prevent an explicitly requested safe recovery status report.
        metadata = IdleMaintenanceRecovery(self.root, None).status()
        try:
            app = self._app(job['target'])
            result = app.readonly(job)
            if not app.managed_ingress: metadata = None
        except (HostRefused, TimeoutError):
            if (job['operation'] not in ('deploy.status', 'deploy.health')
                    or metadata['phase'] in (None, 'COMPLETE') and metadata['code'] != 'JOURNAL_UNQUALIFIED'):
                raise
            result = {'target': job['target'], 'health': {'status': 'unknown'},
                      'reason': 'APPLICATION_OBSERVATION_UNAVAILABLE', 'financial_activation': False}
        if metadata is not None:
            result['idle_maintenance'] = metadata
        return result

    def controller_migration(self, job):
        return self.controller.controller_migration(job)

    def fault_gate(self):
        return self.controller.fault_gate()

    def fault_status(self, request_id):
        return self.controller.fault_status(request_id)


def make_host(context, store):
    return RuntimeHost(context, store)
