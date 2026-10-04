"""V2 request admission/outbox only; effects run in the independent updater.

A held admission gate performs no authentication, GitHub polling, request-ledger
opening, admission or outbox writes. Heartbeats describe code liveness separately
from successful GitHub checks. An uncertain POST is reconciled, never replayed.
"""
import contextlib
import fcntl
import json
import math
import os
from pathlib import Path
import re
import stat
import threading
import time

import authority
from github_transport import GitHub, RemoteError
from store import Store, Busy, Conflict, TERMINAL

WORKER_VERSION = 2
RESULT_PREFIX = 'DEPLOY_CONTROL_RESULT_V2 '
LEDGER_NAME = 'control-v2.sqlite3'
HEARTBEAT_SECONDS = 5
POLL_SECONDS = 15
MAX_BACKOFF_SECONDS = 300
DELIVERY_SECONDS = 45
CONTROLLER_MUTATIONS = frozenset(('deploy.update_self', 'deploy.migrate_registry',
                                  'deploy.test_recovery', 'deploy.rollback', 'deploy.restart_service'))
CONTROLLER_BUSY_REASON = 'CONTROLLER_MUTATION_PENDING'


class WorkerRefused(RuntimeError):
    pass


def _root(policy):
    value = policy.get('root')
    if not isinstance(value, str):
        raise WorkerRefused('FIXED_ROOT_REQUIRED')
    root = Path(value)
    if not root.is_absolute() or root.resolve() != root:
        raise WorkerRefused('FIXED_ROOT_REQUIRED')
    try:
        identity = root.lstat()
    except OSError:
        raise WorkerRefused('FIXED_ROOT_UNAVAILABLE') from None
    if (not stat.S_ISDIR(identity.st_mode) or identity.st_uid != os.getuid()
            or identity.st_mode & 0o022):
        raise WorkerRefused('FIXED_ROOT_OWNERSHIP_REFUSED')
    return root


def validate_policy(policy):
    """Adapt unchanged v1 transport keys to the anchored v2 identity tuple."""
    if type(policy) is not dict or type(policy.get('control')) is not dict:
        raise WorkerRefused('FIXED_POLICY_REQUIRED')
    control = policy['control']
    if set(control) != {'repo', 'repo_id', 'issue', 'author'}:
        raise WorkerRefused('CONTROL_POLICY_FIELDS_REFUSED')
    authority.validate_control({'repo': control['repo'], 'id': control['repo_id'],
                                'issue': control['issue'], 'author': control['author']})
    definitions = policy.get('repos')
    if type(definitions) is not dict or set(definitions) != set(authority.REPOSITORIES):
        raise WorkerRefused('REPOSITORY_POLICY_REFUSED')
    for alias, definition in definitions.items():
        if type(definition) is not dict or set(definition) != {'repo', 'id', 'branch', 'private'}:
            raise WorkerRefused('REPOSITORY_POLICY_FIELDS_REFUSED')
        authority.validate_repository(alias, {key: definition[key] for key in ('repo', 'id', 'branch')})
        if type(definition['private']) is not bool:
            raise WorkerRefused('REPOSITORY_VISIBILITY_REQUIRED')
    return _root(policy)


def ledger_path(root):
    """Do not follow a replaced main database, WAL or shared-memory pathname."""
    path = Path(root) / LEDGER_NAME
    for suffix in ('', '-wal', '-shm'):
        candidate = Path(str(path) + suffix)
        try:
            identity = candidate.lstat()
        except FileNotFoundError:
            continue
        if (not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid()
                or identity.st_nlink != 1 or identity.st_mode & 0o022):
            raise WorkerRefused('LEDGER_FILE_IDENTITY_REFUSED')
    return path


