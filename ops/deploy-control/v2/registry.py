"""Versioned declarative profiles, qualified independently of GitHub requests.

Registry validation performs no host effects. Enabled profiles require a trusted
local qualification document; validate_effects must additionally receive a fresh
independent host observation immediately before an effect. Qualification data
must never come from a request, candidate package, or a claimed HTTP health body.

Template/source identities proposed by a reviewed registry are distinct from
current process/unit/source identities. Changing an implementation hash does not
pretend those candidate bytes are already installed. Migrations require a
candidate-validator preflight and fresh current-identity observation.
"""
import math
import re
import time
from pathlib import PurePosixPath

import authority

Refused = authority.Refused
SCHEMA = 1
IDENTITIES = ('process_identity', 'unit_identity', 'source_identity', 'filesystem_identity')
_APPLICATIONS = authority.TARGETS - {'DEPLOY_WORKER'}
# The immutable ceiling reserves KIS's future unit; this implementation still
# coordinates only the four currently qualified coupled application units.
_APPLICATION_ROLES = frozenset(('api', 'relay', 'watchdog_service', 'watchdog_timer'))
_UNIT_PATTERN = re.compile(r'[A-Za-z0-9_-]{1,100}\.(service|timer)\Z')
WORKER_SOURCE_RESOLVER = 'active-worker-package-v1-v2'
_BOOT_PATTERN = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z')


def _keys(value, expected, code):
    authority.exact_keys(value, expected, code)


def _integer(value, minimum, code):
    if type(value) is not int or value < minimum:
        raise Refused(code)


