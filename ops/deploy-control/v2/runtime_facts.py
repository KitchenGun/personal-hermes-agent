"""Facts-only helpers. Observed bytes never grant approval or enable a profile."""
import base64
import hashlib
from pathlib import Path
import re

import authority

UNKNOWN = 'UNKNOWN'
WORKER_SOURCE_RESOLVER = 'active-worker-package-v1-v2'
EFFECTIVE_PROPERTIES = ('Type', 'WorkingDirectory', 'ExecStart', 'Restart', 'RestartUSec',
                        'KillMode', 'SendSIGKILL', 'TimeoutStopUSec', 'KillSignal',
                        'FinalKillSignal', 'After', 'Before', 'Wants', 'Requires',
                        'PartOf', 'BindsTo', 'Conflicts', 'Triggers', 'TriggeredBy',
                        'PrivateNetwork', 'NetworkNamespacePath')
DEPENDENCY_PROPERTIES = frozenset(('After', 'Before', 'Wants', 'Requires', 'PartOf',
                                  'BindsTo', 'Conflicts', 'Triggers', 'TriggeredBy'))
TIMER_EFFECTIVE_PROPERTIES = tuple(name for name in EFFECTIVE_PROPERTIES if name in DEPENDENCY_PROPERTIES)
SERVICE_ONLY_EFFECTIVE_PROPERTIES = tuple(name for name in EFFECTIVE_PROPERTIES if name not in DEPENDENCY_PROPERTIES)
TIMER_UNIT_PROPERTIES = ('Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload',
                         'ActiveState', 'SubState', 'Job', 'UnitFileState')
V1_FILES = frozenset(('worker.py', 'updater.py', 'store.py', 'runtime.py', 'github_transport.py'))


class FactsRefused(ValueError):
    pass


def applicable_effective_properties(expected_name):
    """Applicability follows the expected unit's actual systemd unit kind."""
    if (type(expected_name) is not str
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}\.(service|timer)', expected_name)):
        raise FactsRefused('UNIT_KIND_UNQUALIFIED')
    return TIMER_EFFECTIVE_PROPERTIES if expected_name.endswith('.timer') else EFFECTIVE_PROPERTIES


def effective_facts(values, expected_name):
    """Measured settings with explicit timer applicability; no invented values."""
    properties = applicable_effective_properties(expected_name)
    if not isinstance(values, dict) or values.get('Id') != expected_name:
        raise FactsRefused('UNIT_EFFECTIVE_ID_MISMATCH')
    if any(name not in values or not isinstance(values[name], str) for name in properties):
        raise FactsRefused('UNIT_EFFECTIVE_PROPERTIES_MISSING')
    normalized = {name: sorted(values[name].split()) if name in DEPENDENCY_PROPERTIES
                  else values[name] for name in properties}
    if expected_name.endswith('.timer'):
        if any(name in values for name in SERVICE_ONLY_EFFECTIVE_PROPERTIES):
            raise FactsRefused('UNIT_INAPPLICABLE_SERVICE_PROPERTIES')
        normalized.update(unit_kind='timer',
                          service_fields_not_applicable=list(SERVICE_ONLY_EFFECTIVE_PROPERTIES))
        return normalized
    normalized['ExecStart'] = stable_exec_start(values['ExecStart'])
    return normalized


def effective_identity(values, expected_name):
    """Hash applicable measured settings; service fingerprint format is unchanged."""
    return authority.digest(effective_facts(values, expected_name))


def stable_exec_start(value):
    """Retain configured commands while excluding process exit/timing metadata."""
    if value == '': return []
    pattern = re.compile(r'\{ path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=(yes|no) ; '
                         r'start_time=[^;]* ; stop_time=[^;]* ; pid=[0-9]+ ; '
                         r'code=[^;]* ; status=[^}]* \}')
    commands = []; position = 0
    for match in pattern.finditer(value):
        if value[position:match.start()].strip(): raise FactsRefused('UNIT_EXECSTART_FORMAT_UNQUALIFIED')
        commands.append({'path': match[1], 'argv': match[2], 'ignore_errors': match[3]})
        position = match.end()
    if not commands or value[position:].strip(): raise FactsRefused('UNIT_EXECSTART_FORMAT_UNQUALIFIED')
    return commands


