"""Prepare the fixed stable KIS authoring repository for existing self-heal tasks.

Runtime code remains in the immutable current checkout. This repository is a
separate initial clean Git checkout; future release swaps never move it, reset
it, or touch existing branches/worktrees. It has no credentials or alternates.
The API uses its fixed receipt and imports an exact deployed commit locally
before creating a new bounded self-heal branch. There is no new daemon/unit.
"""
import hashlib
from pathlib import Path

import authority
import kis_checkout as storage
from kis_application_backend import artifact


class KISRepairSource:
    def __init__(self, checkout):
        storage._require(isinstance(checkout, storage.KISCheckout), 'KIS_REPAIR_STORAGE_REQUIRED')
        self.checkout = checkout
        self.root = checkout.base / 'repair-source'
        self.receipt_path = checkout.base / 'repair-source.json'
        self.record_path = checkout.base / 'repair-source-state.json'

    def _control(self):
        base = self.checkout.base
        storage._identity(base)
        storage._require(storage._json(base / 'owner.json') == {
            'schema': 1, 'source': storage.SOURCE, 'directory': storage._identity(base)}, 'KIS_REPAIR_OWNER_CHANGED')

    def prepare(self, attempt_id):
        self._control()
        source_record = self.checkout._load(attempt_id)
        storage._require(source_record['state'] == 'STAGED', 'KIS_REPAIR_STAGED_SOURCE_REQUIRED')
        source = self.checkout._attempt(attempt_id) / 'candidate'
        source_receipt = self.checkout._receipt(source, source_record['new'])
        self.checkout._validate(source, source_receipt)
        expected = {'commit': source_receipt['commit'], 'tree': source_receipt['tree'],
                    'release_identity': authority.digest(artifact(source_receipt))}
        if self.record_path.exists() or self.record_path.is_symlink():
            record = storage._json(self.record_path)
            storage._require(record.get('attempt_id') == attempt_id and record.get('receipt', {}).get('seed') == expected,
                             'KIS_REPAIR_EXISTING_SOURCE_CHANGED')
            pins = self._pins(record)
            self.verify(pins)
            return pins
        storage._require(not self.root.exists() and not self.root.is_symlink()
                         and not self.receipt_path.exists() and not self.receipt_path.is_symlink(),
                         'KIS_REPAIR_DESTINATION_OCCUPIED')
        self.root.mkdir(mode=0o700)
        storage._sync(self.root.parent)
        self.checkout.git(['init', '--template=', '--quiet', str(self.root)])
        prefix = ['--git-dir=' + str(self.root / '.git'), '--work-tree=' + str(self.root)]
        self.checkout.git(prefix + ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules',
                                    '--depth=1', 'file://' + str(source / '.git'), expected['commit']])
        tree, inventory = self.checkout._inventory(self.root, expected['commit'])
        storage._require(tree == expected['tree'] and inventory == {
            name: {key: value[key] for key in ('mode', 'object', 'size')}
            for name, value in source_receipt['files'].items()}, 'KIS_REPAIR_SOURCE_CHANGED')
        files = {}
        for name, metadata in inventory.items():
            raw = self.checkout.git(prefix + ['cat-file', 'blob', metadata['object']], maximum=storage.MAX_FILE)
            storage._require(len(raw) == metadata['size'] and hashlib.sha256(raw).hexdigest() ==
                             source_receipt['files'][name]['sha256'], 'KIS_REPAIR_BLOB_CHANGED')
            destination = self.root / name
            for parent in reversed(destination.parents):
                if parent == self.root or self.root in parent.parents:
                    if not parent.exists(): parent.mkdir(mode=0o700)
                    storage._identity(parent)
            storage._write(destination, raw, 0o700 if metadata['mode'] == '100755' else 0o600)
            files[name] = {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw),
                           'identity': storage.file_identity(destination)}
        self.checkout.git(prefix + ['read-tree', expected['commit']])
        storage._write(self.root / '.git/HEAD', (expected['commit'] + '\n').encode(), replace=True)
        origin = 'https://github.com/' + storage.SOURCE['repo'] + '.git'
        self.checkout.git(prefix + ['config', 'remote.origin.url', origin])
        self.checkout.git(prefix + ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
        storage._require(self.checkout.git(prefix + ['status', '--porcelain=v1', '--untracked-files=all']) == b'',
                         'KIS_REPAIR_INITIAL_WORKTREE_DIRTY')
        # Initial Git files must be independent ordinary files. Later Git objects,
        # branches, worktrees and index cache changes are legitimate authoring state.
        self.checkout._file_manifest(self.root / '.git', git=True)
        config = storage._read(self.root / '.git/config')
        receipt = {'schema': 1, 'kind': 'kis-repair-source-v1', 'source': dict(storage.SOURCE),
            'directory': storage._identity(self.root), 'git_directory': storage._identity(self.root / '.git'),
            'seed': expected, 'config': {'sha256': hashlib.sha256(config).hexdigest(), 'size': len(config)}}
        storage._write(self.receipt_path, authority.encoded(receipt))
        controls = {}
        for path in (self.receipt_path, self.root / '.git/config', self.root / '.git/HEAD'):
            raw = storage._read(path)
            controls[str(path)] = {'sha256': hashlib.sha256(raw).hexdigest(), 'identity': storage.file_identity(path)}
        record = {'schema': 1, 'attempt_id': attempt_id, 'receipt': receipt, 'files': files, 'controls': controls}
        storage._write(self.record_path, authority.encoded(record))
        pins = self._pins(record)
        self.verify(pins)
        return pins

    def _pins(self, record):
        return {'receipt': record['receipt'], 'receipt_sha256': hashlib.sha256(storage._read(self.receipt_path)).hexdigest(),
                'record_sha256': hashlib.sha256(storage._read(self.record_path, storage.MAX_METADATA)).hexdigest()}

    def verify(self, pins, *, check_worktree=True):
        self._control()
        storage._require(type(pins) is dict and set(pins) == {'receipt', 'receipt_sha256', 'record_sha256'},
                         'KIS_REPAIR_PINS_REQUIRED')
        raw = storage._read(self.record_path, storage.MAX_METADATA)
        storage._require(hashlib.sha256(raw).hexdigest() == pins['record_sha256'], 'KIS_REPAIR_RECORD_CHANGED')
        record = authority.object_value(raw, storage.MAX_METADATA)
        receipt = record['receipt']
        raw = storage._read(self.receipt_path)
        storage._require(hashlib.sha256(raw).hexdigest() == pins['receipt_sha256']
                         and authority.object_value(raw) == receipt == pins['receipt']
                         and receipt['source'] == storage.SOURCE and receipt['kind'] == 'kis-repair-source-v1'
                         and storage._identity(self.root) == receipt['directory']
                         and storage._identity(self.root / '.git') == receipt['git_directory'],
                         'KIS_REPAIR_IDENTITY_CHANGED')
        for path in (self.root / '.git/commondir', self.root / '.git/objects/info/alternates'):
            storage._require(not path.exists() and not path.is_symlink(), 'KIS_REPAIR_EXTERNAL_STORAGE_REFUSED')
        config = storage._read(self.root / '.git/config')
        storage._require(hashlib.sha256(config).hexdigest() == receipt['config']['sha256']
                         and len(config) == receipt['config']['size']
                         and storage._read(self.root / '.git/HEAD') == (receipt['seed']['commit'] + '\n').encode(),
                         'KIS_REPAIR_CONTROL_CHANGED')
        if check_worktree:
            actual = set()
            allowed_directories = {'/'.join(name.split('/')[:i]) for name in record['files']
                                   for i in range(1, len(name.split('/')))}
            import os
            for directory, subdirs, names in os.walk(str(self.root), followlinks=False):
                here = Path(directory)
                storage._identity(here)
                if here == self.root: subdirs.remove('.git')
                for child in subdirs:
                    storage._identity(here / child)
                    storage._require((here / child).relative_to(self.root).as_posix() in allowed_directories,
                                     'KIS_REPAIR_WORKTREE_CHANGED')
                for name in names:
                    path = here / name
                    relative = path.relative_to(self.root).as_posix()
                    storage._require(relative in record['files'], 'KIS_REPAIR_WORKTREE_CHANGED')
                    expected = record['files'][relative]
                    raw = storage._read(path)
                    storage._require(hashlib.sha256(raw).hexdigest() == expected['sha256']
                                     and storage.file_identity(path) == expected['identity'], 'KIS_REPAIR_WORKTREE_CHANGED')
                    actual.add(relative)
            storage._require(actual == set(record['files']), 'KIS_REPAIR_WORKTREE_CHANGED')
        return receipt

    def expected_source_files(self, pins):
        self.verify(pins)
        record = storage._json(self.record_path)
        result = {str(self.root / name): {'sha256': item['sha256'], 'identity': item['identity']}
                  for name, item in record['files'].items()}
        for path, item in record['controls'].items():
            actual = Path(path)
            storage._require(storage.file_identity(actual) == item['identity']
                             and hashlib.sha256(storage._read(actual)).hexdigest() == item['sha256'],
                             'KIS_REPAIR_CONTROL_CHANGED')
            result[path] = item
        return {'files': result, 'absent': []}
