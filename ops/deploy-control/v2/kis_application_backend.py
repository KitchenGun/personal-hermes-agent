"""Dedicated KIS directory publication inside ApplicationRelease's lifecycle.

Host qualification still owns leases, selectors, no-live gates, service facts,
health and ingress. This adapter owns neither service effects nor executable
source selection. Its only publication entry point requires the application's
PUBLISH phase and a freshly checked lifecycle observation callback.

The reviewed initial identity is an explicit trust anchor. Successive terminal
application journals form a predecessor/token chain, so a directory rollback
returning an earlier inode cannot create an ambiguous identity-history cycle.
No current bytes become an approved baseline merely because they were observed.
"""
import copy
import hashlib
from pathlib import Path
import re

import authority
import kis_checkout as storage

KIND = 'kis_checkout_v1'
TERMINAL = frozenset(('HELD_DEPLOYED', 'HELD_ROLLED_BACK'))


class Refused(RuntimeError):
    pass


def _require(value, code):
    if not value:
        raise Refused(code)


def _hash(value):
    return type(value) is str and authority.SHA256.fullmatch(value) is not None


def artifact(value):
    """Stable full-tree code identity; qualified mutable calendar bytes are separate."""
    commit = value.get('commit')
    _require(type(commit) is str and authority.SHA1.fullmatch(commit)
             and value.get('source') == storage.SOURCE, 'KIS_APP_SOURCE_IDENTITY_REFUSED')
    return {'schema': 1, 'kind': KIND, 'source': dict(storage.SOURCE), 'commit': commit,
            'tree': value['tree'], 'files': {name: {key: entry[key] for key in ('mode', 'object', 'size')}
                                             for name, entry in value['files'].items()}}


def identity(receipt):
    return {'directory': copy.deepcopy(receipt['directory']),
            'release_identity': authority.digest(artifact(receipt))}


def _valid_identity(value):
    return (type(value) is dict and set(value) == {'directory', 'release_identity'}
            and _hash(value['release_identity']) and type(value['directory']) is dict
            and set(value['directory']) == {'dev', 'ino'}
            and all(type(number) is int and number >= 0 for number in value['directory'].values()))


def validate_contract(value, profile):
    """Pure structural validation for the reviewed prebuilt application contract."""
    _require(type(value) is dict and set(value) == {'schema', 'kind', 'current', 'source',
                 'initial_commit', 'baseline', 'calendar'} and value['schema'] == 1
             and type(value['schema']) is int and value['kind'] == KIND
             and value['current'] == str(storage.DEPLOY_ROOT / 'managed-targets/kis/current')
             and value['source'] == storage.SOURCE and value['initial_commit'] == storage.INITIAL_COMMIT
             and profile['runtime']['workdir'] == value['current']
             and profile['repo'] == 'KIS' and profile['source']['prefix'] == '',
             'KIS_APP_CONTRACT_REFUSED')
    baseline, calendar = value['baseline'], value['calendar']
    _require(type(baseline) is dict and set(baseline) == {'kind', 'attempt', 'release_identity'}
             and baseline['kind'] == 'initial-transition'
             and re.fullmatch(r'[0-9a-f]{32}', str(baseline['attempt']))
             and _hash(baseline['release_identity']),
             'KIS_APP_INITIAL_BASELINE_REQUIRED')
    _require(type(calendar) is dict and set(calendar) == {'root', 'files'}
             and type(calendar['root']) is str and Path(calendar['root']).is_absolute()
             and Path(calendar['root']).resolve() == Path(calendar['root'])
             and Path(calendar['root']) != Path(value['current'])
             and type(calendar['files']) is list and 1 <= len(calendar['files']) <= 16
             and len(set(calendar['files'])) == len(calendar['files']), 'KIS_APP_CALENDAR_CONTRACT_REFUSED')
    for name in calendar['files']:
        storage._safe_name(name)
        _require(name.startswith('data/market_calendar/') and name.endswith('.json'),
                 'KIS_APP_CALENDAR_CONTRACT_REFUSED')
    mapping = profile['runtime']['owned_code_paths']
    _require(1 <= len(mapping) <= storage.MAX_FILES and all(path == value['current'] + '/' + name
             and re.fullmatch(r'kis_trading_lab/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+\.py', name)
             for name, path in mapping.items()), 'KIS_APP_OWNED_CODE_SCOPE_REFUSED')
    return value