def _path(value):
    if (not isinstance(value, str) or not 2 <= len(value) <= 4096
            or not value.startswith('/') or value.startswith('//')
            or str(PurePosixPath(value)) != value or '\\' in value
            or any(part in ('.', '..') for part in value.split('/'))
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise Refused('RUNTIME_PATH_REFUSED')
    return value


def _within(child, parent):
    return child == parent or child.startswith(parent + '/')


def _profile(target, value):
    _keys(value, ('profile', 'repo', 'source', 'runtime', 'permissions'),
          'PROFILE_FIELDS_REFUSED')
    if (not isinstance(value['profile'], str)
            or not re.fullmatch(r'[a-z][a-z0-9-]{2,79}', value['profile'])):
        raise Refused('PROFILE_NAME_REFUSED')
    authority.validate_profile_envelope(dict(
        authority_epoch=authority.EPOCH, target=target, repo=value['repo'],
        source=value['source'], permissions=value['permissions']))
    runtime = value['runtime']
    fields = {'workdir', 'owned_code_paths', 'units', 'health', 'shared_lease', 'preserved_paths'}
    if 'source_resolver' in runtime:
        fields.add('source_resolver')
        if target != 'DEPLOY_WORKER' or runtime['source_resolver'] != WORKER_SOURCE_RESOLVER:
            raise Refused('SOURCE_RESOLVER_REFUSED')
    _keys(runtime, fields, 'RUNTIME_FIELDS_REFUSED')
    workdir = _path(runtime['workdir'])
    if authority.excluded_path(workdir):
        raise Refused('EXCLUDED_RUNTIME_REFUSED')
    _path(runtime['shared_lease'])
    mapping = runtime['owned_code_paths']
    expected_mapping = set() if 'source_resolver' in runtime else set(value['source']['files'])
    if type(mapping) is not dict or set(mapping) != expected_mapping:
        raise Refused('OWNED_CODE_SET_REFUSED')
    for source, destination in mapping.items():
        _path(destination)
        if not _within(destination, workdir) or destination == workdir:
            raise Refused('CODE_DESTINATION_OUTSIDE_WORKDIR')
        if authority.excluded_path(destination):
            raise Refused('EXCLUDED_RUNTIME_REFUSED')
    destinations = list(mapping.values())
    if len(set(destinations)) != len(destinations):
        raise Refused('CODE_DESTINATION_ALIAS_REFUSED')
    if any(a != b and _within(a, b) for a in destinations for b in destinations):
        raise Refused('CODE_DESTINATION_OVERLAP_REFUSED')
    preserved = runtime['preserved_paths']
    if (type(preserved) is not list or len(preserved) > 256
            or any(not isinstance(path, str) for path in preserved)
            or len(set(preserved)) != len(preserved)):
        raise Refused('PRESERVED_PATHS_REFUSED')
    for path in preserved:
        _path(path)
        if any(_within(path, owned) or _within(owned, path) for owned in destinations):
            raise Refused('PRESERVED_CODE_OVERLAP_REFUSED')
    if any(_within(runtime['shared_lease'], path) or
           _within(path, runtime['shared_lease']) for path in destinations):
        raise Refused('LEASE_CODE_OVERLAP_REFUSED')
    units = runtime['units']
    if type(units) is not list or not 1 <= len(units) <= 8:
        raise Refused('QUALIFIED_UNITS_REQUIRED')
    names, roles, fragments = set(), set(), set()
    for unit in units:
        fields = {'name', 'role', 'fragment_path', 'sha256'}
        if 'dropins' in unit or 'effective_identity_sha256' in unit:
            fields.update(('dropins', 'effective_identity_sha256'))
        _keys(unit, fields, 'UNIT_FIELDS_REFUSED')
        name, role = unit['name'], unit['role']
        supported_roles = _APPLICATION_ROLES if target in _APPLICATIONS else authority.ROLE_CAPS[target]
        if (not isinstance(name, str) or not _UNIT_PATTERN.fullmatch(name)
                or authority.excluded_path(name)
                or not isinstance(role, str) or role not in supported_roles):
            raise Refused('UNIT_ROLE_REFUSED')
        suffix = '.timer' if role.endswith('_timer') else '.service'
        if not name.endswith(suffix):
            raise Refused('UNIT_KIND_REFUSED')
        fragment = _path(unit['fragment_path'])
        if PurePosixPath(fragment).name != name or authority.excluded_path(fragment):
            raise Refused('UNIT_FRAGMENT_REFUSED')
        if any(_within(fragment, path) or _within(path, fragment) for path in destinations):
            raise Refused('UNIT_CODE_OVERLAP_REFUSED')
        authority.hash_value(unit['sha256'], 'UNIT_HASH_REFUSED')
        if 'dropins' in unit:
            authority.hash_value(unit['effective_identity_sha256'], 'UNIT_EFFECTIVE_HASH_REFUSED')
            dropins = unit['dropins']
            if type(dropins) is not list or len(dropins) > 16:
                raise Refused('UNIT_DROPINS_REFUSED')
            seen = set()
            for dropin in dropins:
                _keys(dropin, ('path', 'sha256'), 'UNIT_DROPIN_FIELDS_REFUSED')
                path = _path(dropin['path'])
                if (not path.endswith('.conf') or any(char.isspace() for char in path)
                        or authority.excluded_path(path) or path == fragment or path in seen):
                    raise Refused('UNIT_DROPIN_PATH_REFUSED')
                if any(_within(path, owned) or _within(owned, path) for owned in destinations):
                    raise Refused('UNIT_CODE_OVERLAP_REFUSED')
                authority.hash_value(dropin['sha256'], 'UNIT_DROPIN_HASH_REFUSED')
                seen.add(path)
        if name in names or role in roles or fragment in fragments:
            raise Refused('DUPLICATE_UNIT_BINDING')
        names.add(name); roles.add(role); fragments.add(fragment)
    required_roles = ({'api', 'relay', 'watchdog_service', 'watchdog_timer'}
                      if target in _APPLICATIONS else {'worker', 'updater'})
    if not required_roles <= roles:
        raise Refused('COUPLED_UNITS_REQUIRED')
    health = runtime['health']
    _keys(health, ('kind', 'contract_sha256'), 'HEALTH_FIELDS_REFUSED')
    expected_kind = 'held-application-v1' if target in _APPLICATIONS else 'worker-receipt-v1'
    if health['kind'] != expected_kind:
        raise Refused('HEALTH_CONTRACT_REFUSED')
    authority.hash_value(health['contract_sha256'], 'HEALTH_HASH_REFUSED')


def profile_scope(value):
    """Fixed names/paths/caps; desired implementation hashes are not VM facts."""
    result = authority.object_value(value)
    for unit in result['runtime']['units']:
        del unit['sha256']
    del result['runtime']['health']['contract_sha256']
    return result


def application_scope(value):
    """Application contract binding, independent of controller/revision labels."""
    result = {}
    for target in sorted(_APPLICATIONS):
        profile = value['targets'][target]
        result[target] = None if profile is None else authority.object_value(profile)
        if result[target] is not None:
            del result[target]['profile']
    return result


def _structure(raw):
    value = authority.object_value(raw)
    fields = {'schema', 'authority_epoch', 'revision', 'targets'}
    if 'contracts' in value:
        fields.add('contracts')
        _keys(value['contracts'], ('applications',), 'REGISTRY_CONTRACT_FIELDS_REFUSED')
        authority.hash_value(value['contracts']['applications'], 'REGISTRY_CONTRACT_HASH_REFUSED')
    _keys(value, fields, 'REGISTRY_FIELDS_REFUSED')
    if type(value['schema']) is not int or value['schema'] != SCHEMA:
        raise Refused('REGISTRY_SCHEMA_REFUSED')
    if value['authority_epoch'] != authority.EPOCH:
        raise Refused('AUTHORITY_EPOCH_REFUSED')
    _integer(value['revision'], 1, 'REGISTRY_REVISION_REFUSED')
    _keys(value['targets'], authority.TARGETS, 'REGISTRY_TARGETS_REFUSED')
    profiles = set()
    common_units, common_lease = None, None
    destinations = {}
    for target, profile in value['targets'].items():
        if profile is None:
            continue
        _profile(target, profile)
        if profile['profile'] in profiles:
            raise Refused('DUPLICATE_PROFILE_NAME')
        profiles.add(profile['profile'])
        for source, path in profile['runtime']['owned_code_paths'].items():
            identity = (profile['repo'], profile['source']['prefix'], source)
            if any(other != path and (_within(path, other) or _within(other, path))
                   for other in destinations):
                raise Refused('CROSS_TARGET_CODE_OVERLAP_REFUSED')
            if path in destinations and destinations[path] != identity:
                raise Refused('CROSS_TARGET_CODE_ALIAS_REFUSED')
            destinations[path] = identity
        if target in _APPLICATIONS:
            # The three applications share one maintenance lifecycle. Separate
            # KIS service control is never inferred from its target label.
            units = sorted(profile['runtime']['units'], key=lambda unit: unit['role'])
            lease = profile['runtime']['shared_lease']
            if common_units is not None and (common_units != units or common_lease != lease):
                raise Refused('SHARED_MAINTENANCE_BINDING_MISMATCH')
            common_units, common_lease = units, lease
    return value


def disabled_registry(revision=1):
    """An honest shipped default: no VM path, unit or profile is invented."""
    return _structure({'schema': SCHEMA, 'authority_epoch': authority.EPOCH,
                       'revision': revision, 'targets': {target: None for target in sorted(authority.TARGETS)}})


def _now(value):
    result = time.time() if value is None else value
    if (isinstance(result, bool) or not isinstance(result, (int, float))
            or not math.isfinite(result)):
        raise Refused('OBSERVATION_TIME_INVALID')
    return result


def qualification_binding(qualification, target):
    """Bind one independently collected local observation to a candidate scope."""
    item = qualification['targets'][target]
    return authority.digest({
        'authority_epoch': qualification['authority_epoch'],
        'registry_revision': qualification['registry_revision'],
        'registry_sha256': qualification['registry_sha256'],
        'observed_at': qualification['observed_at'], 'expires_at': qualification['expires_at'],
        'boot_id': qualification['boot_id'], 'target': target,
        'scope_sha256': item['scope_sha256'],
        'identities': {key: item[key] for key in IDENTITIES},
    })


def _qualification(value, qualification, now, initial_worker=False):
    enabled = {target for target, profile in value['targets'].items() if profile is not None}
    if initial_worker:
        if enabled != authority.TARGETS:
            raise Refused('INITIAL_FOUR_TARGET_STRUCTURE_REQUIRED')
        enabled = {'DEPLOY_WORKER'}
    if not enabled and qualification is None:
        return None
    if qualification is None:
        raise Refused('LOCAL_QUALIFICATION_REQUIRED')
    q = authority.object_value(qualification)
    _keys(q, ('schema', 'authority_epoch', 'registry_revision', 'registry_sha256',
              'observed_at', 'expires_at', 'boot_id', 'targets'), 'QUALIFICATION_FIELDS_REFUSED')
    if (type(q['schema']) is not int or q['schema'] != 1
            or q['authority_epoch'] != authority.EPOCH
            or type(q['registry_revision']) is not int
            or q['registry_revision'] != value['revision']
            or q['registry_sha256'] != authority.digest(value)):
        raise Refused('QUALIFICATION_REGISTRY_MISMATCH')
    _integer(q['observed_at'], 0, 'QUALIFICATION_TIME_REFUSED')
    _integer(q['expires_at'], 0, 'QUALIFICATION_TIME_REFUSED')
    current = _now(now)
    if not q['observed_at'] <= current < q['expires_at'] or q['expires_at'] - q['observed_at'] > 3600:
        raise Refused('QUALIFICATION_EXPIRED')
    if not isinstance(q['boot_id'], str) or not _BOOT_PATTERN.fullmatch(q['boot_id']):
        raise Refused('BOOT_IDENTITY_REFUSED')
    _keys(q['targets'], enabled, 'QUALIFICATION_TARGETS_MISMATCH')
    for target in enabled:
        item = q['targets'][target]
        _keys(item, ('scope_sha256', 'binding_id') + IDENTITIES, 'QUALIFICATION_IDENTITY_REFUSED')
        for field in item:
            authority.hash_value(item[field], 'QUALIFICATION_IDENTITY_REFUSED')
        if item['scope_sha256'] != authority.digest(profile_scope(value['targets'][target])):
            raise Refused('QUALIFICATION_SCOPE_MISMATCH')
        if item['binding_id'] != qualification_binding(q, target):
            raise Refused('QUALIFICATION_BINDING_MISMATCH')
    return q


def validate_registry(raw, qualification=None, now=None):
    """Return an independent validated dict; this alone authorizes no effect."""
    value = _structure(raw)
    _qualification(value, qualification, now)
    return value


def validate_effects(raw, qualification, observation, target, now=None):
    """Fail closed on a reboot, changed process/unit/source/path, or stale facts.

    Observation is supplied freshly by the host adapter, not copied from the
    qualification by a request handler. A successful check does not establish
    maintenance drain, held health, or permission to perform financial actions.
    """
    value = _structure(raw)
    q = _qualification(value, qualification, now)
    if (not isinstance(target, str) or target not in authority.TARGETS
            or value['targets'][target] is None):
        raise Refused('TARGET_NOT_QUALIFIED')
    return _observed_match(value, q, observation, target, now)


def validate_initial_worker(raw, qualification, observation=None, now=None):
    """Qualify only the existing worker before the sealed application transition.

    This does not qualify or authorize application effects. Initial application
    observations must later derive a complete qualification from their owned
    transition before the ordinary controller is admitted.
    """
    value = _structure(raw)
    q = _qualification(value, qualification, now, initial_worker=True)
    if observation is not None:
        _observed_match(value, q, observation, 'DEPLOY_WORKER', now)
    return value


def _observed_match(value, q, observation, target, now):
    observed = authority.object_value(observation)
    _keys(observed, ('boot_id', 'observed_at', 'targets'), 'OBSERVATION_FIELDS_REFUSED')
    if observed['boot_id'] != q['boot_id']:
        raise Refused('OBSERVATION_BOOT_CHANGED')
    _integer(observed['observed_at'], 0, 'OBSERVATION_TIME_INVALID')
    current = _now(now)
    if not q['observed_at'] <= observed['observed_at'] <= current or current - observed['observed_at'] > 30:
        raise Refused('OBSERVATION_STALE')
    if type(observed['targets']) is not dict or target not in observed['targets']:
        raise Refused('OBSERVATION_TARGET_MISSING')
    item = observed['targets'][target]
    _keys(item, IDENTITIES, 'OBSERVATION_IDENTITY_INVALID')
    for field in IDENTITIES:
        authority.hash_value(item[field], 'OBSERVATION_IDENTITY_INVALID')
        if item[field] != q['targets'][target][field]:
            raise Refused('OBSERVATION_IDENTITY_CHANGED')
    return authority.object_value(value['targets'][target])


def validate_migration(old_raw, new_raw, qualification, observation,
                       candidate_preflight, now=None):
    """Validate an exact next registry revision and reversible candidate check.

    Old enabled definitions need not equal candidate template hashes. Local
    qualification binds the candidate's fixed scope while its observations
    describe current installed state. The deployment journal must retain the
    exact old registry/implementation and restore them on positive failure.
    """
    old, new = _structure(old_raw), _structure(new_raw)
    if new['revision'] != old['revision'] + 1:
        raise Refused('REGISTRY_REVISION_NOT_NEXT')
    check = authority.object_value(candidate_preflight)
    _keys(check, ('old_registry_sha256', 'new_registry_sha256', 'validator_sha256',
                  'accepted', 'recovery_compatible'), 'CANDIDATE_PREFLIGHT_INVALID')
    authority.hash_value(check['validator_sha256'], 'CANDIDATE_PREFLIGHT_INVALID')
    if (check['old_registry_sha256'] != authority.digest(old)
            or check['new_registry_sha256'] != authority.digest(new)
            or check['accepted'] is not True or check['recovery_compatible'] is not True):
        raise Refused('CANDIDATE_PREFLIGHT_REFUSED')
    _qualification(new, qualification, now)
    for target, profile in new['targets'].items():
        if profile is not None:
            validate_effects(new, qualification, observation, target, now)
    return new
