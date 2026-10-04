"""Fixed-KIS, independently owned exact-commit checkouts.

This is a storage backend, not a service controller. Only ApplicationRelease's
stopped, independently quiet, exact-held lifecycle may call publish/rollback.
The caller supplies an approved Sources.verify function; this module neither
loads credentials nor accepts repository, destination, command or calendar paths
from a deployment request. The existing checkout is never changed or chmodded.

Directory exchanges use Linux renameat2(RENAME_EXCHANGE) with no fallback. The
old checkout and every journal are retained. Same-UID locks are coordination,
not a security boundary against hostile code running as that same UID.
"""
import contextlib
import ctypes
import fcntl
import hashlib
import math
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import time
import uuid

import authority

DEPLOY_ROOT = Path('/home/ubuntu/.local/share/hermes-deploy-worker')
INITIAL_COMMIT = '6a4d067f8757a17c25de74d0dfff141f8cf2e3ad'
MAX_FILES, MAX_FILE, MAX_TOTAL = 1024, 2 * 1024 * 1024, 32 * 1024 * 1024
MAX_GIT_OUTPUT = 2 * 1024 * 1024
MAX_COMMIT = 1024 * 1024
MAX_METADATA = 8 * 1024 * 1024
RECOVERY_RESERVE = 15
RECEIPT = '.kis-checkout.json'
STRATEGY_FILE = 'config/adaptive_ai_dry_run_strategy_v1.json'
MAX_STRATEGY = 256 * 1024
STRATEGY_FLAGS = frozenset(('order_api_allowed', 'prod_orders_allowed', 'vps_live_orders_allowed',
                            'retry', 'catch_up', 'backfill'))
HOLD_REASON = 'operator_prod_transition_preparation'
QUIET_KEYS = frozenset(('pending_recovery', 'node_work', 'python_work',
                        'active_runs', 'writer_locks', 'other_work'))
SERVICES = frozenset(('codex-control-api.service', 'codex-discord-relay.service'))
WATCHERS = frozenset(('codex-control-api-healthcheck.timer', 'codex-control-api-healthcheck.service'))
TASKS = frozenset(('kis-ai-market-open-supervisor-v1', 'kis-ai-intraday-shadow-validation-v1',
                  'kis-ai-post-close-learning-v1', 'kis-ai-daily-learning-report-v1',
                  'kis-vps-model-v3-autonomous-pilot-v1'))
SOURCE = {'alias': 'KIS', **dict(authority.REPOSITORIES['KIS'])}


class Refused(RuntimeError):
    """Constant reason codes only; never include Git stderr or private bytes."""


def _require(value, code):
    if not value:
        raise Refused(code)


def _encode(value):
    return authority.encoded(value)


def _digest(value):
    return hashlib.sha256(_encode(value)).hexdigest()


def _sha(value):
    _require(type(value) is str and authority.SHA1.fullmatch(value), 'KIS_EXACT_SHA_REQUIRED')
    return value


def _identity(path):
    facts = path.lstat()
    _require(stat.S_ISDIR(facts.st_mode) and facts.st_uid == os.getuid()
             and not facts.st_mode & 0o7077 and path.resolve() == path,
             'KIS_OWNED_DIRECTORY_REQUIRED')
    return {'dev': facts.st_dev, 'ino': facts.st_ino}


def _parent(path):
    facts = path.lstat()
    _require(stat.S_ISDIR(facts.st_mode) and facts.st_uid == os.getuid()
             and not facts.st_mode & 0o7022 and path.resolve() == path,
             'KIS_PARENT_DIRECTORY_REFUSED')


def _calendar_parent(path):
    """Qualified input data may be group-writable; code destinations may not."""
    facts = path.lstat()
    _require(stat.S_ISDIR(facts.st_mode) and facts.st_uid == os.getuid()
             and not facts.st_mode & 0o7002 and path.resolve() == path,
             'KIS_CALENDAR_DIRECTORY_REFUSED')
    return {'dev': facts.st_dev, 'ino': facts.st_ino, 'mode': stat.S_IMODE(facts.st_mode),
            'uid': facts.st_uid, 'gid': facts.st_gid}


def _sync(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def file_identity(path):
    facts = path.lstat()
    return [facts.st_dev, facts.st_ino, facts.st_mode, facts.st_uid, facts.st_gid,
            facts.st_size, facts.st_mtime_ns, facts.st_ctime_ns]


def _read(path, maximum=MAX_FILE, private=True, calendar=False):
    try:
        _require(path.is_absolute() and path.resolve() == path, 'KIS_FILE_PATH_REFUSED')
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            _require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                     and before.st_nlink == 1
                     and not before.st_mode & (0o7002 if calendar else 0o7077 if private else 0o7022)
                     and 0 <= before.st_size <= maximum, 'KIS_FILE_CONTROL_REFUSED')
            raw = stream.read(maximum + 1)
            after = os.fstat(stream.fileno())
        signature = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid,
                              s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        _require(len(raw) <= maximum and signature(before) == signature(after)
                 == signature(path.lstat()), 'KIS_FILE_CHANGED')
        return raw
    except Refused:
        raise
    except OSError:
        raise Refused('KIS_FILE_UNAVAILABLE') from None