def initial_authority(policy, baseline):
    """Resolve the plan through the already trusted immutable outer policy.

    The prebuilt app contract contains no descendant plan/observer digest, so
    compiling the initial bootstrap does not create a content-hash cycle.
    """
    import initial_recovery
    root, _, outer, _ = initial_recovery.load(policy)
    plan = initial_recovery.application_plan(policy, outer)
    _require(plan is not None and outer['application']['attempt'] == baseline['attempt'] == plan['attempt'],
             'KIS_APP_INITIAL_AUTHORITY_CHANGED')
    candidate = outer['candidate']
    registry_path = root / 'registries' / (candidate['registry_epoch'] + '-' + candidate['registry_sha256'] + '.json')
    raw = storage._read(registry_path, 1024 * 1024)
    _require(hashlib.sha256(raw).hexdigest() == candidate['registry_sha256'], 'KIS_APP_INITIAL_REGISTRY_CHANGED')
    registry = authority.object_value(raw, 1024 * 1024)
    contract_sha = registry.get('contracts', {}).get('applications')
    _require(_hash(contract_sha), 'KIS_APP_INITIAL_CONTRACT_REQUIRED')
    raw = storage._read(root / 'contracts' / (contract_sha + '.json'), 1024 * 1024)
    _require(hashlib.sha256(raw).hexdigest() == contract_sha, 'KIS_APP_INITIAL_CONTRACT_CHANGED')
    contract = authority.object_value(raw, 1024 * 1024)
    _require(contract.get('kis_checkout', {}).get('baseline') == baseline,
             'KIS_APP_INITIAL_BASELINE_CHANGED')
    return {'attempt': baseline['attempt'], 'plan_sha256': outer['application']['plan_sha256'],
            'application_contract_sha256': contract_sha}


