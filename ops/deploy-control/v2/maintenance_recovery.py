"""Bounded same-source rebind after an ordinary API/relay process restart.

The caller owns engine, admission, controller-effects and application leases.
There are no code, service, network, timer or trading-state mutations here.
A previous valid OPEN and authoritative accepted code are mandatory. A fresh
process is never captured again during an unfinished attempt. Each idle tick
advances at most one durable phase; missing acknowledgements remain held.
"""
import copy
import math
import os
from pathlib import Path
import re
import time
import uuid

from application_host import _json, _read
from application_release import _atomic, _directory, digest
from maintenance_control import (MaintenanceControl, SOURCES, REQUIRED_PROVIDERS, MAX_INT,
                                 _control, _expected, _receipt)

PHASES = frozenset(('PREPARED', 'HELD', 'COMMITTED', 'OPEN_PUBLISHED', 'COMPLETE'))
CODES = frozenset(('IDLE', 'INITIAL_HELD', 'PREPARED', 'HELD', 'WAIT_HELD',
    'WAIT_QUIET', 'WAIT_HEALTH', 'WAIT_FRESH_TICK', 'COMMITTED', 'OPEN_PENDING',
    'OPEN_PARTIAL', 'COMPLETE', 'CONTROL_UNQUALIFIED', 'CONTROL_CHANGED',
    'SOURCE_CHANGED', 'IDENTITY_CHANGED', 'IDENTITY_UNQUALIFIED',
    'RECEIPT_UNQUALIFIED', 'JOURNAL_UNQUALIFIED', 'RECOVERY_UNCERTAIN', 'DEFERRED'))
FIELDS = frozenset(('schema', 'attempt_id', 'generation', 'phase', 'old_open',
    'old_open_sha256', 'identity', 'identity_sha256', 'expected_processes',
    'held_sequences', 'commit', 'open_control', 'code'))