def _release(value, kind):
    if (type(value) is not dict or set(value) != {'sha', 'manifest_sha256', 'package'}
            or not re.fullmatch('[0-9a-f]{40}', str(value.get('sha')))
            or not re.fullmatch('[0-9a-f]{64}', str(value.get('manifest_sha256')))
            or value.get('package') != kind + '-' + value.get('sha', '')):
        raise FactsRefused('WORKER_RELEASE_INVALID')
    return value


def _pointer(value, kind):
    field = 'controller' if kind == 'controller' else 'release'
    if (set(value) != {field, 'owner', 'generation'}
            or not isinstance(value['owner'], str) or not re.fullmatch('[A-Za-z0-9_:-]{1,128}', value['owner'])
            or not re.fullmatch('[0-9a-f]{32}', str(value['generation']))):
        raise FactsRefused('WORKER_POINTER_INVALID')
    if kind == 'worker':
        return _release(value['release'], kind)
    descriptor = value['controller']
    if (type(descriptor) is not dict
            or set(descriptor) != {'release', 'epoch', 'authority_epoch', 'targets', 'registry_epoch', 'registry_sha256'}
            or descriptor['authority_epoch'] != authority.EPOCH
            or type(descriptor['targets']) is not list or len(descriptor['targets']) != 4
            or set(descriptor['targets']) != authority.TARGETS
            or any(not re.fullmatch('[A-Za-z0-9._-]{1,64}', str(descriptor[key])) for key in ('epoch', 'registry_epoch'))
            or not re.fullmatch('[0-9a-f]{64}', str(descriptor['registry_sha256']))):
        raise FactsRefused('WORKER_CONTROLLER_INVALID')
    return _release(descriptor['release'], kind)