def _write(path, raw, mode=0o600, replace=False):
    _identity(path.parent)
    destination = path.parent / ('.write-' + uuid.uuid4().hex) if replace else path
    fd = os.open(str(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    if replace:
        os.replace(str(destination), str(path))
    _sync(path.parent)


def _json(path):
    try:
        return authority.object_value(_read(path, MAX_METADATA), MAX_METADATA)
    except (ValueError, TypeError):
        raise Refused('KIS_METADATA_REFUSED') from None


def _safe_name(name):
    _require(type(name) is str and 1 <= len(name) <= 240 and len(name.split('/')) <= 16
             and all(re.fullmatch(r'[A-Za-z0-9_.@+=-]{1,120}', part)
                     and part not in ('.', '..') and part.lower() != '.git'
                     for part in name.split('/'))
             and name != RECEIPT, 'KIS_TREE_PATH_REFUSED')
    for part in name.split('/'):
        lower = part.lower()
        _require(not (lower == '.env' or lower.startswith('.env.') and lower != '.env.example'
                      or lower in ('id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519')
                      or lower.endswith(('.p12', '.pfx', '.key'))), 'KIS_PRIVATE_FILE_REFUSED')
    return name


def _private_key(raw):
    # Mentioning a key marker in documentation/tests is not a private key.
    blocks = re.finditer(rb'-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----'
                         rb'(.*?)-----END \1-----', raw, re.DOTALL)
    return any(sum(len(line) for line in match.group(2).splitlines()
                   if re.fullmatch(rb'[A-Za-z0-9+/=]{32,}', line)) >= 64 for match in blocks)


def _strategy_flags(raw):
    """The wrapper's fixed relative config must preserve all six safety gates."""
    try:
        value = authority.object_value(raw, MAX_STRATEGY)
    except Exception:
        raise Refused('KIS_STRATEGY_JSON_REFUSED') from None
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop(); count += 1
        _require(depth <= 32 and count <= 32768, 'KIS_STRATEGY_JSON_BOUND')
        if type(item) is dict: pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list: pending.extend((child, depth + 1) for child in item)
        elif type(item) is float: _require(math.isfinite(item), 'KIS_STRATEGY_JSON_REFUSED')
    _require(STRATEGY_FLAGS <= set(value) and all(value[name] is False for name in STRATEGY_FLAGS),
             'KIS_STRATEGY_FLAGS_REQUIRED')
    return {name: value[name] for name in sorted(STRATEGY_FLAGS)}


class GitRunner:
    """No inherited environment, user config, hooks, credentials or network."""
    def __init__(self, *, deadline=None, monotonic=time.monotonic):
        self.monotonic = monotonic
        self.deadline = monotonic() + 120 if deadline is None else deadline
        _require(type(self.deadline) in (int, float) and math.isfinite(self.deadline),
                 'KIS_FINITE_DEADLINE_REQUIRED')

    def __call__(self, arguments, *, maximum=MAX_FILE, timeout=60):
        _require(type(maximum) is int and 0 <= maximum <= MAX_GIT_OUTPUT,
                 'KIS_GIT_OUTPUT_BOUND')
        timeout = min(timeout, self.deadline - self.monotonic() - RECOVERY_RESERVE)
        _require(timeout > 0, 'KIS_BUDGET_EXHAUSTED')
        deadline = self.monotonic() + timeout
        settings = ('core.hooksPath=/dev/null', 'credential.helper=', 'core.autocrlf=false',
                    'core.fsmonitor=false', 'core.sshCommand=/bin/false',
                    'gc.auto=0', 'maintenance.auto=false',
                    'protocol.file.allow=always', 'protocol.ext.allow=never',
                    'uploadpack.allowFilter=false', 'uploadpack.packObjectsHook=')
        environment = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'HOME': '/dev/null',
                       'XDG_CONFIG_HOME': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
                       'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
                       'GIT_ALLOW_PROTOCOL': 'file', 'GIT_LFS_SKIP_SMUDGE': '1'}
        # Ubuntu's Git 2.25 predates GIT_CONFIG_COUNT. Explicit -c works there
        # and is propagated to the fixed local upload-pack subprocess by Git.
        command = ['/usr/bin/git', '--no-pager']
        for setting in settings:
            command.extend(('-c', setting))
        try:
            process = subprocess.Popen(command + list(arguments),
                env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, start_new_session=True,
                preexec_fn=lambda: os.umask(0o077))
            output = bytearray()
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while selector.get_map():
                        remaining = deadline - self.monotonic()
                        _require(remaining > 0, 'KIS_GIT_TIMEOUT')
                        for key, _ in selector.select(min(remaining, 0.25)):
                            data = os.read(key.fd, min(65536, maximum + 1 - len(output)))
                            if not data:
                                selector.unregister(key.fileobj)
                            else:
                                output.extend(data)
                                _require(len(output) <= maximum, 'KIS_GIT_OUTPUT_BOUND')
                remaining = deadline - self.monotonic()
                _require(remaining > 0, 'KIS_GIT_TIMEOUT')
                result = process.wait(timeout=remaining)
                _require(result == 0, 'KIS_GIT_REFUSED')
                return bytes(output)
            except subprocess.TimeoutExpired:
                raise Refused('KIS_GIT_TIMEOUT') from None
            finally:
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.wait()
                process.stdout.close()
        except OSError:
            raise Refused('KIS_GIT_UNAVAILABLE') from None


def rename_exchange(left, right):
    """Linux-only atomic swap. ENOSYS/EINVAL/EXDEV are refusals, never fallbacks."""
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        function = libc.renameat2
        function.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        function.restype = ctypes.c_int
        result = function(-100, os.fsencode(left), -100, os.fsencode(right), 2)
        if result:
            raise OSError(ctypes.get_errno(), 'rename exchange refused')
    except (OSError, AttributeError):
        raise Refused('KIS_ATOMIC_EXCHANGE_UNAVAILABLE') from None


class KISCheckout:
    def __init__(self, verify_source, *, root=DEPLOY_ROOT, git_runner=None,
                 calendar_root=None, calendar_files=(), clock=time.time,
                 deadline=None, monotonic=time.monotonic,
                 crash_hook=lambda point: None, exchange=rename_exchange):
        # root and all callbacks are trusted composition values, never request data.
        self.root = Path(root)
        _require(self.root == DEPLOY_ROOT and self.root.is_absolute()
                 and self.root.resolve() == self.root, 'KIS_FIXED_ROOT_REQUIRED')
        self.base = self.root / 'managed-targets' / 'kis'
        self.current = self.base / 'current'
        self.monotonic = monotonic
        self.deadline = monotonic() + 120 if deadline is None else deadline
        _require(type(self.deadline) in (int, float) and math.isfinite(self.deadline),
                 'KIS_FINITE_DEADLINE_REQUIRED')
        self.verify_source = verify_source
        self.git_runner = git_runner or GitRunner(deadline=self.deadline, monotonic=monotonic)
        self.clock, self.crash_hook, self.exchange = clock, crash_hook, exchange
        self.calendar_root = None if calendar_root is None else Path(calendar_root)
        _require(type(calendar_files) in (tuple, list) and len(calendar_files) <= 16
                 and len(set(calendar_files)) == len(calendar_files), 'KIS_CALENDAR_SCOPE_REFUSED')
        self.calendar_files = tuple(sorted(calendar_files))
        for name in self.calendar_files:
            _safe_name(name)
            _require(name.startswith('data/market_calendar/') and name.endswith('.json'),
                     'KIS_CALENDAR_SCOPE_REFUSED')
        if self.calendar_files:
            _require(self.calendar_root is not None and self.calendar_root.is_absolute()
                     and self.calendar_root.resolve() == self.calendar_root,
                     'KIS_CALENDAR_ROOT_REQUIRED')
            _calendar_parent(self.calendar_root)

    def _remaining(self):
        remaining = self.deadline - self.monotonic() - RECOVERY_RESERVE
        _require(remaining > 0, 'KIS_BUDGET_EXHAUSTED')
        return remaining

    def git(self, arguments, *, maximum=MAX_FILE, timeout=60):
        result = self.git_runner(arguments, maximum=maximum, timeout=min(timeout, self._remaining()))
        self._remaining()
        return result

    def preflight(self):
        """Read-only reservation check; never creates/chmods the original checkout."""
        _parent(self.root)
        if self.base.parent.exists() or self.base.parent.is_symlink():
            _identity(self.base.parent)
        if self.base.exists() or self.base.is_symlink():
            _identity(self.base)
            owner = _json(self.base / 'owner.json')
            _require(owner == {'schema': 1, 'source': SOURCE, 'directory': _identity(self.base)},
                     'KIS_UNOWNED_ROOT_REFUSED')
            _identity(self.base / 'attempts')
            state = _json(self.base / 'current.json')
            receipt = self._receipt(self.current, state)
            self._validate(self.current, receipt, mutable_calendar=True)
            return {'state': 'OWNED', 'current': state}
        return {'state': 'ABSENT', 'current': None}

    def _initialize(self):
        if self.preflight()['state'] == 'OWNED':
            return
        if not self.base.parent.exists():
            self.base.parent.mkdir(mode=0o700)
            _sync(self.root)
        self.base.mkdir(mode=0o700)
        _sync(self.base.parent)
        _write(self.base / 'owner.json', _encode({'schema': 1, 'source': SOURCE,
                                               'directory': _identity(self.base)}))
        (self.base / 'attempts').mkdir(mode=0o700)
        self.current.mkdir(mode=0o700)
        receipt = {'schema': 1, 'kind': 'empty', 'source': SOURCE, 'commit': None,
                   'tree': None, 'directory': _identity(self.current), 'files': {},
                   'file_identities': {}, 'git_files': {}, 'git_directories': [], 'calendars': {}}
        _write(self.current / RECEIPT, _encode(receipt))
        _write(self.base / 'current.json', _encode(self._reference(receipt)))
        _sync(self.base)

    @contextlib.contextmanager
    def _lock(self):
        _identity(self.base)
        owner = _json(self.base / 'owner.json')
        _require(owner == {'schema': 1, 'source': SOURCE, 'directory': _identity(self.base)},
                 'KIS_UNOWNED_ROOT_REFUSED')
        _identity(self.base / 'attempts')
        fd = os.open(str(self.base / '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            facts = os.fstat(fd)
            _require(stat.S_ISREG(facts.st_mode) and facts.st_uid == os.getuid()
                     and facts.st_nlink == 1 and not facts.st_mode & 0o7077,
                     'KIS_LOCK_REFUSED')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused('KIS_CHECKOUT_BUSY') from None
            yield
        finally:
            os.close(fd)

    @staticmethod
    def _reference(receipt):
        return {'directory': receipt['directory'], 'receipt_sha256': _digest(receipt),
                'commit': receipt['commit']}

    def _receipt(self, path, reference):
        directory = _identity(path)
        receipt = _json(path / RECEIPT)
        _require(self._reference(receipt) == reference and receipt['directory'] == directory
                 and receipt.get('schema') == 1 and receipt.get('source') == SOURCE,
                 'KIS_CHECKOUT_IDENTITY_CHANGED')
        return receipt

    def _attempt(self, attempt_id):
        _require(type(attempt_id) is str and re.fullmatch(r'[0-9a-f]{32}', attempt_id),
                 'KIS_ATTEMPT_REQUIRED')
        return self.base / 'attempts' / attempt_id

    def _save(self, journal):
        raw = _encode(journal)
        _require(len(raw) <= MAX_METADATA, 'KIS_JOURNAL_BOUND')
        _write(self._attempt(journal['attempt_id']) / 'journal.json', raw, replace=True)

    def _load(self, attempt_id):
        attempt = self._attempt(attempt_id)
        _identity(attempt)
        journal = _json(attempt / 'journal.json')
        _require(journal.get('schema') == 1 and journal.get('attempt_id') == attempt_id
                 and journal.get('source') == SOURCE, 'KIS_JOURNAL_REFUSED')
        return journal

    def _inventory(self, checkout, sha, bare=False):
        prefix = ['--git-dir=' + str(checkout if bare else checkout / '.git')]
        _require(self.git(prefix + ['rev-parse', '--verify', sha + '^{commit}']).strip() == sha.encode(),
                 'KIS_COMMIT_CHANGED')
        commit_size = self.git(prefix + ['cat-file', '-s', sha], maximum=64).strip()
        _require(commit_size.isdigit() and int(commit_size) <= MAX_COMMIT, 'KIS_COMMIT_BOUND')
        tree = self.git(prefix + ['rev-parse', sha + '^{tree}']).strip().decode('ascii')
        _sha(tree)
        raw = self.git(prefix + ['ls-tree', '-r', '-t', '-z', '-l', '--full-tree', sha], maximum=512 * 1024)
        result, directories, total = {}, set(), 0
        for record in raw.split(b'\0'):
            if not record:
                continue
            try:
                header, encoded_name = record.split(b'\t', 1)
                mode, kind, object_id, size = header.decode('ascii').split()
                name = encoded_name.decode('ascii')
            except (ValueError, UnicodeError):
                raise Refused('KIS_TREE_ENTRY_REFUSED') from None
            _safe_name(name)
            if mode == '040000' and kind == 'tree' and size == '-':
                _require(authority.SHA1.fullmatch(object_id) and name not in directories
                         and len(directories) < MAX_FILES * 16, 'KIS_TREE_DIRECTORY_BOUND')
                directories.add(name)
                continue
            _require(mode in ('100644', '100755') and kind == 'blob'
                     and authority.SHA1.fullmatch(object_id) and size.isdigit(), 'KIS_TREE_MODE_REFUSED')
            size = int(size)
            total += size
            _require(name not in result and len(result) < MAX_FILES and size <= MAX_FILE
                     and total <= MAX_TOTAL, 'KIS_TREE_BOUND')
            result[name] = {'mode': mode, 'object': object_id, 'size': size}
        _require(result, 'KIS_EMPTY_TREE_REFUSED')
        names = set(result)
        _require(directories == {'/'.join(name.split('/')[:index]) for name in names
                                for index in range(1, len(name.split('/')))},
                 'KIS_TREE_DIRECTORY_SET_REFUSED')
        _require(all('/'.join(name.split('/')[:index]) not in names for name in names
                     for index in range(1, len(name.split('/')))), 'KIS_TREE_PREFIX_COLLISION')
        _require(set(self.calendar_files) <= names, 'KIS_CALENDAR_SOURCE_MISSING')
        _require(STRATEGY_FILE in result and result[STRATEGY_FILE]['size'] <= MAX_STRATEGY,
                 'KIS_STRATEGY_SOURCE_REQUIRED')
        return tree, result

    def _file_manifest(self, root, *, git=False):
        result, total = {}, 0
        for directory, subdirs, files in os.walk(str(root), followlinks=False):
            here = Path(directory)
            _identity(here)
            for name in subdirs:
                _identity(here / name)
            for name in files:
                path = here / name
                relative = path.relative_to(root).as_posix()
                raw = _read(path, 64 * 1024 * 1024 if git else MAX_FILE)
                total += len(raw)
                _require(len(result) < (4096 if git else MAX_FILES)
                         and total <= (64 * 1024 * 1024 if git else MAX_TOTAL), 'KIS_CHECKOUT_BOUND')
                result[relative] = {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw),
                                    'mode': stat.S_IMODE(path.lstat().st_mode)}
        return result

    @staticmethod
    def _git_directories(root):
        result = []
        for directory, subdirs, _ in os.walk(str(root), followlinks=False):
            _identity(Path(directory))
            for name in subdirs:
                path = Path(directory) / name
                _identity(path)
                result.append(path.relative_to(root).as_posix())
                _require(len(result) <= 4096, 'KIS_CHECKOUT_BOUND')
        return sorted(result)

    def _validate(self, path, receipt, mutable_calendar=False, exact_calendars=None):
        _require(_identity(path) == receipt['directory'], 'KIS_DIRECTORY_CHANGED')
        if receipt['kind'] == 'empty':
            _require(set(child.name for child in path.iterdir()) == {RECEIPT}, 'KIS_EMPTY_ROOT_CHANGED')
            return {}
        _require(receipt['kind'] == 'checkout' and receipt['source'] == SOURCE
                 and _sha(receipt['commit']) and _sha(receipt['tree']), 'KIS_RECEIPT_REFUSED')
        git_root = path / '.git'
        _require(self._file_manifest(git_root, git=True) == receipt['git_files']
                 and self._git_directories(git_root) == receipt['git_directories'],
                 'KIS_GIT_METADATA_CHANGED')
        _require(not (git_root / 'objects/info/alternates').exists()
                 and not (git_root / 'commondir').exists(), 'KIS_GIT_EXTERNAL_STORAGE_REFUSED')
        actual, calendars = {}, {}
        directories = {'/'.join(name.split('/')[:i]) for name in receipt['files']
                       for i in range(1, len(name.split('/')))}
        for directory, subdirs, files in os.walk(str(path), followlinks=False):
            here = Path(directory)
            _identity(here)
            if here == path:
                subdirs.remove('.git')
            for subdir in subdirs:
                _identity(here / subdir)
                _require((here / subdir).relative_to(path).as_posix() in directories,
                         'KIS_UNDECLARED_DIRECTORY')
            for name in files:
                candidate = here / name
                relative = candidate.relative_to(path).as_posix()
                if relative == RECEIPT:
                    continue
                _safe_name(relative)
                _require(relative in receipt['files'], 'KIS_UNDECLARED_FILE')
                raw = _read(candidate)
                facts = candidate.lstat()
                metadata = receipt['files'][relative]
                _require(stat.S_IMODE(facts.st_mode) == (0o700 if metadata['mode'] == '100755' else 0o600),
                         'KIS_CHECKOUT_MODE_CHANGED')
                value = {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw)}
                actual[relative] = value
                if relative in self.calendar_files:
                    calendars[relative] = value
                    expected = ((exact_calendars or {}).get(relative) or receipt['calendars'].get(relative)
                                or {key: metadata[key] for key in ('sha256', 'size')})
                    _require(mutable_calendar or value == expected, 'KIS_CALENDAR_CHANGED')
                else:
                    _require(all(value[key] == metadata[key] for key in value), 'KIS_CODE_CHANGED')
                    _require(file_identity(candidate) == receipt['file_identities'][relative],
                             'KIS_CODE_IDENTITY_CHANGED')
        _require(set(actual) == set(receipt['files']), 'KIS_CHECKOUT_FILE_SET_CHANGED')
        _require(len(actual) <= MAX_FILES and sum(value['size'] for value in actual.values()) <= MAX_TOTAL,
                 'KIS_CHECKOUT_BOUND')
        self.strategy_flags(path, receipt)
        return calendars

    def strategy_flags(self, path, receipt):
        """Read the effective fixed config using its retained receipt hash/identity."""
        self._remaining()
        _require(receipt.get('kind') == 'checkout' and _identity(path) == receipt['directory']
                 and STRATEGY_FILE in receipt['files'] and STRATEGY_FILE in receipt['file_identities'],
                 'KIS_STRATEGY_RECEIPT_REQUIRED')
        leaf = path / STRATEGY_FILE
        parent = _identity(leaf.parent)
        expected, metadata = receipt['file_identities'][STRATEGY_FILE], receipt['files'][STRATEGY_FILE]
        _require(file_identity(leaf) == expected, 'KIS_STRATEGY_IDENTITY_CHANGED')
        raw = _read(leaf, MAX_STRATEGY)
        _require(hashlib.sha256(raw).hexdigest() == metadata['sha256'] and len(raw) == metadata['size']
                 and file_identity(leaf) == expected, 'KIS_STRATEGY_CHANGED')
        flags = _strategy_flags(raw)
        _require(file_identity(leaf) == expected and _identity(path) == receipt['directory']
                 and _identity(leaf.parent) == parent,
                 'KIS_STRATEGY_IDENTITY_CHANGED')
        return {'path': STRATEGY_FILE, 'sha256': metadata['sha256'], 'identity': list(expected), 'flags': flags}

    def inspect(self, sha):
        """Verify fixed source and full tree bounds without creating managed paths."""
        _sha(sha)
        self._remaining()
        self.preflight()
        cache = Path(self.verify_source('KIS', sha))
        self._remaining()
        _require(cache == self.root / 'cache' / 'KIS.git' and cache.resolve() == cache,
                 'KIS_FIXED_VERIFIED_CACHE_REQUIRED')
        _parent(cache)
        tree, inventory = self._inventory(cache, sha, bare=True)
        strategy = self.git(['--git-dir=' + str(cache), 'cat-file', 'blob', inventory[STRATEGY_FILE]['object']],
                            maximum=MAX_STRATEGY)
        _require(len(strategy) == inventory[STRATEGY_FILE]['size'], 'KIS_STRATEGY_SOURCE_CHANGED')
        _strategy_flags(strategy)
        return {'source': dict(SOURCE), 'commit': sha, 'tree': tree, 'files': inventory}

    def stage_initial(self, *, attempt_id=None):
        """Bootstrap only the separately approved initial KIS commit."""
        state = self.preflight()
        _require(state['state'] == 'ABSENT' or state['current']['commit'] is None,
                 'KIS_INITIAL_CHECKOUT_ALREADY_PRESENT')
        return self.stage(INITIAL_COMMIT, attempt_id=attempt_id)

    def stage(self, sha, *, attempt_id=None):
        """Stage a full exact commit. No executable source selector is changed."""
        approved = self.inspect(sha)
        cache = self.root / 'cache/KIS.git'
        self._initialize()
        with self._lock():
            attempt_id = attempt_id or uuid.uuid4().hex
            attempt = self._attempt(attempt_id)
            _require(not attempt.exists() and not attempt.is_symlink(), 'KIS_ATTEMPT_EXISTS')
            attempt.mkdir(mode=0o700)
            checkout = attempt / 'candidate'
            checkout.mkdir(mode=0o700)
            _sync(attempt.parent)
            journal = {'schema': 1, 'attempt_id': attempt_id, 'source': SOURCE,
                       'commit': sha, 'state': 'STAGING', 'old': _json(self.base / 'current.json')}
            self._save(journal)
            self.git(['init', '--template=', '--quiet', str(checkout)])
            self.git(['--git-dir=' + str(checkout / '.git'), 'fetch', '--quiet', '--no-tags',
                      '--no-recurse-submodules', '--depth=1',
                      'file://' + str(cache), sha])
            tree, inventory = self._inventory(checkout, sha)  # Whole tree before ANY worktree write.
            _require(tree == approved['tree'] and inventory == approved['files'], 'KIS_VERIFIED_TREE_CHANGED')
            # Read every bounded blob before materializing. No checkout filters or hooks run.
            blobs = {}
            for name, metadata in inventory.items():
                raw = self.git(['--git-dir=' + str(checkout / '.git'), 'cat-file', 'blob', metadata['object']],
                               maximum=MAX_FILE)
                _require(len(raw) == metadata['size'] and not _private_key(raw), 'KIS_BLOB_REFUSED')
                metadata['sha256'] = hashlib.sha256(raw).hexdigest()
                blobs[name] = raw
            _strategy_flags(blobs[STRATEGY_FILE])
            for name, raw in blobs.items():
                destination = checkout / name
                for parent in reversed(destination.parents):
                    if parent == checkout or checkout in parent.parents:
                        if not parent.exists():
                            parent.mkdir(mode=0o700)
                        _identity(parent)
                _write(destination, raw, 0o700 if inventory[name]['mode'] == '100755' else 0o600)
            self.git(['--git-dir=' + str(checkout / '.git'), 'read-tree', sha])
            _write(checkout / '.git' / 'HEAD', (sha + '\n').encode(), replace=True)
            receipt = {'schema': 1, 'kind': 'checkout', 'source': SOURCE, 'commit': sha,
                       'tree': tree, 'directory': _identity(checkout), 'files': inventory,
                       'file_identities': {name: file_identity(checkout / name) for name in inventory},
                       'git_files': self._file_manifest(checkout / '.git', git=True),
                       'git_directories': self._git_directories(checkout / '.git'), 'calendars': {}}
            _write(checkout / RECEIPT, _encode(receipt))
            self._validate(checkout, receipt)
            journal.update(state='STAGED', new=self._reference(receipt))
            self._save(journal)
            return dict(journal)

    def stage_retained(self, origin_attempt_id, *, attempt_id=None):
        """Make an independent checkout from one exact recorded local preimage.

        A new attempt gives an explicit rollback its own reversible preimage.
        It never aliases the older retained directory or reads an arbitrary path.
        No credential loader, source fetch, Git hook or checkout filter is used.
        """
        self._remaining()
        self.preflight()
        with self._lock():
            origin = self._load(origin_attempt_id)
            _require(origin['state'] == 'PUBLISHED', 'KIS_RETAINED_ATTEMPT_REFUSED')
            source = self._attempt(origin_attempt_id) / 'candidate'
            receipt = self._receipt(source, origin['old'])
            _require(receipt['kind'] == 'checkout', 'KIS_RETAINED_CHECKOUT_REQUIRED')
            calendars = origin['publish_intent']['before_calendars']
            self._validate(source, receipt, exact_calendars=calendars)
            attempt_id = attempt_id or uuid.uuid4().hex
            attempt = self._attempt(attempt_id)
            _require(not attempt.exists() and not attempt.is_symlink(), 'KIS_ATTEMPT_EXISTS')
            attempt.mkdir(mode=0o700)
            checkout = attempt / 'candidate'
            checkout.mkdir(mode=0o700)
            _sync(attempt.parent)
            journal = {'schema': 1, 'attempt_id': attempt_id, 'source': SOURCE,
                       'commit': receipt['commit'], 'state': 'STAGING',
                       'old': _json(self.base / 'current.json'),
                       'retained_from': {'attempt_id': origin_attempt_id, 'reference': origin['old'],
                                         'manifest_sha256': _digest(receipt)}}
            self._save(journal)
            directories = {'.git'} | {'.git/' + name for name in receipt['git_directories']}
            directories.update('/'.join(name.split('/')[:index]) for name in receipt['files']
                               for index in range(1, len(name.split('/'))))
            for name in sorted(directories, key=lambda value: (value.count('/'), value)):
                (checkout / name).mkdir(mode=0o700)
            for name, metadata in receipt['files'].items():
                self._remaining()
                raw = _read(source / name)
                _write(checkout / name, raw, 0o700 if metadata['mode'] == '100755' else 0o600)
            for name, metadata in receipt['git_files'].items():
                self._remaining()
                raw = _read(source / '.git' / name, 64 * 1024 * 1024)
                _write(checkout / '.git' / name, raw, metadata['mode'])
            # Revalidate the source after copying; only this exact preimage is retained.
            self._receipt(source, origin['old'])
            self._validate(source, receipt, exact_calendars=calendars)
            copied = dict(receipt, directory=_identity(checkout), calendars=calendars,
                          file_identities={name: file_identity(checkout / name) for name in receipt['files']})
            _write(checkout / RECEIPT, _encode(copied))
            self._validate(checkout, copied)
            journal.update(state='STAGED', new=self._reference(copied))
            self._save(journal)
            return dict(journal)

    def _guard(self, observe):
        self._remaining()
        current = observe()
        self._remaining()
        _require(type(current) is dict, 'KIS_LIFECYCLE_GUARD_REQUIRED')
        hold, quiet = current.get('hold', {}), current.get('quiescence', {})
        services, watchers = current.get('services', {}), current.get('watchers', {})
        observed = current.get('observed_at')
        _require(type(observed) in (int, float) and self.clock() - 5 <= observed <= self.clock() + 1
                 and hold.get('reason') == HOLD_REASON and hold.get('global') == 'PAUSED'
                 and hold.get('tasks') == {name: 'PAUSED' for name in TASKS}
                 and current.get('ingress_excluded') is True
                 and set(quiet) == QUIET_KEYS | {'independently_observed'}
                 and quiet['independently_observed'] is True
                 and all(type(quiet[key]) is int and quiet[key] == 0 for key in QUIET_KEYS)
                 and set(services) == SERVICES and set(watchers) == WATCHERS
                 and all(value.get('state') == 'stopped' and value.get('settled') is True
                         for value in services.values())
                 and all(value.get('active') is False and value.get('settled') is True
                         for value in watchers.values()), 'KIS_STOPPED_QUIET_HELD_REQUIRED')
        return current

    def _calendar_snapshot(self, source):
        result, identities = {}, {}
        for name in self.calendar_files:
            path = source / name
            _require(path.resolve() == path, 'KIS_CALENDAR_PATH_REFUSED')
            ancestors = {}
            for parent in path.parents:
                ancestors[str(parent)] = _calendar_parent(parent)
                if parent == source:
                    break
            before = path.lstat()
            result[name] = _read(path, private=(source != self.calendar_root), calendar=(source == self.calendar_root))
            # Fixed calendar inputs are bounded JSON objects. Preserve raw bytes;
            # parsing supplies no new fields, defaults, dates or executable data.
            parsed = authority.object_value(result[name], MAX_FILE)
            pending, count = [(parsed, 0)], 0
            while pending:
                value, depth = pending.pop()
                count += 1
                _require(depth <= 16 and count <= 32768, 'KIS_CALENDAR_JSON_BOUND')
                if type(value) is dict:
                    _require(all(type(key) is str and len(key) <= 256 for key in value),
                             'KIS_CALENDAR_JSON_BOUND')
                    pending.extend((item, depth + 1) for item in value.values())
                elif type(value) is list:
                    pending.extend((item, depth + 1) for item in value)
                elif type(value) is str:
                    _require(len(value) <= 32768, 'KIS_CALENDAR_JSON_BOUND')
                elif type(value) is float:
                    _require(math.isfinite(value), 'KIS_CALENDAR_JSON_BOUND')
            after = path.lstat()
            fields = lambda facts: {'dev': facts.st_dev, 'ino': facts.st_ino,
                'mode': stat.S_IMODE(facts.st_mode), 'size': facts.st_size,
                'uid': facts.st_uid, 'gid': facts.st_gid,
                'mtime_ns': facts.st_mtime_ns, 'ctime_ns': facts.st_ctime_ns}
            _require(fields(before) == fields(after) and ancestors ==
                     {name: _calendar_parent(Path(name)) for name in ancestors}, 'KIS_CALENDAR_CHANGED')
            identities[name] = dict(fields(after), ancestors=ancestors)
        return result, identities

    def _apply_calendars(self, checkout, receipt, blobs):
        if receipt['kind'] == 'empty':
            return receipt
        for name, raw in blobs.items():
            _require(name in receipt['files'], 'KIS_CALENDAR_SOURCE_MISSING')
            _write(checkout / name, raw, replace=True)
        receipt = dict(receipt, calendars={name: {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw)}
                                          for name, raw in blobs.items()}, file_identities=dict(receipt['file_identities']))
        receipt['file_identities'].update({name: file_identity(checkout / name) for name in blobs})
        _write(checkout / RECEIPT, _encode(receipt), replace=True)
        return receipt

    def _prepare_exchange(self, journal, rollback, observe):
        self._guard(observe)
        retained = self._attempt(journal['attempt_id']) / 'candidate'
        live_reference = journal['new'] if rollback else journal['old']
        other_reference = journal['old'] if rollback else journal['new']
        _require(_json(self.base / 'current.json') == live_reference, 'KIS_CURRENT_RELEASE_CHANGED')
        live = self._receipt(self.current, live_reference)
        other = self._receipt(retained, other_reference)
        live_calendars = self._validate(self.current, live, mutable_calendar=True)
        self._validate(retained, other, exact_calendars=(
            journal['publish_intent']['before_calendars'] if rollback else None))
        calendar_source = self.calendar_root if live['kind'] == 'empty' else self.current
        blobs, calendar_identity = (self._calendar_snapshot(calendar_source)
                                    if self.calendar_files else ({}, {}))
        _require(not live_calendars or live_calendars == {
            name: {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw)} for name, raw in blobs.items()},
            'KIS_CALENDAR_CHANGED')
        other = self._apply_calendars(retained, other, blobs)
        # Retain full source/commit/manifests with both directory inode identities.
        intent = {'before': live, 'after': other, 'before_calendars': live_calendars,
                  'calendar_identity': calendar_identity,
                  'calendar_source': 'legacy' if live['kind'] == 'empty' else 'managed',
                  'calendar_bytes_sha256': _digest({name: hashlib.sha256(raw).hexdigest()
                                                  for name, raw in blobs.items()})}
        key = 'rollback_intent' if rollback else 'publish_intent'
        journal.update({key: intent, 'state': 'ROLLING_BACK' if rollback else 'PUBLISHING'})
        journal['old' if rollback else 'new'] = self._reference(other)
        self._save(journal)
        self.crash_hook('after_rollback_intent' if rollback else 'after_publish_intent')

    def _exchange(self, journal, rollback, observe):
        intent = journal['rollback_intent' if rollback else 'publish_intent']
        retained = self._attempt(journal['attempt_id']) / 'candidate'
        before, after = intent['before'], intent['after']
        _require(_identity(self.current) == before['directory']
                 and _identity(retained) == after['directory'], 'KIS_EXCHANGE_CAS_FAILED')
        self._receipt(self.current, self._reference(before))
        self._receipt(retained, self._reference(after))
        self._validate(self.current, before, exact_calendars=intent['before_calendars'])
        self._validate(retained, after)
        if self.calendar_files:
            source = self.calendar_root if intent['calendar_source'] == 'legacy' else self.current
            current, identities = self._calendar_snapshot(source)
            _require(_digest({name: hashlib.sha256(raw).hexdigest() for name, raw in current.items()})
                     == intent['calendar_bytes_sha256'] and identities == intent['calendar_identity'],
                     'KIS_CALENDAR_CHANGED')
        _require(before['directory']['dev'] == after['directory']['dev'], 'KIS_CROSS_DEVICE_REFUSED')
        self._guard(observe)  # Fresh lifecycle observation directly before the filesystem CAS.
        self.crash_hook('before_rollback_exchange' if rollback else 'before_publish_exchange')
        if before['kind'] == 'checkout': self.strategy_flags(self.current, before)
        if after['kind'] == 'checkout': self.strategy_flags(retained, after)
        self.exchange(self.current, retained)
        _sync(self.base)
        _sync(retained.parent)
        self.crash_hook('after_rollback_exchange' if rollback else 'after_publish_exchange')
        return self._reconcile(journal)

    def _reconcile(self, journal):
        rollback = journal['state'] == 'ROLLING_BACK'
        if journal['state'] not in ('PUBLISHING', 'ROLLING_BACK'):
            return journal
        intent = journal['rollback_intent' if rollback else 'publish_intent']
        retained = self._attempt(journal['attempt_id']) / 'candidate'
        before, after = intent['before'], intent['after']
        live_identity, other_identity = _identity(self.current), _identity(retained)
        if live_identity == before['directory'] and other_identity == after['directory']:
            self._receipt(self.current, self._reference(before))
            self._receipt(retained, self._reference(after))
            self._validate(self.current, before, exact_calendars=intent['before_calendars'])
            self._validate(retained, after)
            _require(_json(self.base / 'current.json') == self._reference(before),
                     'KIS_CURRENT_RELEASE_CHANGED')
            return journal  # Intent alone is not publication; only guarded retry may exchange.
        _require(live_identity == after['directory'] and other_identity == before['directory'],
                 'KIS_EXCHANGE_OUTCOME_UNKNOWN')
        self._receipt(self.current, self._reference(after))
        self._receipt(retained, self._reference(before))
        self._validate(self.current, after)
        self._validate(retained, before, exact_calendars=intent['before_calendars'])
        state = _json(self.base / 'current.json')
        _require(state in (self._reference(before), self._reference(after)), 'KIS_CURRENT_RELEASE_CHANGED')
        _write(self.base / 'current.json', _encode(self._reference(after)), replace=True)
        journal['state'] = 'ROLLED_BACK' if rollback else 'PUBLISHED'
        self._save(journal)
        return journal

    def reconcile(self, attempt_id):
        """Reconcile a recorded swap by both inodes; never initiates a swap."""
        with self._lock():
            return dict(self._reconcile(self._load(attempt_id)))

    def publish(self, attempt_id, observe_guard):
        with self._lock():
            journal = self._reconcile(self._load(attempt_id))
            if journal['state'] == 'PUBLISHED':
                receipt = self._receipt(self.current, journal['new'])
                self._validate(self.current, receipt, mutable_calendar=True)
                return dict(journal)
            _require(journal['state'] in ('STAGED', 'PUBLISHING'), 'KIS_PUBLICATION_STATE_REFUSED')
            if journal['state'] == 'STAGED':
                self._prepare_exchange(journal, False, observe_guard)
            return dict(self._exchange(journal, False, observe_guard))

    def rollback(self, attempt_id, observe_guard):
        """Restore only this attempt's retained directory from its exact live inode."""
        with self._lock():
            journal = self._reconcile(self._load(attempt_id))
            if journal['state'] == 'ROLLED_BACK':
                receipt = self._receipt(self.current, journal['old'])
                self._validate(self.current, receipt, mutable_calendar=True)
                return dict(journal)
            _require(journal['state'] in ('PUBLISHED', 'ROLLING_BACK'), 'KIS_ROLLBACK_STATE_REFUSED')
            if journal['state'] == 'PUBLISHED':
                self._prepare_exchange(journal, True, observe_guard)
            return dict(self._exchange(journal, True, observe_guard))