@contextlib.contextmanager
def _lock(path, nonblocking=True):
    descriptor = os.open(os.fspath(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        identity = os.fstat(descriptor)
        if (not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid()
                or identity.st_nlink != 1 or identity.st_mode & 0o022):
            raise WorkerRefused('LOCK_IDENTITY_REFUSED')
        flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
        fcntl.flock(descriptor, flags)
        yield
    finally:
        os.close(descriptor)


def _recovery_test_pass(job):
    """Render PASS only from the dispatcher's journal-backed recovery evidence."""
    if (job.get('operation') != 'deploy.test_recovery' or job.get('target') != 'DEPLOY_WORKER'
            or job.get('state') != 'ROLLED_BACK' or type(job.get('result')) is not dict):
        return False
    evidence = job['result'].get('recovery_test')
    if (type(evidence) is not dict or evidence.get('fault_invocation_verified') is not True
            or evidence.get('old_health_restored') is not True):
        return False
    for name in ('attempt_id', 'candidate_invocation_id', 'restored_invocation_id'):
        if not isinstance(evidence.get(name), str) or not re.fullmatch(r'[0-9a-f]{32}', evidence[name]):
            return False
    return evidence['candidate_invocation_id'] != evidence['restored_invocation_id']


def result_body(job):
    status = job['state']
    result = {'state': status, 'operation': job['operation'], 'target': job['target'],
              'result': job['result']}
    if job['operation'] == 'deploy.update_self' and status == 'SUCCEEDED':
        result['SELF_UPDATE'] = 'PASS'
    if job['operation'] == 'deploy.update_self' and status == 'ROLLED_BACK':
        result['AUTO_ROLLBACK'] = 'PASS'
    if _recovery_test_pass(job):
        result['AUTO_ROLLBACK'] = 'PASS'
    if status == 'MANUAL_RECOVERY_REQUIRED':
        result['MANUAL_RECOVERY_REQUIRED'] = 'YES'
    body = RESULT_PREFIX + job['request_id'] + '\n' + json.dumps(result, sort_keys=True, separators=(',', ':'))
    if len(body.encode('utf-8')) > 16384:
        result = {'state': status, 'operation': job['operation'], 'target': job['target'],
                  'result': 'DETAILS_RETAINED_IN_LOCAL_JOURNAL'}
        body = RESULT_PREFIX + job['request_id'] + '\n' + json.dumps(result, sort_keys=True, separators=(',', ':'))
    return body


def _deliver_results(store, github, bot_id, enabled):
    for job in store.jobs(include_terminal=True):
        if not enabled():
            return
        if job['state'] in TERMINAL:
            marker = RESULT_PREFIX + job['request_id'] + '\n'
            body = result_body(job)
            if not enabled():
                return
            store.enqueue_outbox('terminal:' + job['request_id'], job['request_id'], body, marker)
    pending = store.outbox_pending()
    if not pending or not enabled():
        return
    comments = github.comments()
    for item in pending[:10]:
        if not enabled():
            return
        matches = [comment for comment in comments
                   if type(comment) is dict and type(comment.get('user')) is dict
                   and type(comment['user'].get('id')) is int and comment['user']['id'] == bot_id
                   and isinstance(comment.get('body'), str)
                   and comment['body'] == item['body'] and type(comment.get('id')) is int
                   and comment['id'] > 0]
        if matches:
            if item['state'] == 'PENDING':
                if not enabled():
                    return
                store.outbox_uncertain(item['item_key'])
            if not enabled():
                return
            store.outbox_delivered(item['item_key'], str(matches[-1]['id']))
            continue
        if item['state'] == 'UNCERTAIN':
            continue
        if not enabled():
            return
        store.outbox_uncertain(item['item_key'])
        if not enabled():
            return
        result = github.post(item['body'])
        if type(result) is not dict or type(result.get('id')) is not int or result['id'] <= 0:
            raise RemoteError('RESULT_POST_ID_INVALID')
        if not enabled():
            return
        store.outbox_delivered(item['item_key'], str(result['id']))


def deliver_results(store, github, bot_id, enabled=lambda: True, engine_locked=False):
    if type(bot_id) is not int or bot_id <= 0:
        raise WorkerRefused('RESULT_AUTHOR_ID_REQUIRED')
    if not enabled():
        return
    try:
        # No migration can capture its ledger fingerprint during an outbox
        # mutation. Post-dispatch delivery already holds this same engine lock.
        with contextlib.nullcontext() if engine_locked else store.engine_lock():
            if not enabled():
                return
            with _lock(store.path + '.outbox.lock'):
                _deliver_results(store, github, bot_id, enabled)
    except (BlockingIOError, Busy):
        return


def deliver_after_dispatch(store, context, github_factory=GitHub, monotonic=time.monotonic):
    """Deliver after recovery, only outside a nonterminal migration barrier.

    The anchored context supplies a fresh delivery_allowed predicate and a
    deadline-aware auth_reader. Authentication, preflight and all HTTP calls
    share the same 45-second total budget, clamped to the invocation deadline.
    A transport failure leaves durable results pending/uncertain for next time.
    """
    allowed = getattr(context, 'delivery_allowed', None)
    auth = getattr(context, 'auth_reader', None)
    if not callable(allowed) or not callable(auth):
        return False
    deadline = monotonic() + DELIVERY_SECONDS
    invocation_deadline = getattr(context, 'invocation_deadline', None)
    if invocation_deadline is not None:
        if (isinstance(invocation_deadline, bool) or not isinstance(invocation_deadline, (int, float))
                or not math.isfinite(invocation_deadline)):
            return False
        deadline = min(deadline, invocation_deadline)
    def enabled():
        if monotonic() >= deadline:
            return False
        return allowed() is True and monotonic() < deadline
    try:
        with store.engine_lock():
            if not enabled():
                return False
            # Do not authenticate unless some terminal receipt still needs to
            # be enqueued, posted or reconciled. These are read-only queries.
            due = bool(store.outbox_pending())
            if not due:
                due = any(job['state'] in TERMINAL and
                          store.outbox_item('terminal:' + job['request_id']) is None
                          for job in store.jobs(include_terminal=True))
            if not due or not enabled():
                return False
            token = auth(deadline=deadline)
            if not isinstance(token, str) or not token or not enabled():
                return False
            github = github_factory(token, context.policy, deadline=deadline)
            bot_id = github.preflight()
            if not enabled():
                return False
            deliver_results(store, github, bot_id, enabled, engine_locked=True)
            if not enabled() or store.outbox_pending():
                return False
            return all(store.outbox_item('terminal:' + job['request_id']) is not None
                       for job in store.jobs(include_terminal=True) if job['state'] in TERMINAL)
    except (RemoteError, OSError, TimeoutError, Busy):
        return False


def _controller_mutation(request):
    return request['target'] == 'DEPLOY_WORKER' and request['operation'] in CONTROLLER_MUTATIONS


def _accept_request(store, request, comment_id, enabled):
    # Acceptance and the busy terminal receipt are indivisible to the effects
    # dispatcher. If it currently owns the lock, the comment remains available
    # for the next poll instead of entering a half-classified queue state.
    with store.engine_lock():
        if not enabled():
            return False
        if not _controller_mutation(request):
            return store.accept(request['id'], authority.digest(request), comment_id, request)[1]
        pending = any(_controller_mutation(job) and job['request_id'] != request['id']
                      for job in store.jobs())
        job, created = store.accept(request['id'], authority.digest(request), comment_id, request)
        if created and pending:
            store.finish(request['id'], 'BLOCKED', {'reason': CONTROLLER_BUSY_REASON,
                                                   'financial_activation': False})
        return created


def admit_cycle(store, github, now, enabled=lambda: True):
    if not enabled():
        return False
    admitted = False
    for comment in github.comments():
        if not enabled():
            break
        try:
            request = authority.admit_comment(comment, now)
            if request is None:
                continue
            if type(comment.get('id')) is not int or comment['id'] <= 0:
                raise authority.Refused('COMMENT_ID_INVALID')
            if not enabled():
                break
            created = _accept_request(store, request, comment['id'], enabled)
            admitted = admitted or created
        except (authority.Refused, Conflict, Busy):
            continue
    return admitted


class Heartbeat:
    """A blocked auth/transport request cannot suppress process-liveness pulses."""
    def __init__(self, callback, interval=HEARTBEAT_SECONDS):
        self.callback, self.interval = callback, interval
        self.status = 'code-ready'
        self.stopped = threading.Event()
        self.thread = None

    def emit(self):
        try:
            self.callback(self.status)
        except Exception:
            # A receipt write failure cannot turn into a misleading receipt.
            # The independent verifier will observe the missing heartbeat.
            pass

    def start(self):
        self.emit()
        def pulse():
            while not self.stopped.wait(self.interval):
                self.emit()
        self.thread = threading.Thread(target=pulse, name='deploy-v2-heartbeat', daemon=True)
        self.thread.start()

    def close(self):
        self.stopped.set()
        if self.thread is not None:
            self.thread.join(timeout=1)


class Worker:
    def __init__(self, context, github_factory=GitHub, store_factory=Store, clock=time.time):
        self.context, self.clock = context, clock
        self.root = validate_policy(context.policy)
        for name in ('auth_reader', 'admission_enabled', 'heartbeat', 'trigger_updater'):
            if not callable(getattr(context, name, None)):
                raise WorkerRefused('CONTEXT_CALLBACK_REQUIRED_' + name.upper())
        self.github_factory, self.store_factory = github_factory, store_factory
        self.store, self.github, self.bot_id = None, None, None

    def close(self):
        if self.store is not None:
            self.store.close()
            self.store = None

    def cycle(self):
        enabled = self.context.admission_enabled
        if enabled() is not True:
            return 'code-ready'
        if self.store is None:
            self.store = self.store_factory(str(ledger_path(self.root)))
        if self.github is None:
            token = self.context.auth_reader()
            if not isinstance(token, str) or not token:
                raise RemoteError('AUTH_UNAVAILABLE')
            if enabled() is not True:
                return 'code-ready'
            self.github = self.github_factory(token, self.context.policy)
        if enabled() is not True:
            return 'code-ready'
        identity = self.github.preflight()
        if type(identity) is not int or identity <= 0:
            raise RemoteError('AUTH_IDENTITY_INVALID')
        if self.bot_id is not None and identity != self.bot_id:
            raise RemoteError('AUTH_IDENTITY_CHANGED')
        self.bot_id = identity
        if enabled() is not True:
            return 'code-ready'
        admitted = admit_cycle(self.store, self.github, self.clock(), lambda: enabled() is True)
        if enabled() is True and (admitted or self.store.jobs()):
            try:
                # Kernel/context owns the one fixed updater unit. The worker
                # never constructs a service name or runs an effect dispatcher.
                self.context.trigger_updater()
            except (OSError, TimeoutError):
                pass  # The independent timer can still recover pending jobs.
        if enabled() is not True:
            return 'code-ready'
        deliver_results(self.store, self.github, self.bot_id, lambda: enabled() is True)
        return 'healthy' if enabled() is True else 'code-ready'


def run(context, stop_event=None, max_cycles=None, github_factory=GitHub,
        store_factory=Store, clock=time.time, heartbeat_interval=HEARTBEAT_SECONDS):
    """Production entrypoint; optional finite loop/factories are local test seams."""
    stopped = stop_event or threading.Event()
    worker = Worker(context, github_factory, store_factory, clock)
    delay, cycles = POLL_SECONDS, 0
    with _lock(worker.root / 'request-worker-v2.lock'):
        def report(status):
            # A migration may close admission while a network call is blocked.
            # Do not keep emitting an earlier operational-health status.
            if context.admission_enabled() is not True:
                status = 'code-ready'
            context.heartbeat(status)
        pulse = Heartbeat(report, heartbeat_interval)
        pulse.start()
        try:
            while not stopped.is_set() and (max_cycles is None or cycles < max_cycles):
                try:
                    pulse.status = worker.cycle()
                    delay = POLL_SECONDS
                except (RemoteError, OSError, TimeoutError):
                    pulse.status = 'code-ready'
                    delay = min(MAX_BACKOFF_SECONDS, delay * 2)
                pulse.emit()
                cycles += 1
                if max_cycles is not None and cycles >= max_cycles:
                    break
                stopped.wait(delay)
        finally:
            pulse.close()
            worker.close()