def worker_package(root, unit, read, absent):
    """Resolve measured installed worker bytes with fixed paths and no imports.

    read(path, bound) must independently read/retain safe current file bytes;
    absent(path) must retain a controlled, independently rechecked absence.
    This function never imports the selected package or accepts a candidate path.
    """
    root = Path(root)
    def document(path, maximum=128 * 1024):
        return authority.object_value(read(path, maximum), maximum)
    migration = root / 'bootstrap-migration-v2'
    state_path = migration / 'state.json'
    controller_path = root / 'active/controller.json'
    kind = 'worker'
    if state_path.exists() or state_path.is_symlink():
        state = document(state_path, 65536)
        policy_raw = read(root / 'bootstrap-v2/policy.json', 128 * 1024)
        anchor = document(root / 'bootstrap-v2/anchor.json', 16384)
        if anchor.get('policy.json') != hashlib.sha256(policy_raw).hexdigest():
            raise FactsRefused('WORKER_POLICY_ANCHOR_CHANGED')
        policy = authority.object_value(policy_raw, 128 * 1024)
        specification = policy.get('initial_migration', {})
        intent_raw = read(migration / 'intent.json', 128 * 1024)
        intent = authority.object_value(intent_raw, 128 * 1024)
        if (policy.get('root') != str(root)
                or specification.get('intent_path') != str(migration / 'intent.json')
                or specification.get('state_path') != str(state_path)
                or specification.get('intent_sha256') != hashlib.sha256(intent_raw).hexdigest()
                or state.get('intent_sha256') != specification.get('intent_sha256')
                or state.get('schema') != 1 or type(state.get('schema')) is not int
                or state.get('attempt') != intent.get('attempt')
                or intent.get('candidate') != specification.get('candidate')):
            raise FactsRefused('WORKER_INITIAL_JOURNAL_UNBOUND')
        phase = state.get('phase')
        if phase in ('PREPARED', 'RECOVERY_ARMED', 'ROLLED_BACK'):
            # A prepared pointer is not evidence that its code is running.
            kind = 'worker'
        elif phase in ('ACTIVATING', 'VERIFYING', 'COMMITTED'):
            kind = 'controller'
            if phase != 'COMMITTED':
                expected = intent.get('units', {}).get(unit['Id'], {})
                try: new_bytes = base64.b64decode(expected['new'], validate=True)
                except (KeyError, TypeError, ValueError): raise FactsRefused('WORKER_INITIAL_UNIT_UNKNOWN') from None
                actual = read(Path(unit['FragmentPath']), 32768)
                if (actual != new_bytes or unit.get('ActiveState') != 'active'
                        or unit.get('InvocationID') == expected.get('invocation_id')):
                    raise FactsRefused('WORKER_INITIAL_ACTIVATION_UNOBSERVED')
                if document(controller_path, 16384) != intent.get('candidate_pointer'):
                    raise FactsRefused('WORKER_INITIAL_POINTER_CHANGED')
        else:
            raise FactsRefused('WORKER_INITIAL_PHASE_UNRESOLVED')
    else:
        absent(state_path)
        if controller_path.exists() or controller_path.is_symlink():
            raise FactsRefused('WORKER_V2_INITIAL_JOURNAL_REQUIRED')
        absent(controller_path)
    pointer_path = controller_path if kind == 'controller' else root / 'active/worker.json'
    pointer = document(pointer_path, 16384)
    release = _pointer(pointer, kind)
    # Effective command must agree with selection even when both pointers exist.
    entry = root / ('bootstrap-v2/kernel.py' if kind == 'controller' else 'bootstrap-v1/launcher.py')
    command = stable_exec_start(unit.get('ExecStart', ''))
    expected_argv = '/usr/bin/python3 -I -S -B ' + str(entry) + ' run worker'
    if command != [{'path': '/usr/bin/python3', 'argv': expected_argv, 'ignore_errors': 'no'}]:
        raise FactsRefused('WORKER_EFFECTIVE_ENTRYPOINT_UNRESOLVED')
    folder = root / ('controllers' if kind == 'controller' else 'releases/worker') / release['sha']
    manifest_raw = read(folder / 'manifest.json', 128 * 1024)
    if hashlib.sha256(manifest_raw).hexdigest() != release['manifest_sha256']:
        raise FactsRefused('WORKER_MANIFEST_CHANGED')
    manifest = authority.object_value(manifest_raw, 128 * 1024)
    metadata = manifest.get('files')
    if type(metadata) is not dict or not 1 <= len(metadata) <= authority.MAX_PACKAGE_FILES:
        raise FactsRefused('WORKER_PACKAGE_FILES_INVALID')
    sources = {}; total = 0
    for name, item in metadata.items():
        authority.relative_path(name)
        if (type(item) is not dict or set(item) != {'sha256', 'size'}
                or type(item['size']) is not int or not 1 <= item['size'] <= authority.MAX_PACKAGE_FILE):
            raise FactsRefused('WORKER_PACKAGE_METADATA_INVALID')
        total += item['size']
        if total > authority.MAX_PACKAGE_BYTES: raise FactsRefused('WORKER_PACKAGE_BOUND')
        data = read(folder / name, item['size'])
        if {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)} != item:
            raise FactsRefused('WORKER_PACKAGE_HASH_CHANGED')
        sources[name] = data
    if kind == 'controller':
        authority.validate_outer_envelope(manifest, sources)
    else:
        if (set(manifest) != {'schema', 'authority_epoch', 'target', 'files', 'unit_settings'}
                or type(manifest['schema']) is not int or manifest['schema'] != 1
                or manifest['authority_epoch'] != 'deploy-control-v1' or manifest['target'] != 'worker'
                or set(sources) != V1_FILES
                or type(manifest['unit_settings']) is not dict
                or set(manifest['unit_settings']) != {'restart_seconds', 'stop_timeout_seconds'}
                or any(type(x) is not int or not 5 <= x <= 60 for x in manifest['unit_settings'].values())):
            raise FactsRefused('WORKER_V1_MANIFEST_REFUSED')
        for name, data in sources.items():
            try: compile(data, name, 'exec', dont_inherit=True)
            except (SyntaxError, ValueError): raise FactsRefused('WORKER_V1_SYNTAX_REFUSED') from None
    expected = set(sources) | {'manifest.json'}
    actual = set(); allowed_dirs = {str(parent) for name in sources for parent in Path(name).parents if str(parent) != '.'}
    pending = [folder]; count = 0
    while pending:
        parent = pending.pop()
        for path in parent.iterdir():
            count += 1
            relative = str(path.relative_to(folder))
            if count > len(sources) * 4 + 1 or path.is_symlink(): raise FactsRefused('WORKER_PACKAGE_SCAN_REFUSED')
            if path.is_file(): actual.add(relative)
            elif path.is_dir() and relative in allowed_dirs: pending.append(path)
            else: raise FactsRefused('WORKER_PACKAGE_EXTRA_ENTRY')
    if actual != expected: raise FactsRefused('WORKER_PACKAGE_EXTRA_ENTRY')
    return {'resolver': WORKER_SOURCE_RESOLVER, 'selected_kind': kind,
            'pointer': pointer, 'manifest_sha256': hashlib.sha256(manifest_raw).hexdigest(),
            'files': {name: hashlib.sha256(data).hexdigest() for name, data in sources.items()}}