class KISApplicationBackend:
    def __init__(self, checkout, journal_dir, baseline, *, contract_sha256, application_scope_sha256,
                 initial_authority=None):
        _require(isinstance(checkout, storage.KISCheckout), 'KIS_APP_STORAGE_REQUIRED')
        self.checkout, self.root = checkout, Path(journal_dir)
        _require(self.root.is_absolute() and self.root.resolve() == self.root
                 and checkout.root in self.root.parents and self.root != checkout.base
                 and checkout.base not in self.root.parents and self.root not in checkout.base.parents,
                 'KIS_APP_FIXED_JOURNAL_ROOT_REQUIRED')
        storage._identity(self.root)
        _require(type(baseline) is dict and _hash(contract_sha256) and _hash(application_scope_sha256),
                 'KIS_APP_REVIEWED_BASELINE_REQUIRED')
        self.initial_authority = initial_authority
        self.baseline_spec = copy.deepcopy(baseline)
        self.baseline = self._resolve_baseline(baseline)
        self.contract_sha256, self.scope_sha256 = contract_sha256, application_scope_sha256
        self.initial_token = authority.digest({'kind': KIND, 'baseline': baseline,
            'contract_sha256': contract_sha256, 'application_scope_sha256': application_scope_sha256})

    def _resolve_baseline(self, baseline):
        if baseline.get('kind') == 'qualified-existing':
            _require(set(baseline) == {'kind', 'identity'} and _valid_identity(baseline['identity']),
                     'KIS_APP_REVIEWED_BASELINE_REQUIRED')
            return copy.deepcopy(baseline['identity'])
        _require(set(baseline) == {'kind', 'attempt', 'release_identity'}
                 and baseline['kind'] == 'initial-transition'
                 and re.fullmatch(r'[0-9a-f]{32}', str(baseline['attempt']))
                 and _hash(baseline['release_identity']) and callable(self.initial_authority),
                 'KIS_APP_INITIAL_BASELINE_REQUIRED')
        approved = self.initial_authority(copy.deepcopy(baseline))
        _require(type(approved) is dict and set(approved) == {'attempt', 'plan_sha256', 'application_contract_sha256'}
                 and approved['attempt'] == baseline['attempt'] and _hash(approved['plan_sha256'])
                 and _hash(approved['application_contract_sha256']), 'KIS_APP_INITIAL_AUTHORITY_CHANGED')
        base = self.checkout.root / 'initial-application'
        saved, intent = storage._json(base / 'kis-checkout.json'), storage._json(base / 'intent.json')
        pins = saved.get('pins', {})
        _require(pins == intent.get('integration', {}).get('checkout')
                 and pins.get('kind') == 'initial-kis-checkout-v1'
                 and pins.get('attempt') == baseline['attempt'] == intent.get('attempt')
                 and pins.get('plan_sha256') == approved['plan_sha256'] == intent.get('plan_sha256')
                 and pins.get('initial_intent_sha256') == authority.digest({key: value for key, value in intent.items()
                                                                          if key != 'integration'})
                 and pins.get('commit') == storage.INITIAL_COMMIT and pins.get('source') == storage.SOURCE
                 and _valid_identity(pins.get('new_identity'))
                 and pins['new_identity']['release_identity'] == baseline['release_identity'],
                 'KIS_APP_INITIAL_BASELINE_CHANGED')
        record = self.checkout._load(baseline['attempt'])
        _require(record['state'] == 'PUBLISHED' and record['commit'] == storage.INITIAL_COMMIT
                 and record['old'] == pins.get('old_reference') and record['old']['commit'] is None
                 and identity(record['publish_intent']['after']) == pins['new_identity'],
                 'KIS_APP_INITIAL_PUBLICATION_UNPROVEN')
        return copy.deepcopy(pins['new_identity'])

    @property
    def binding(self):
        return {'kind': KIND, 'current': str(self.checkout.current)}

    def handles(self, binding):
        return (type(binding) is dict and binding.get('target') == 'KIS'
                and binding.get('publication') == self.binding)

    def validate_binding(self, binding, files=None):
        """Call after the lifecycle engine's common request/hold/unit checks."""
        _require(self.handles(binding) and binding.get('files') == {} and files in (None, {})
                 and binding.get('managed_ingress') is True
                 and binding.get('contract_sha256') == self.contract_sha256
                 and binding.get('application_scope_sha256') == self.scope_sha256,
                 'KIS_APP_BINDING_REFUSED')
        return True

    def candidate_identity(self, request):
        _require(request.get('target') == 'KIS' and request.get('repo') == 'KIS'
                 and authority.SHA1.fullmatch(str(request.get('sha', ''))), 'KIS_APP_REQUEST_REFUSED')
        return authority.digest(artifact(self.checkout.inspect(request['sha'])))

    def qualify(self, request, binding):
        self.validate_binding(binding, {})
        self.current_identity()
        if request.get('schema') == 2:
            self._local_source(request)
        else:
            _require(self.candidate_identity(request) == request.get('manifest_sha256'),
                     'KIS_APP_CANDIDATE_CHANGED')
        return {'binding': copy.deepcopy(binding), 'files': {}}

    def _records(self):
        result, total, count = {}, 0, 0
        for directory in self.root.iterdir():
            if directory.name.startswith('.'):
                continue
            self.checkout._remaining()
            count += 1
            _require(count <= 1024 and re.fullmatch(r'[A-Za-z0-9_-]{8,64}', directory.name),
                     'KIS_APP_HISTORY_BOUND')
            storage._identity(directory)
            raw = storage._read(directory / 'journal.json', 1024 * 1024)
            total += len(raw)
            _require(total <= 32 * 1024 * 1024, 'KIS_APP_HISTORY_BOUND')
            journal = authority.object_value(raw, 1024 * 1024)
            if journal.get('request', {}).get('target') != 'KIS':
                continue
            _require(journal.get('request', {}).get('id') == directory.name,
                     'KIS_APP_HISTORY_REQUEST_CHANGED')
            result[directory.name] = {'journal': journal, 'sha256': hashlib.sha256(raw).hexdigest()}
        return result

    @staticmethod
    def _token(publication):
        return authority.digest({key: publication[key] for key in
            ('kind', 'attempt_id', 'predecessor', 'operation', 'old_identity', 'new_identity')})

    def _descriptor(self, journal):
        self.validate_binding(journal.get('binding'))
        publication = journal.get('publication')
        _require(type(publication) is dict and set(publication) == {'kind', 'attempt_id', 'predecessor',
                 'operation', 'old_identity', 'new_identity', 'token', 'state'}
                 and publication['kind'] == KIND and publication['attempt_id'] == journal.get('attempt_id')
                 and re.fullmatch(r'[0-9a-f]{32}', str(publication['attempt_id']))
                 and _hash(publication['predecessor']) and _valid_identity(publication['old_identity'])
                 and _valid_identity(publication['new_identity'])
                 and publication['operation'] in ('deploy.apply', 'deploy.rollback', 'deploy.restart_service')
                 and publication['token'] == self._token(publication)
                 and journal.get('binding_digest') == authority.digest(journal['binding'])
                 and journal.get('old_release') == publication['old_identity']['release_identity']
                 and journal.get('new_release') == publication['new_identity']['release_identity'],
                 'KIS_APP_PUBLICATION_CHANGED')
        request, binding = journal['request'], journal['binding']
        local = request.get('schema') == 2
        expected_source = request.get('source') if local else {key: request.get(key)
                                                              for key in ('repo', 'sha', 'manifest_sha256')}
        expected_release = request.get('source', {}).get('release_identity') if local else request.get('manifest_sha256')
        _require(journal.get('schema') == 1 and binding.get('context') == journal.get('context')
                 and binding.get('request_id') == request.get('id') and request.get('target') == 'KIS'
                 and binding.get('source') == expected_source
                 and publication['operation'] == request.get('operation', 'deploy.apply')
                 and (not local or binding.get('operation') == request['operation'])
                 and publication['new_identity']['release_identity'] == expected_release,
                 'KIS_APP_REQUEST_PROVENANCE_CHANGED')
        return publication

    def _storage_record(self, publication):
        record = self.checkout._load(publication['attempt_id'])
        _require(record['state'] in ('STAGED', 'PUBLISHING', 'PUBLISHED', 'ROLLING_BACK', 'ROLLED_BACK'),
                 'KIS_APP_STORAGE_INCOMPLETE')
        if 'publish_intent' in record:
            old, new = record['publish_intent']['before'], record['publish_intent']['after']
        else:
            old = self.checkout._receipt(self.checkout.current, record['old'])
            new = self.checkout._receipt(self.checkout._attempt(record['attempt_id']) / 'candidate', record['new'])
        _require(identity(old) == publication['old_identity'] and identity(new) == publication['new_identity'],
                 'KIS_APP_STORAGE_IDENTITY_CHANGED')
        return record

    def _retained_proof(self, record):
        retained = self.checkout._attempt(record['attempt_id']) / 'candidate'
        rollback = record['state'] == 'ROLLED_BACK'
        receipt = self.checkout._receipt(retained, record['new' if rollback else 'old'])
        intent = record['rollback_intent' if rollback else 'publish_intent']
        self.checkout._validate(retained, receipt, exact_calendars=intent['before_calendars'])

    def _terminal(self, journal):
        publication = self._descriptor(journal)
        _require(journal.get('phase') == 'COMPLETE' and journal.get('files') == []
                 and journal.get('state') in TERMINAL,
                 'KIS_APP_TERMINAL_HISTORY_REFUSED')
        rollback = journal['state'] == 'HELD_ROLLED_BACK'
        final = publication['old_identity' if rollback else 'new_identity']
        _require(journal.get('rollback') is rollback and journal.get('committed_release') == final['release_identity'],
                 'KIS_APP_TERMINAL_COMMIT_CHANGED')
        if publication['operation'] == 'deploy.restart_service':
            _require(not rollback and publication['state'] == 'CURRENT'
                     and publication['old_identity'] == publication['new_identity']
                     and journal['request']['source']['baseline_sha256'] == authority.digest({
                         'token': publication['predecessor'], 'identity': publication['old_identity']}),
                     'KIS_APP_RESTART_CHANGED')
        else:
            record = self._storage_record(publication)
            _require(record['state'] == ('ROLLED_BACK' if rollback else 'PUBLISHED')
                     and publication['state'] == record['state'], 'KIS_APP_TERMINAL_STORAGE_CHANGED')
            if publication['operation'] == 'deploy.apply':
                _require(record['commit'] == journal['request']['sha'], 'KIS_APP_REQUEST_PROVENANCE_CHANGED')
            else:
                source = journal['request']['source']
                _require(re.fullmatch(r'[A-Za-z0-9_-]{8,64}', str(source.get('journal_id', ''))),
                         'KIS_APP_REQUEST_PROVENANCE_CHANGED')
                raw = storage._read(self.root / source['journal_id'] / 'journal.json', 1024 * 1024)
                origin = authority.object_value(raw, 1024 * 1024)
                _require(hashlib.sha256(raw).hexdigest() == source['journal_sha256']
                         and origin.get('publication', {}).get('attempt_id') ==
                         record.get('retained_from', {}).get('attempt_id'), 'KIS_APP_RETAINED_JOURNAL_CHANGED')
            self._retained_proof(record)
        return publication, final

    def accepted(self):
        """Approved terminal lineage only; unfinished publications never advance it."""
        _require(self._resolve_baseline(self.baseline_spec) == self.baseline, 'KIS_APP_INITIAL_BASELINE_CHANGED')
        pending = []
        records = self._records()
        for item in records.values():
            journal = item['journal']
            if journal.get('state') in TERMINAL:
                publication, final = self._terminal(journal)
                pending.append((publication, final))
        head, current = self.initial_token, copy.deepcopy(self.baseline)
        while pending:
            matches = [item for item in pending if item[0]['predecessor'] == head]
            _require(len(matches) == 1, 'KIS_APP_HISTORY_FORK_OR_GAP')
            publication, final = matches[0]
            _require(publication['old_identity'] == current, 'KIS_APP_HISTORY_BASELINE_CHANGED')
            pending.remove(matches[0])
            head, current = publication['token'], final
        return {'token': head, 'identity': current}

    def _live_record(self, record):
        """Read-only pending-swap reconciliation; no state writes from observation."""
        retained = self.checkout._attempt(record['attempt_id']) / 'candidate'
        state = record['state']
        if state in ('PUBLISHING', 'ROLLING_BACK'):
            intent = record['rollback_intent' if state == 'ROLLING_BACK' else 'publish_intent']
            before, after = intent['before'], intent['after']
            current_id, retained_id = storage._identity(self.checkout.current), storage._identity(retained)
            if current_id == before['directory'] and retained_id == after['directory']:
                live, other, calendars = before, after, intent['before_calendars']
            else:
                _require(current_id == after['directory'] and retained_id == before['directory'],
                         'KIS_APP_SWAP_OUTCOME_UNKNOWN')
                live, other, calendars = after, before, None
            self.checkout._receipt(self.checkout.current, self.checkout._reference(live))
            self.checkout._receipt(retained, self.checkout._reference(other))
            self.checkout._validate(self.checkout.current, live, exact_calendars=calendars)
            self.checkout._validate(retained, other, exact_calendars=(
                intent['before_calendars'] if other is before else None))
            _require(storage._json(self.checkout.base / 'current.json') in
                     (self.checkout._reference(before), self.checkout._reference(after)),
                     'KIS_APP_CURRENT_REFERENCE_CHANGED')
            return live
        reference = record['new'] if state == 'PUBLISHED' else record['old']
        _require(storage._json(self.checkout.base / 'current.json') == reference,
                 'KIS_APP_CURRENT_REFERENCE_CHANGED')
        live = self.checkout._receipt(self.checkout.current, reference)
        self.checkout._validate(self.checkout.current, live, mutable_calendar=True)
        if state == 'STAGED':
            staged = self.checkout._receipt(retained, record['new'])
            self.checkout._validate(retained, staged)
        else:
            self._retained_proof(record)
        return live

    def _current_receipt(self, active_journal=None):
        accepted = self.accepted()
        if active_journal is not None and active_journal.get('state') not in TERMINAL:
            publication = self._descriptor(active_journal)
            _require(publication['predecessor'] == accepted['token']
                     and publication['old_identity'] == accepted['identity'], 'KIS_APP_ACTIVE_BASELINE_CHANGED')
            if publication['operation'] != 'deploy.restart_service':
                return self._live_record(self._storage_record(publication))
        state = self.checkout.preflight()
        _require(state['state'] == 'OWNED', 'KIS_APP_INITIAL_CHECKOUT_REQUIRED')
        receipt = self.checkout._receipt(self.checkout.current, state['current'])
        current = identity(receipt)
        _require(current == accepted['identity'], 'KIS_APP_UNCOMMITTED_OR_EXTERNAL_CODE')
        return receipt

    def current_identity(self, active_journal=None):
        return identity(self._current_receipt(active_journal))

    def check(self, journal):
        publication = self._descriptor(journal)
        current = self.current_identity(journal)
        _require(current in (publication['old_identity'], publication['new_identity']),
                 'KIS_APP_ACTIVE_CODE_CHANGED')
        if journal['phase'] not in ('PUBLISH',):
            wanted = (publication['old_identity'] if publication['state'] in ('STAGED', 'ROLLED_BACK', 'CURRENT')
                      else publication['new_identity'])
            _require(current == wanted, 'KIS_APP_PUBLICATION_PHASE_CHANGED')
        return True

    def effective_strategy(self, active_journal=None):
        """Receipt-bound config of the currently executing managed directory."""
        receipt = self._current_receipt(active_journal)
        proof = self.checkout.strategy_flags(self.checkout.current, receipt)
        self.checkout._receipt(self.checkout.current, self.checkout._reference(receipt))
        return proof

    def _preimage(self, source, current):
        item = self._records().get(source.get('journal_id'))
        _require(item is not None and item['sha256'] == source.get('journal_sha256'),
                 'KIS_APP_RETAINED_JOURNAL_CHANGED')
        journal = item['journal']
        publication, final = self._terminal(journal)
        _require(journal['state'] == 'HELD_DEPLOYED' and publication['operation'] != 'deploy.restart_service'
                 and final == current and source.get('release_identity') == publication['old_identity']['release_identity'],
                 'KIS_APP_RETAINED_SOURCE_CHANGED')
        return publication

    def _local_source(self, request):
        _require(request.get('schema') == 2 and request.get('target') == 'KIS'
                 and request.get('operation') in ('deploy.rollback', 'deploy.restart_service'), 'KIS_APP_LOCAL_REQUEST_REFUSED')
        current, accepted = self.current_identity(), self.accepted()
        source = request['source']
        if request['operation'] == 'deploy.restart_service':
            _require(source == {'kind': 'verified-current', 'release_identity': current['release_identity'],
                'baseline_sha256': authority.digest(accepted)}, 'KIS_APP_LOCAL_BASELINE_CHANGED')
            return None
        _require(set(source) == {'kind', 'journal_id', 'journal_sha256', 'release_identity'}
                 and source['kind'] == 'retained-preimage', 'KIS_APP_LOCAL_REQUEST_REFUSED')
        return self._preimage(source, current)

    def local_request(self, job):
        _require(job.get('target') == 'KIS' and job.get('operation') in
                 ('deploy.rollback', 'deploy.restart_service')
                 and re.fullmatch(r'[A-Za-z0-9_-]{8,64}', str(job.get('request_id', ''))),
                 'KIS_APP_LOCAL_REQUEST_REFUSED')
        current = self.current_identity()
        if job['operation'] == 'deploy.restart_service':
            source = {'kind': 'verified-current', 'release_identity': current['release_identity'],
                      'baseline_sha256': authority.digest(self.accepted())}
        else:
            candidates = []
            for request_id, item in self._records().items():
                journal = item['journal']
                if journal.get('state') != 'HELD_DEPLOYED':
                    continue
                publication, final = self._terminal(journal)
                if publication['operation'] != 'deploy.restart_service' and final == current:
                    candidates.append({'kind': 'retained-preimage', 'journal_id': request_id,
                        'journal_sha256': item['sha256'],
                        'release_identity': publication['old_identity']['release_identity']})
            _require(len(candidates) == 1, 'KIS_APP_RETAINED_PREIMAGE_AMBIGUOUS')
            source = candidates[0]
        return {'schema': 2, 'id': job['request_id'], 'target': 'KIS', 'operation': job['operation'], 'source': source}

    def prepare(self, journal):
        """Called after durable PREPARING journal, before SUSPEND_WATCHERS."""
        _require(journal.get('phase') == 'PREPARING' and journal.get('files') == [], 'KIS_APP_PREPARATION_PHASE_REQUIRED')
        self.validate_binding(journal['binding'], {})
        accepted = self.accepted()
        current = self.current_identity()
        request = journal['request']
        operation = request.get('operation', 'deploy.apply')
        if request.get('schema') == 2:
            origin = self._local_source(request)
        else:
            origin = None
        if operation == 'deploy.restart_service':
            new, state = current, 'CURRENT'
        else:
            path = self.checkout._attempt(journal['attempt_id']) / 'journal.json'
            if path.exists():
                record = self.checkout._load(journal['attempt_id'])
                _require(record['state'] == 'STAGED', 'KIS_APP_PREPARATION_INCOMPLETE')
            elif operation == 'deploy.rollback':
                record = self.checkout.stage_retained(origin['attempt_id'], attempt_id=journal['attempt_id'])
            else:
                record = self.checkout.stage(request['sha'], attempt_id=journal['attempt_id'])
            old = self.checkout._receipt(self.checkout.current, record['old'])
            staged = self.checkout._receipt(self.checkout._attempt(record['attempt_id']) / 'candidate', record['new'])
            self.checkout._validate(self.checkout._attempt(record['attempt_id']) / 'candidate', staged)
            new = identity(staged)
            _require(identity(old) == current and new['release_identity'] ==
                     (request['source']['release_identity'] if operation == 'deploy.rollback' else request['manifest_sha256']),
                     'KIS_APP_PREPARED_SOURCE_CHANGED')
            if operation == 'deploy.rollback':
                _require(record.get('retained_from', {}).get('attempt_id') == origin['attempt_id'],
                         'KIS_APP_RETAINED_SOURCE_CHANGED')
            else:
                _require(record['commit'] == request['sha'], 'KIS_APP_PREPARED_SOURCE_CHANGED')
            state = 'STAGED'
        publication = {'kind': KIND, 'attempt_id': journal['attempt_id'], 'predecessor': accepted['token'],
                       'operation': operation, 'old_identity': current, 'new_identity': new, 'state': state}
        publication['token'] = self._token(publication)
        return {'publication': publication, 'old_release': current['release_identity'],
                'new_release': new['release_identity']}

    def publish(self, journal, observe_guard):
        """Only the application's stopped PUBLISH boundary may exchange directories."""
        _require(journal.get('phase') == 'PUBLISH' and 'committed_release' not in journal,
                 'KIS_APP_STOPPED_PUBLICATION_PHASE_REQUIRED')
        publication = copy.deepcopy(self._descriptor(journal))
        _require(publication['operation'] != 'deploy.restart_service', 'KIS_APP_RESTART_NEVER_PUBLISHES')
        self.check(journal)
        result = (self.checkout.rollback(journal['attempt_id'], observe_guard) if journal['rollback']
                  else self.checkout.publish(journal['attempt_id'], observe_guard))
        publication['state'] = result['state']
        _require(publication['state'] == ('ROLLED_BACK' if journal['rollback'] else 'PUBLISHED'),
                 'KIS_APP_PUBLICATION_INCOMPLETE')
        return {'publication': publication, 'phase': 'START_OLD' if journal['rollback'] else 'START_NEW'}
