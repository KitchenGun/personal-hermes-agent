"""Fixed-named entrypoint for a reviewed, replaceable v2 controller package."""
from pathlib import Path
import types
import tempfile
import authority

from store import Store
from updater import Engine, self_check
from migration import exercise_candidate
import worker
from runtime_host import make_host


class EntryRefused(RuntimeError):
    pass


def validate_candidate(context):
    """Exercise real interfaces in kernel-owned isolated fixtures.

    The kernel supplies the retained Store implementation, not a candidate's
    claim that it preserved the old ledger. No auth, live ledger, host effect or
    successful placeholder is used in this compatibility probe.
    """
    legacy_store = getattr(context, 'legacy_store_type', None)
    workspace = getattr(context, 'probe_workspace', None)
    if not callable(legacy_store) or not isinstance(workspace, (str, Path)):
        raise EntryRefused('CANDIDATE_PROBE_CONTEXT_REQUIRED')
    if not callable(Store) or not callable(Engine) or not callable(self_check):
        raise EntryRefused('CANDIDATE_INTERFACES_REQUIRED')
    report = exercise_candidate(Store, Engine, self_check, legacy_store, workspace)
    # Exercise the actual dispatcher constructor. This fixture has no production
    # paths and every external callback fails if accidentally touched.
    with tempfile.TemporaryDirectory(prefix='host-interface-', dir=str(workspace)) as temporary:
        root = Path(temporary)
        bootstrap = root / 'bootstrap-v2'
        def forbidden(*args, **kwargs):
            raise EntryRefused('CANDIDATE_HOST_PROBE_EFFECT_REFUSED')
        policy = {'root': str(root), 'unit_dir': str(root / 'units'),
                  'bootstrap_dir': str(bootstrap), 'kernel': str(bootstrap / 'kernel.py'),
                  'askpass': str(bootstrap / 'askpass.py'), 'authority_epoch': authority.EPOCH,
                  'services': {'worker': 'hermes-deploy-worker.service',
                               'updater': 'hermes-deploy-updater.service',
                               'recovery_timer': 'hermes-deploy-updater.timer'},
                  'source_paths': {'DEPLOY_WORKER': authority.SOURCE_PREFIXES['DEPLOY_WORKER']},
                  'control': {'repo': 'KitchenGun/TEST', 'repo_id': 1244380369,
                              'issue': 2, 'author': 41855240},
                  'repos': {name: dict(value, private=name == 'KIS')
                            for name, value in authority.REPOSITORIES.items()}}
        fixture = types.SimpleNamespace(policy=policy, runner=forbidden, auth_reader=forbidden,
                                        reader=types.SimpleNamespace(recovery_selector=forbidden))
        store = Store(str(root / 'control-v2.sqlite3'))
        try:
            host = make_host(fixture, store)
            required = ('validate_configuration', 'recovery_job', 'admit', 'operation',
                        'controller_migration', 'application_release', 'application_request',
                        'readonly', 'fault_gate', 'fault_status')
            if any(not callable(getattr(host, name, None)) for name in required):
                raise EntryRefused('PRODUCTION_HOST_INTERFACE_REQUIRED')
            host.validate_configuration()
            if Engine(store, host).run_pending() != []:
                raise EntryRefused('PRODUCTION_HOST_EMPTY_TICK_FAILED')
        finally:
            store.close()
    return report


def run(context, role):
    if role == 'worker':
        return worker.run(context)
    if role != 'updater':
        raise EntryRefused('CONTROLLER_ROLE_REFUSED')
    root = worker.validate_policy(context.policy)
    # The kernel gates initial installation before reaching this entrypoint.
    # An ordinary migration's held admission must not prevent recovery here.
    factory = getattr(context, 'dispatcher_factory', None)
    if not callable(factory):
        raise EntryRefused('QUALIFIED_DISPATCHER_REQUIRED')
    store = Store(str(worker.ledger_path(root)))
    try:
        dispatcher = factory(store)
        if not callable(getattr(dispatcher, 'run_pending', None)):
            raise EntryRefused('DISPATCHER_INTERFACE_REQUIRED')
        result = dispatcher.run_pending()
        worker.deliver_after_dispatch(store, context)
        return result
    finally:
        store.close()