def private_registry_draft(qualification, effective, network_reservation=None):
    """Build a private planning inventory, never an executable registry/profile.

    Report assertions are stored with their provenance. They are not the
    independent live qualification used by the production observer.
    """
    import registry
    if (qualification.get('schema') != 'deploy-worker-v2-readonly-qualification/2'
            or qualification.get('executable_policy') is not False
            or effective.get('schema') != 'deploy-worker-effective-runtime-metadata/1'):
        raise FactsRefused('RUNTIME_REPORT_SCHEMA_REFUSED')
    paths = dict(qualification['paths'])
    def expand(value):
        if type(value) is list: return [expand(item) for item in value]
        if type(value) is dict: return {key: expand(item) for key, item in value.items()}
        if isinstance(value, str):
            prefix, separator, tail = value.partition('/')
            if prefix in paths: return paths[prefix] + ('/' + tail if separator else '')
        return value
    contracts = {entry['unit']: expand(entry) for entry in qualification['unit_contracts']}
    for name, entry in contracts.items():
        entry['fragment_path'] = paths['U'] + '/' + name
        entry['dropins'] = [{'path': path, 'sha256': UNKNOWN,
                             'latest_hash_revalidated': False} for path in entry.get('dropins', [])]
        entry['effective_identity_sha256'] = UNKNOWN
        entry['effective_identity_observer_schema'] = 'runtime_facts.EFFECTIVE_PROPERTIES'
    for key in ('api', 'relay'):
        latest = effective[key]; entry = contracts[latest['unit']]
        entry['dropins'] = [dict(path=expand(item['path']), sha256=item['sha256'],
                                latest_hash_revalidated=True,
                                observed_utc=effective['final_identity_observed_utc'])
                           for item in latest['ordered_dropins']]
        entry['effective_metadata'] = expand(latest)
    mappings = []
    for item in qualification['runtime_source_mapping']:
        file = item['file']
        mappings.append(dict(item, runtime_path=paths['R'] + '/' + file,
                             source_path=paths['H'] + '/ops/codex-control-dashboard/' + file))
    by_file = {item['file']: item for item in mappings}
    lifecycle = ['codex-control-api.service', 'codex-discord-relay.service',
                 'codex-control-api-healthcheck.service', 'codex-control-api-healthcheck.timer']
    targets = {}
    for target, observed in qualification['targets'].items():
        targets[target] = {
            'enabled': False, 'profile': UNKNOWN, 'executable_policy': False,
            'observed': expand(observed), 'source_selection_contract': UNKNOWN,
            'owned_file_contract': UNKNOWN, 'held_health_contract': UNKNOWN,
            'deploy_contract': UNKNOWN, 'rollback_contract': UNKNOWN,
            'fresh_local_qualification': UNKNOWN,
        }
    for target, file in (('HERMES_API', 'server.js'), ('HERMES_DISCORD_RELAY', 'discord-relay.js')):
        targets[target].update(source_repository=qualification['repositories']['H'],
                               entrypoint=by_file[file], maintenance_units=lifecycle,
                               difference_approval=UNKNOWN)
    targets['KIS'].update(source_repositories={key: qualification['repositories'][key] for key in ('H', 'K')},
                          entrypoint=by_file['kis-ai-market-open-dry-run-task.js'],
                          independent_unit=None, scheduler_host='codex-control-api.service',
                          python_entrypoint={'executable': paths['KIS_PYTHON'], 'module': 'kis_trading_lab',
                                             'cwd': paths['K'], 'arguments': UNKNOWN},
                          maintenance_units=lifecycle, wrapper_python_compatibility=UNKNOWN,
                          scheduler_owner_and_target_impact_drain=UNKNOWN)
    targets['DEPLOY_WORKER'].update(
        source_repository=qualification['repositories']['H'],
        source_prefix=authority.SOURCE_PREFIXES['DEPLOY_WORKER'],
        runtime_source_resolver=WORKER_SOURCE_RESOLVER,
        root=paths['D'],
        entrypoint={'executable': '/usr/bin/python3', 'flags': ['-I', '-S', '-B'],
                    'script': paths['D'] + '/bootstrap-v1/launcher.py', 'arguments': ['run', 'worker']},
        maintenance_units=['hermes-deploy-worker.service', 'hermes-deploy-updater.service',
                           'hermes-deploy-updater.timer'],
        observed_probe_unit='hermes-deploy-probe.service', v1_to_v2_compatibility=UNKNOWN)
    result = {
        'schema': 'deploy-worker-private-registry-draft/1', 'private_only': True,
        'executable_policy': False, 'registry': registry.disabled_registry(),
        'qualification_observed_utc': qualification['identity_observed_utc'],
        'effective_metadata_observed_utc': effective['final_identity_observed_utc'],
        'evidence_status': 'HISTORICAL_READ_ONLY_REPORTS; LIVE_REOBSERVATION_REQUIRED',
        'targets': targets, 'unit_inventory': contracts, 'runtime_source_mapping': mappings,
        'protected_exclusions': {
            'units': ['hermes-github-phone-control.service', 'hermes-dashboard.service'],
            'shared_python': expand(qualification['dependency_contracts']['shared_hermes_python']),
            'shared_repository': dict(qualification['repositories']['S'], path=paths['S']),
            'preserved_dirty_file': paths['S'] + '/uv.lock',
        },
        'target_impact_facts': expand(effective['active_work_and_locks']),
        'listeners_and_health': expand(effective['listeners_and_health']),
        'remaining_blockers': list(qualification['remaining_blockers']) + [
            'Complete effective-property identity must be independently observed before drop-in qualification.',
            'Target-impact ingress, in-flight consumers and owned-child drain need a reviewed contract.',
        ],
        'limits': ['No source divergence approval is inferred from observed hashes.',
                   'Unrelated shared Python work need not idle when shared services and environment remain untouched.',
                   'Phone Worker and Dashboard are protected exclusions, not deploy targets.',
                   'The unavailable Library diff artifact was not retrieved by an alternate route.'],
    }

    if network_reservation is not None:
        evidence = authority.object_value(network_reservation)
        if (type(evidence.get('inspection_exit')) is not int or evidence['inspection_exit'] != 0
                or evidence.get('network_probes_or_socket_changes') is not False
                or evidence.get('paths_created_or_configuration_changed') is not False
                or evidence.get('reserved_unit_manager_state', {}).get('unit') != 'hermes-deploy-kis.service'):
            raise FactsRefused('RUNTIME_NETWORK_RESERVATION_REPORT_REFUSED')
        result['network_reservation_evidence'] = evidence
        result['targets']['KIS']['reserved_future_service'] = {
            'name': 'hermes-deploy-kis.service', 'role': 'kis',
            'fragment_path': paths['U'] + '/hermes-deploy-kis.service',
            'dropin_root': paths['U'] + '/hermes-deploy-kis.service.d',
            'future_root': paths['D'] + '/managed-targets/kis',
            'status': 'reserved-not-created', 'enabled': False,
            'absence_report_observed_utc': evidence['observed_utc'],
            'initial_grant_requires_independent_reobservation': True,
            'activation_contract': UNKNOWN,
        }
    return result