class RecoveryRefused(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise RecoveryRefused(code)


def result(phase=None, code='IDLE'):
    return {'phase': phase, 'code': code, 'recoverable': phase not in (None, 'COMPLETE'),
            'same_source_only': True, 'code_changed': False, 'financial_activation': False}


class IdleMaintenanceRecovery:
    def __init__(self, root, host, *, clock=time.time, crash_hook=None, guard=None):
        self.root, self.host, self.clock = Path(root), host, clock
        self.path = self.root / 'application-maintenance' / 'idle-recovery.json'
        self.crash_hook = crash_hook or (lambda point: None)
        self.guard = guard or (lambda: None)
        self.bridge = MaintenanceControl(self.root, clock=clock, commit_verifier=self._verify_commit)

    @staticmethod
    def _marker(journal):
        return {'schema': 1, 'attempt_id': journal['attempt_id'], 'generation': journal['generation'],
                'old_open_sha256': journal['old_open_sha256'],
                'identity_sha256': journal['identity_sha256'],
                'processes_sha256': digest(journal['expected_processes']),
                'held_sequences': journal['held_sequences']}

    def _load(self):
        if not self.path.exists() and not self.path.is_symlink():
            return None
        journal = _json(_read(self.path, 1024 * 1024))
        require(set(journal) == FIELDS and type(journal['schema']) is int and journal['schema'] == 1
                and journal['phase'] in PHASES and journal['code'] in CODES
                and type(journal['attempt_id']) is str
                and re.fullmatch(r'idle-[0-9a-f]{32}', journal['attempt_id']) is not None,
                'JOURNAL_UNQUALIFIED')
        old = _control(journal['old_open'])
        require(old['state'] == 'OPEN' and digest(old) == journal['old_open_sha256']
                and type(journal['generation']) is int and journal['generation'] <= MAX_INT
                and journal['generation'] == old['generation'] + 1
                and type(journal['identity']) is dict
                and digest(journal['identity']) == journal['identity_sha256'], 'JOURNAL_UNQUALIFIED')
        expected = _expected(journal['expected_processes'])
        require(all('processInstanceId' in value for value in expected.values()), 'JOURNAL_UNQUALIFIED')
        require({name: {key: value for key, value in item.items() if key != 'processInstanceId'}
                 for name, item in expected.items()} == journal['identity'].get('expected_processes'),
                'JOURNAL_UNQUALIFIED')
        old_bindings = {value['sourceName']: value for value in old['bindings']}
        require(all(old_bindings[name]['sourceId'] == expected[name]['sourceId'] for name in SOURCES),
                'JOURNAL_UNQUALIFIED')
        sequences = journal['held_sequences']
        require(sequences is None or type(sequences) is dict and set(sequences) == set(SOURCES)
                and all(type(value) is int and value > 0 for value in sequences.values()), 'JOURNAL_UNQUALIFIED')
        committed = journal['phase'] in ('COMMITTED', 'OPEN_PUBLISHED', 'COMPLETE')
        require((committed and sequences is not None and journal['commit'] == self._marker(journal))
                or (not committed and journal['commit'] is None), 'JOURNAL_UNQUALIFIED')
        if journal['open_control'] is not None:
            opened = _control(journal['open_control'])
            require(committed and opened == self._wanted_control(journal, 'OPEN'), 'JOURNAL_UNQUALIFIED')
        require(journal['phase'] not in ('OPEN_PUBLISHED', 'COMPLETE')
                or journal['open_control'] is not None, 'JOURNAL_UNQUALIFIED')
        return journal

    def _save(self, journal, phase=None, code=None):
        self.guard()
        _directory(self.path.parent)
        # Re-read an existing destination before replacing it, rejecting links
        # and unsafe/foreign files rather than treating them as an empty state.
        if self.path.exists() or self.path.is_symlink():
            self._load()
        if phase is not None: journal['phase'] = phase
        if code is not None: journal['code'] = code
        _atomic(self.path, journal)

    @staticmethod
    def _wanted_control(journal, state):
        bindings = []
        if state == 'OPEN':
            bindings = [dict(sourceName=name, **{key: journal['expected_processes'][name][key]
                         for key in ('sourceId', 'processId', 'processInstanceId')}) for name in SOURCES]
        return {'schemaVersion': 1, 'state': state, 'attemptId': journal['attempt_id'],
                'generation': journal['generation'], 'bindings': bindings}

    def status(self):
        """Read-only fixed metadata. Never initializes a journal or transport."""
        try:
            journal = self._load()
            return result(journal['phase'], journal['code']) if journal else result()
        except Exception:
            return result(code='JOURNAL_UNQUALIFIED')

    def _identity(self):
        self.guard()
        require(Path(self.host.contract['maintenance']['root']) == self.root
                and self.host.root == self.root / 'application-transactions', 'IDENTITY_UNQUALIFIED')
        identity = self.host.idle_maintenance_identity()
        require(type(identity) is dict and identity.get('context') == self.host.context
                and identity.get('contract_sha256') == self.host.contract_sha256,
                'IDENTITY_UNQUALIFIED')
        _expected(identity['expected_processes'])
        return identity

    def _fresh_receipts(self, expected):
        """Validate raw startup receipts without accepting the obsolete OPEN PID.

        The bridge's ordinary observe intentionally refuses these receipts. Its
        exact same file, freshness, source and kernel-process checks apply here;
        this path only omits the obsolete control-generation/process binding.
        """
        with self.bridge._locked(readonly=True) as (_, directory):
            receipts = self.bridge._directory(directory, 'receipts')
            try:
                now = self.clock()
                require(type(now) in (int, float) and math.isfinite(now), 'RECEIPT_UNQUALIFIED')
                return {name: _receipt(self.bridge._read(receipts, name + '.json'), name,
                          expected[name], now, self.bridge._max_age, self.bridge._skew) for name in SOURCES}
            finally:
                os.close(receipts)

    @staticmethod
    def _providers(receipts):
        return all(set(receipts[name]['providers']) == REQUIRED_PROVIDERS[name]
                   and receipts[name]['providerHealthy'] is True
                   and receipts[name]['receiptHealthy'] is True for name in SOURCES)

    @staticmethod
    def _business_timers_quiet(receipts):
        providers = receipts['api']['providers']
        # The enabled API supervisor deliberately keeps its timer armed while
        # HELD; its callback is gate-denied and running/total remain zero. Relay
        # timers drive the required heartbeat. KIS must have no scheduled work.
        return providers['kis_scheduler']['timerPending'] is False

    def _same_identity(self, journal):
        require(self._identity() == journal['identity'], 'IDENTITY_CHANGED')

    def _verify_commit(self, attempt, generation):
        """The OPEN verifier re-reads exactly this durable same-code journal."""
        try:
            journal = self._load()
            require(journal is not None and journal['phase'] in ('COMMITTED', 'OPEN_PUBLISHED', 'COMPLETE')
                    and journal['attempt_id'] == attempt and journal['generation'] == generation
                    and journal['commit'] == self._marker(journal), 'JOURNAL_UNQUALIFIED')
            self._same_identity(journal)
            return True
        except Exception:
            return False

    def _health(self, journal):
        self._same_identity(journal)
        # This helper uses the normal independent cgroup/lock, KIS owner,
        # exact hold/flags, API health and relay READY/ACK observations.
        health = self.host.idle_maintenance_health()
        self._same_identity(journal)
        return health

    def _start(self, old, identity):
        require(old['state'] == 'OPEN' and old['generation'] < MAX_INT, 'CONTROL_CHANGED')
        expected = copy.deepcopy(identity['expected_processes'])
        bindings = {binding['sourceName']: binding for binding in old['bindings']}
        require(all(bindings[name]['sourceId'] == expected[name]['sourceId'] for name in SOURCES),
                'SOURCE_CHANGED')
        receipts = self._fresh_receipts(expected)
        require(self._providers(receipts), 'RECEIPT_UNQUALIFIED')
        changed = False
        for name in SOURCES:
            receipt, previous = receipts[name], bindings[name]
            expected[name]['processInstanceId'] = receipt['processInstanceId']
            same = all(receipt[key] == previous[key] for key in ('sourceId', 'processId', 'processInstanceId'))
            if same:
                require(receipt['attemptId'] == old['attemptId'] and receipt['generation'] == old['generation']
                        and receipt['state'] == 'OPEN' and receipt['blockedReason'] is None, 'RECEIPT_UNQUALIFIED')
            else:
                changed = True
                require(receipt['state'] == 'HELD'
                        and receipt['blockedReason'] in ('STARTUP_HELD', 'FOREIGN_BINDING', 'MISSING_HELD_GENERATION')
                        and ((receipt['attemptId'] is None and receipt['generation'] == 0)
                             or (receipt['attemptId'] == old['attemptId'] and receipt['generation'] == old['generation'])),
                        'RECEIPT_UNQUALIFIED')
        if not changed:
            return result(code='IDLE')
        require(self._identity() == identity, 'IDENTITY_CHANGED')
        require(self.bridge.observe_control().get('control') == old, 'CONTROL_CHANGED')
        journal = {'schema': 1, 'attempt_id': 'idle-' + uuid.uuid4().hex,
            'generation': old['generation'] + 1, 'phase': 'PREPARED',
            'old_open': old, 'old_open_sha256': digest(old),
            'identity': identity, 'identity_sha256': digest(identity),
            'expected_processes': expected, 'held_sequences': None, 'commit': None,
            'open_control': None, 'code': 'PREPARED'}
        self._save(journal)
        self.crash_hook('after_idle_prepare')
        return result('PREPARED', 'PREPARED')

    def step(self):
        journal = None
        try:
            self.guard()
            journal = self._load()
            observed = self.bridge.observe_control()
            require(observed.get('ok') is True, 'CONTROL_UNQUALIFIED')
            control = observed['control']
            if journal is None or journal['phase'] == 'COMPLETE':
                if control['state'] != 'OPEN':
                    return result(code='INITIAL_HELD' if journal is None else 'CONTROL_CHANGED')
                return self._start(control, self._identity())
            self._same_identity(journal)
            held, opened = self._wanted_control(journal, 'HELD'), self._wanted_control(journal, 'OPEN')
            if journal['phase'] == 'PREPARED':
                if control == journal['old_open']:
                    fresh = self._fresh_receipts(journal['expected_processes'])
                    require(self._providers(fresh), 'RECEIPT_UNQUALIFIED')
                    self.guard()
                    observed = self.bridge.request_hold(journal['attempt_id'])
                    self.crash_hook('after_idle_hold_publication')
                    require(observed.get('ok') is True and observed['control'] == held, 'RECOVERY_UNCERTAIN')
                else:
                    require(control == held, 'CONTROL_CHANGED')
                self._save(journal, 'HELD', 'HELD')
                return result('HELD', 'HELD')
            require(control in (held, opened), 'CONTROL_CHANGED')
            require(control != opened or journal['commit'] is not None, 'CONTROL_CHANGED')
            observed = self.bridge.observe(journal['expected_processes'])
            if observed.get('ok') is not True:
                code = 'OPEN_PENDING' if control == opened else 'WAIT_HELD'
                self._save(journal, code=code)
                return result(journal['phase'], code)
            require(self._providers(observed['receipts']), 'RECEIPT_UNQUALIFIED')
            if journal['commit'] is not None:
                require(all(observed['receipts'][name]['receiptSequence'] >= journal['held_sequences'][name]
                            for name in SOURCES), 'RECEIPT_UNQUALIFIED')
            if control == opened:
                journal['open_control'] = opened
                code = {'OPEN': 'COMPLETE', 'PARTIAL': 'OPEN_PARTIAL', 'PENDING': 'OPEN_PENDING'}[observed['reopenStatus']]
                if code == 'COMPLETE' and self._health(journal)['healthy'] is not True:
                    code = 'WAIT_HEALTH'
                self._save(journal, 'COMPLETE' if code == 'COMPLETE' else 'OPEN_PUBLISHED', code)
                return result(journal['phase'], code)
            if not observed['drained'] or not self._business_timers_quiet(observed['receipts']):
                self._save(journal, code='WAIT_QUIET')
                return result(journal['phase'], 'WAIT_QUIET')
            health = self._health(journal)
            if health['quiet'] is not True or health['healthy'] is not True:
                code = 'WAIT_QUIET' if health['quiet'] is not True else 'WAIT_HEALTH'
                self._save(journal, code=code)
                return result(journal['phase'], code)
            sequences = {name: receipt['receiptSequence'] for name, receipt in observed['receipts'].items()}
            if journal['phase'] == 'HELD':
                if journal['held_sequences'] is None:
                    journal['held_sequences'] = sequences
                    self._save(journal, code='WAIT_FRESH_TICK')
                    return result('HELD', 'WAIT_FRESH_TICK')
                if not all(sequences[name] > journal['held_sequences'][name] for name in SOURCES):
                    return result('HELD', 'WAIT_FRESH_TICK')
                journal['held_sequences'] = sequences
                journal['commit'] = self._marker(journal)
                self._save(journal, 'COMMITTED', 'COMMITTED')
                self.crash_hook('after_idle_commit')
                return result('COMMITTED', 'COMMITTED')
            require(journal['phase'] == 'COMMITTED', 'CONTROL_CHANGED')
            self.guard()
            observed = self.bridge.request_open(journal['attempt_id'], journal['generation'], journal['expected_processes'])
            self.crash_hook('after_idle_open_publication')
            if observed.get('committedOpen') is True:
                require(observed['control'] == opened, 'CONTROL_CHANGED')
                journal['open_control'] = opened
                self._save(journal, 'OPEN_PUBLISHED', 'OPEN_PENDING')
                return result('OPEN_PUBLISHED', 'OPEN_PENDING')
            self._save(journal, code='WAIT_HELD')
            return result(journal['phase'], 'WAIT_HELD')
        except Exception as error:
            code = str(error) if isinstance(error, RecoveryRefused) and str(error) in CODES else 'RECOVERY_UNCERTAIN'
            # Never overwrite a malformed journal. A valid in-progress attempt
            # records a fixed reason, without replacing its captured authority.
            if journal is not None:
                try: self._save(journal, code=code)
                except Exception: pass
            return result(journal['phase'] if journal else None, code)
