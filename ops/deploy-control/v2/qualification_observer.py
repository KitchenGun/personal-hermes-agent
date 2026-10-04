"""Bounded read-only local facts for a kernel-selected target registry.

No environment values, DB/config content, broker calls or arbitrary commands.
An observed digest is evidence of current bytes/identity, not permission to
accept changed bytes as a new trusted baseline.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time

import authority
import registry as registry_module
import runtime_facts


class ObservationRefused(RuntimeError):
    pass


PROPERTIES = ('Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload',
              'ActiveState', 'SubState', 'Job', 'MainPID', 'InvocationID',
              'ExecMainPID', 'ExecMainStartTimestampMonotonic') + runtime_facts.EFFECTIVE_PROPERTIES


def signature(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


class Observer:
    def __init__(self, runner=None, proc_root=Path('/proc'), clock=time.time, monotonic=time.monotonic):
        self.runner = runner or self.capture
        self.proc_root = Path(proc_root)
        self.clock, self.monotonic = clock, monotonic
        self.deadline = None; self.bytes_read = 0

    @staticmethod
    def capture(argv, **kwargs):
        timeout = kwargs.pop('timeout')
        kwargs.pop('stderr', None); kwargs.pop('stdout', None)
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **kwargs)
        end = time.monotonic() + timeout; chunks = []; size = 0
        selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
        try:
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0: raise ObservationRefused('UNIT_QUERY_TIMEOUT')
                if not selector.select(remaining): raise ObservationRefused('UNIT_QUERY_TIMEOUT')
                chunk = os.read(process.stdout.fileno(), 4096)
                if not chunk: break
                size += len(chunk)
                if size > 16384: raise ObservationRefused('UNIT_OUTPUT_BOUND')
                chunks.append(chunk)
            return subprocess.CompletedProcess(argv, process.wait(timeout=max(.01,end-time.monotonic())), b''.join(chunks), b'')
        finally:
            selector.close(); process.stdout.close()
            if process.poll() is None:
                process.kill(); process.wait(timeout=1)

    def remaining(self):
        remaining = self.deadline - self.monotonic()
        if remaining <= 0: raise ObservationRefused('OBSERVATION_DEADLINE')
        return remaining

    def path_facts(self, path, maximum=512 * 1024):
        self.remaining(); path = Path(path)
        if not path.is_absolute() or path.resolve() != path: raise ObservationRefused('NONCANONICAL_TARGET_PATH')
        parents = []
        for parent in reversed(path.parents):
            item = parent.lstat()
            if not stat.S_ISDIR(item.st_mode) or item.st_uid not in (0, os.getuid()) or item.st_mode & 0o022:
                raise ObservationRefused('TARGET_PARENT_CONTROL_UNQUALIFIED')
            for name in ('system.posix_acl_access', 'system.posix_acl_default'):
                try: os.getxattr(str(parent), name, follow_symlinks=False)
                except OSError as error:
                    if error.errno != 61: raise ObservationRefused('ACL_OBSERVATION_UNAVAILABLE') from None
                else: raise ObservationRefused('EXTENDED_ACL_REQUIRES_QUALIFICATION')
            parents.append((str(parent), (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid)))
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1
                    or before.st_mode & 0o022 or not 0 <= before.st_size <= maximum):
                raise ObservationRefused('TARGET_FILE_CONTROL_UNQUALIFIED')
            try: os.getxattr(str(path), 'system.posix_acl_access', follow_symlinks=False)
            except OSError as error:
                if error.errno != 61: raise ObservationRefused('ACL_OBSERVATION_UNAVAILABLE') from None
            else: raise ObservationRefused('EXTENDED_ACL_REQUIRES_QUALIFICATION')
            data = stream.read(maximum + 1); after = os.fstat(stream.fileno())
        self.bytes_read += len(data)
        if len(data) > maximum or self.bytes_read > 16 * 1024 * 1024:
            raise ObservationRefused('OBSERVATION_BYTE_BOUND')
        if signature(before) != signature(after) or signature(after) != signature(path.lstat()):
            raise ObservationRefused('TARGET_FILE_CHANGED')
        for name, identity in parents:
            item = Path(name).lstat()
            if (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid) != tuple(identity):
                raise ObservationRefused('TARGET_PARENT_CHANGED')
        return {'sha256': hashlib.sha256(data).hexdigest(), 'identity': signature(after), 'parents': parents}

    def absent_facts(self, path, missing_parents=False):
        """Prove absence under controlled parents; never follow a dangling link."""
        self.remaining(); path = Path(path)
        if not path.is_absolute() or path.resolve() != path:
            raise ObservationRefused('NONCANONICAL_TARGET_PATH')
        if path.exists() or path.is_symlink(): raise ObservationRefused('TARGET_EXPECTED_ABSENT')
        parent = path.parent
        if not missing_parents and not parent.is_dir():
            raise ObservationRefused('ABSENT_TARGET_PARENT_UNAVAILABLE')
        while not parent.exists():
            if parent.is_symlink(): raise ObservationRefused('NONCANONICAL_TARGET_PATH')
            parent = parent.parent
        identities = []
        for directory in reversed((parent,) + tuple(parent.parents)):
            item = directory.lstat()
            if not stat.S_ISDIR(item.st_mode) or item.st_uid not in (0, os.getuid()) or item.st_mode & 0o022:
                raise ObservationRefused('TARGET_PARENT_CONTROL_UNQUALIFIED')
            for name in ('system.posix_acl_access', 'system.posix_acl_default'):
                try: os.getxattr(str(directory), name, follow_symlinks=False)
                except OSError as error:
                    if error.errno != 61: raise ObservationRefused('ACL_OBSERVATION_UNAVAILABLE') from None
                else: raise ObservationRefused('EXTENDED_ACL_REQUIRES_QUALIFICATION')
            identities.append((str(directory), (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid)))
        if path.exists() or path.is_symlink(): raise ObservationRefused('TARGET_EXPECTED_ABSENT')
        return {'absent': str(path), 'parents': identities}

    def unit(self, name):
        self.remaining()
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}\.(service|timer)', name):
            raise ObservationRefused('UNIT_NAME_REFUSED')
        timer = name.endswith('.timer')
        properties = (runtime_facts.TIMER_UNIT_PROPERTIES + runtime_facts.applicable_effective_properties(name)
                      if timer else PROPERTIES)
        result = self.runner(['/usr/bin/systemctl', '--user', 'show', name,
                              '--no-pager', '--all', '--property=' + ','.join(properties)],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                             timeout=min(3, self.remaining()),
                             env={key: value for key, value in os.environ.items()
                                  if key in ('HOME', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')})
        if result.returncode or len(result.stdout) > 16384: raise ObservationRefused('UNIT_OBSERVATION_UNAVAILABLE')
        try:
            pairs = [line.split('=', 1) for line in result.stdout.decode('ascii').split('\n') if '=' in line]
            values = dict(pairs)
            if len(values) != len(pairs): raise ValueError()
            if timer and set(values) != set(properties): raise ValueError()
        except (UnicodeError, ValueError): raise ObservationRefused('UNIT_OBSERVATION_MALFORMED') from None
        if (values.get('Id') != name or values.get('LoadState') != 'loaded'
                or 'DropInPaths' not in values or values.get('NeedDaemonReload') != 'no'
                or values.get('Job') not in ('', '0')):
            raise ObservationRefused('UNIT_EFFECTIVE_IDENTITY_UNQUALIFIED')
        return values

    def process(self, unit):
        try: pid = int(unit['MainPID'])
        except (ValueError, KeyError): raise ObservationRefused('PROCESS_IDENTITY_UNAVAILABLE') from None
        if pid <= 0: raise ObservationRefused('PRIMARY_SERVICE_NOT_RUNNING')
        path = self.proc_root / str(pid) / 'stat'
        invocation = unit.get('InvocationID', '')
        if not re.fullmatch(r'[0-9a-f]{32}', invocation):
            raise ObservationRefused('PROCESS_INVOCATION_INVALID')
        if (self.proc_root / str(pid)).stat().st_uid != os.getuid():
            raise ObservationRefused('PROCESS_OWNER_REFUSED')
        def snapshot():
            with path.open('rb') as stream: data = stream.read(8193)
            if len(data) > 8192: raise ObservationRefused('PROCESS_METADATA_BOUND')
            end = data.rfind(b')')
            fields = data[end + 2:].split()
            if (not data.startswith(str(pid).encode() + b' (') or end < 0 or len(fields) < 20
                    or not re.fullmatch(rb'[0-9]+', fields[19]) or int(fields[19]) <= 0):
                raise ObservationRefused('PROCESS_METADATA_INVALID')
            return (pid, fields[19].decode('ascii'))
        first = snapshot()
        executable = (self.proc_root / str(pid) / 'exe').stat()
        if snapshot() != first: raise ObservationRefused('PROCESS_CHANGED')
        return {'pid': pid, 'start_ticks': first[1], 'invocation_id': unit.get('InvocationID'),
                'exec_main_pid': unit.get('ExecMainPID'),
                'exec_started': unit.get('ExecMainStartTimestampMonotonic'),
                'executable': signature(executable)}

    def observe(self, registry):
        value = registry_module._structure(registry)
        self.deadline = self.monotonic() + 30; self.bytes_read = 0
        boot = (self.proc_root / 'sys/kernel/random/boot_id').read_text().strip()
        if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', boot):
            raise ObservationRefused('BOOT_IDENTITY_UNAVAILABLE')
        output = {}; retained_units = {}; retained_processes = {}; retained_files = {}; retained_absences = {}; retained_resolvers = []
        for target, profile in value['targets'].items():
            if profile is None: continue
            units = {}; processes = {}; files = {}; filesystem = {}
            for item in profile['runtime']['units']:
                name = item['name']; before = self.unit(name)
                if before['FragmentPath'] != item['fragment_path']:
                    raise ObservationRefused('UNIT_FRAGMENT_CHANGED')
                facts = self.path_facts(item['fragment_path'], 32768)
                if item['fragment_path'] in retained_files and retained_files[item['fragment_path']][0] != facts:
                    raise ObservationRefused('SHARED_UNIT_FILE_CHANGED')
                retained_files[item['fragment_path']] = (facts, 32768)
                expected_dropins = item.get('dropins', [])
                if before['DropInPaths'].split() != [entry['path'] for entry in expected_dropins]:
                    raise ObservationRefused('UNIT_DROPINS_CHANGED')
                dropins = []
                for entry in expected_dropins:
                    path = entry['path']; observed = self.path_facts(path, 32768)
                    if observed['sha256'] != entry['sha256']:
                        raise ObservationRefused('UNIT_DROPIN_HASH_CHANGED')
                    if path in retained_files and retained_files[path][0] != observed:
                        raise ObservationRefused('SHARED_UNIT_FILE_CHANGED')
                    retained_files[path] = (observed, 32768)
                    filesystem[path] = observed['identity'], observed['parents']
                    dropins.append({'path': path, 'sha256': observed['sha256']})
                effective = None
                if 'effective_identity_sha256' in item:
                    try: effective = runtime_facts.effective_identity(before, name)
                    except runtime_facts.FactsRefused as error: raise ObservationRefused(str(error)) from None
                    if effective != item['effective_identity_sha256']:
                        raise ObservationRefused('UNIT_EFFECTIVE_IDENTITY_CHANGED')
                units[name] = {'file': facts['sha256'], 'fragment_path': before['FragmentPath'],
                               'dropins': dropins, 'effective_identity': effective}
                filesystem[item['fragment_path']] = facts['identity'], facts['parents']
                if item['role'] in ('api', 'relay', 'worker'):
                    if before.get('ActiveState') == 'active':
                        processes[name] = self.process(before)
                        if name in retained_processes and retained_processes[name] != (before, processes[name]):
                            raise ObservationRefused('SHARED_PROCESS_CHANGED')
                        retained_processes[name] = (before, processes[name])
                    elif before.get('ActiveState') in ('inactive', 'failed') and before.get('MainPID') == '0':
                        # Facts may qualify a stopped/failed target for an explicit
                        # repair. This is never a healthy-service claim.
                        processes[name] = {'state': before['ActiveState'], 'pid': 0,
                                           'invocation_id': before.get('InvocationID'),
                                           'last_exec_pid': before.get('ExecMainPID')}
                    else: raise ObservationRefused('PRIMARY_SERVICE_STATE_UNRESOLVED')
                if self.unit(name) != before: raise ObservationRefused('UNIT_CHANGED_DURING_OBSERVATION')
                if name in retained_units and retained_units[name] != before: raise ObservationRefused('UNIT_CHANGED_DURING_OBSERVATION')
                retained_units[name] = before
            for source, path in profile['runtime']['owned_code_paths'].items():
                try: facts = self.path_facts(path)
                except FileNotFoundError:
                    absence = self.absent_facts(path)
                    retained_absences[path] = (absence, False)
                    files[source] = {'absent': True}; filesystem[path] = absence
                    continue
                if path in retained_files and retained_files[path][0] != facts: raise ObservationRefused('TARGET_FILE_CHANGED')
                retained_files[path] = (facts, 512 * 1024)
                files[source] = facts['sha256']; filesystem[path] = facts['identity'], facts['parents']
            if profile['runtime'].get('source_resolver') == registry_module.WORKER_SOURCE_RESOLVER:
                def read(path, maximum, target_filesystem=filesystem):
                    path = str(path); facts = self.path_facts(path, maximum)
                    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    with os.fdopen(fd, 'rb') as stream:
                        before = os.fstat(stream.fileno())
                        if not stat.S_ISREG(before.st_mode) or signature(before) != tuple(facts['identity']):
                            raise ObservationRefused('WORKER_SOURCE_CHANGED_DURING_READ')
                        data = stream.read(maximum + 1)
                        if signature(os.fstat(stream.fileno())) != signature(before):
                            raise ObservationRefused('WORKER_SOURCE_CHANGED_DURING_READ')
                    if len(data) > maximum or hashlib.sha256(data).hexdigest() != facts['sha256']:
                        raise ObservationRefused('WORKER_SOURCE_CHANGED_DURING_READ')
                    if path in retained_files and retained_files[path][0] != facts:
                        raise ObservationRefused('WORKER_SOURCE_CHANGED_DURING_READ')
                    retained_files[path] = (facts, maximum)
                    target_filesystem[path] = facts['identity'], facts['parents']
                    return data
                def absent(path, target_filesystem=filesystem):
                    path = str(path); facts = self.absent_facts(path, missing_parents=True)
                    retained_absences[path] = (facts, True); target_filesystem[path] = facts
                worker = next(item for item in profile['runtime']['units'] if item['role'] == 'worker')
                try:
                    root = profile['runtime']['workdir']; state = retained_units[worker['name']]
                    files = runtime_facts.worker_package(root, state, read, absent)
                    retained_resolvers.append((files, root, state, read, absent))
                except runtime_facts.FactsRefused as error: raise ObservationRefused(str(error)) from None
            output[target] = {'process_identity': authority.digest(processes),
                              'unit_identity': authority.digest(units),
                              'source_identity': authority.digest(files),
                              'filesystem_identity': authority.digest(filesystem)}
        for expected, root, state, read, absent in retained_resolvers:
            try: current = runtime_facts.worker_package(root, state, read, absent)
            except runtime_facts.FactsRefused as error: raise ObservationRefused(str(error)) from None
            if current != expected: raise ObservationRefused('WORKER_PACKAGE_CHANGED_AT_FINAL_RECHECK')
        for path, (facts, missing_parents) in retained_absences.items():
            if self.absent_facts(path, missing_parents) != facts: raise ObservationRefused('ABSENCE_CHANGED_AT_FINAL_RECHECK')
        for path, (facts, maximum) in retained_files.items():
            if self.path_facts(path, maximum) != facts: raise ObservationRefused('TARGET_CHANGED_AT_FINAL_RECHECK')
        for name, (unit, facts) in retained_processes.items():
            if self.process(unit) != facts: raise ObservationRefused('PROCESS_CHANGED_AT_FINAL_RECHECK')
        for name, facts in retained_units.items():
            if self.unit(name) != facts: raise ObservationRefused('UNIT_CHANGED_AT_FINAL_RECHECK')
        if (self.proc_root / 'sys/kernel/random/boot_id').read_text().strip() != boot:
            raise ObservationRefused('BOOT_CHANGED')
        return {'boot_id': boot, 'observed_at': int(self.clock()), 'targets': output}


def observe(registry):
    return Observer().observe(registry)
