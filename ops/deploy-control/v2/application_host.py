"""Production, fail-closed adapter for the three coupled application targets.

Nothing in the 2026-10-03 read-only report is an executable contract. In
particular, observed API/relay bytes with approval UNKNOWN are not a baseline.
An independently reviewed, hash-pinned local contract is mandatory. This module
ships no contract, guessed runtime schema, health URL, drain action or approval.

ApplicationHost(registry, contract_path, contract_sha256, context, source_reader)
implements application_release's Host API. source_reader(request, profile) must
return {manifest: exact_commit_manifest_bytes, files: {logical_name: bytes}};
this adapter independently checks the manifest hash and every file. Publication
and retained-code rollback belong exclusively to ApplicationRelease.

The bounded contract format is documented by validate_contract below. Field
selectors are literal JSON paths or [section, option] INI paths, never queries,
code or commands. The default audit reader combines declared existing state selectors, process
cgroup/executable membership and actual flock ownership. It creates no audit
file and assumes no new runtime writer. A caller's pause response is not evidence.
An injected audit_reader is available for tests and separately reviewed adapters.
The existing API health body is checked against its declared actual schema;
release and process identity receipts are built here, not expected from the API.

Schema1 preserves an EXISTING exact hold and independently proved ingress
exclusion. Schema2 cooperatively closes actual API/relay ingress through the
reviewed file bridge and validates live source/process-bound receipts. Both
preserve the exact KIS hold. The adapter never edits trading state,
activates paper/live work, deletes locks, or forces process termination. Watcher
suspension stops its timer and waits for an in-progress oneshot to finish.
Service stopping is allowed only with qualified SendSIGKILL=no policy. All
systemctl and HTTP calls are injectable; tests never contact a live system.
"""
import configparser
import copy
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import time
from urllib.parse import urlsplit

import authority
import application_network
import registry as registry_module
import runtime_facts
import pinned_byte_patch
import kis_checkout
import kis_application_backend
from application_release import (CONTEXT_KEYS, HOLD_REASON, MAX_FILES, MAX_FILE,
                                 MAX_TOTAL, QUIET_KEYS, TARGETS, _atomic, _directory,
                                 _hex, digest, _read as release_read, _exclusive, _sync)
from qualification_observer import Observer


SERVICES = {"HERMES_API": "codex-control-api.service",
            "HERMES_DISCORD_RELAY": "codex-discord-relay.service"}
WATCHERS = {"timer": "codex-control-api-healthcheck.timer",
            "oneshot": "codex-control-api-healthcheck.service"}
ROLES = {"api": SERVICES["HERMES_API"], "relay": SERVICES["HERMES_DISCORD_RELAY"],
         "watchdog_timer": WATCHERS["timer"], "watchdog_service": WATCHERS["oneshot"]}
TASK_IDS = ("kis-ai-market-open-supervisor-v1", "kis-ai-intraday-shadow-validation-v1",
            "kis-ai-post-close-learning-v1", "kis-ai-daily-learning-report-v1",
            "kis-vps-model-v3-autonomous-pilot-v1")
HERMES_FILES = frozenset(("server.js", "discord-relay.js", "dashboard-healthcheck.sh",
    "kis-ai-market-open-dry-run-task.js", "kis-prediction-validation-task.js",
    "kis-emergency-stop-executor.js", "kis-llm-verdict-executor.js",
    "kis-prediction-v2-validation-task.js", "discord-interaction-replay-guard.js",
    "kis-report-delivery-adapter.js"))
HOLD_FIELDS = {"global", "reason", "tasks", "next_runs", "pending_tasks", "operator_generation"}
AUDIT_FIELDS = QUIET_KEYS | {"observed_at", "boot_id", "operator_generation", "services",
    "ingress_excluded", "scheduler_count", "tasks_registered", "compatibility",
    "preserved_identity"}
GATE_FIELDS = {"order_api_allowed", "prod_orders_allowed", "vps_live_orders_allowed",
               "retry", "catch_up", "backfill"}
EFFECTS = {"suspend_watchers", "enter_hold", "exclude_ingress", "stop_services",
           "start_held", "restore_watchers", "reopen_ingress"}
MAINTENANCE_HOLD_FIELDS = {"global", "reason", "tasks", "operator_generation"}
MAINTENANCE_PROVIDERS = {"api": {"api", "discord_relay", "kis_scheduler", "kis_recovery",
                                 "kis_state_fault_notification"}, "relay": {"discord_relay"}}
PROPERTIES = ("Id", "LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload",
    "ActiveState", "SubState", "Job", "MainPID", "InvocationID", "ExecMainPID",
    "ExecMainStartTimestampMonotonic", "UnitFileState", "ControlPID", "SendSIGKILL",
    "KillSignal", "KillMode", "ControlGroup")
PROPERTIES = tuple(dict.fromkeys(PROPERTIES + runtime_facts.EFFECTIVE_PROPERTIES))
NONFORCING_DROPIN_NAME = "95-hermes-deploy-nonforcing-stop.conf"
NONFORCING_DROPIN_BYTES = b"[Service]\nSendSIGKILL=no\n"
NONFORCING_DROPIN_SHA256 = hashlib.sha256(NONFORCING_DROPIN_BYTES).hexdigest()

REQUIRED_REVIEW = ("explicit approved actual API/relay source baselines",
    "exact owned file hashes and source selection", "actual fragment and drop-in digests",
    "fixed hold, gate and preserved-state field schemas", "independent in-flight and ingress observation",
    "release/process-bound held health endpoint", "non-forcing service stop policy")


# A separate fixed helper bounds total connect/header/body time, not just socket
# inactivity. Killing a timed-out read-only helper never signals an application.
HTTP_HELPER = r"""import http.client,json,sys
from urllib.parse import urlsplit
try:
 value=json.load(sys.stdin); parts=urlsplit(value['url'])
 connection=http.client.HTTPConnection(parts.hostname,parts.port,timeout=value['timeout'])
 connection.request('GET',parts.path,headers={'Accept':'application/json'})
 response=connection.getresponse(); raw=response.read(value['maximum']+1)
 if len(raw)>value['maximum']:sys.exit(2)
 sys.stdout.buffer.write(str(response.status).encode('ascii')+b'\n'+raw)
 connection.close()
except Exception:sys.exit(2)
"""


class HostRefused(RuntimeError):
    """Only constant reason codes are exposed; private content is never an error."""


def _require(value, code):
    if not value:
        raise HostRefused(code)


def _keys(value, expected, code="HOST_CONTRACT_FIELDS_REFUSED"):
    _require(type(value) is dict and set(value) == set(expected), code)


def _hash(value):
    _require(_hex(value), "HOST_HASH_REQUIRED")
    return value


def _patch_destination(target, name, runtime):
    """Bind a recipe's exact logical path to its existing fixed code basename."""
    prefix, suffix = "deploy-patches/", ".patch.json"
    _require(target in SERVICES and type(name) is str
             and name.startswith(prefix) and name.endswith(suffix), "HOST_PATCH_PATH_REFUSED")
    basename = name[len(prefix):-len(suffix)]
    approved = basename == "approved-kis-ai-market-open-dry-run-task.js"
    destination = runtime["workdir"] + ("/.deploy-approved/kis-ai-market-open-dry-run-task.js"
                                       if approved else "/" + basename)
    _require((basename in HERMES_FILES or approved and target == "HERMES_API")
             and runtime["owned_code_paths"].get(name) == destination,
             "HOST_PATCH_DESTINATION_REFUSED")
    return runtime["owned_code_paths"][name]


def _path(value):
    try:
        registry_module._path(value)
    except Exception:
        raise HostRefused("HOST_PATH_REFUSED") from None
    _require(Path(value).resolve() == Path(value), "HOST_PATH_REFUSED")
    return Path(value)


def _signature(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _read(path, maximum=262144):
    """Bounded regular-file read with no symlink, FIFO or private-value output."""
    try:
        path = _path(str(path))
        _directory(path.parent)
        descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            _require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                     and before.st_nlink == 1 and not before.st_mode & 0o7022
                     and 0 <= before.st_size <= maximum, "HOST_FILE_CONTROL_REFUSED")
            raw = stream.read(maximum + 1)
            after = os.fstat(stream.fileno())
        _require(len(raw) <= maximum and _signature(before) == _signature(after)
                 and _signature(after) == _signature(path.lstat()), "HOST_FILE_CHANGED")
        return raw
    except HostRefused:
        raise
    except Exception:
        raise HostRefused("HOST_FILE_UNAVAILABLE") from None


def _json(raw):
    try:
        return authority.object_value(raw, 1024 * 1024)
    except Exception:
        raise HostRefused("HOST_JSON_REFUSED") from None


def _selector(value):
    _require(type(value) is list and 1 <= len(value) <= 8
             and all((type(key) is str and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", key))
                     or (type(key) is int and 0 <= key < 64) for key in value), "HOST_FIELD_SELECTOR_REFUSED")


def _projection_spec(spec, fields=None):
    _keys(spec, ("path", "format", "fields"))
    _path(spec["path"])
    _require(spec["format"] in ("json", "ini") and type(spec["fields"]) is dict
             and 1 <= len(spec["fields"]) <= 64, "HOST_PROJECTION_REFUSED")
    if fields is not None:
        _require(set(spec["fields"]) == set(fields), "HOST_REQUIRED_FIELDS_MISSING")
    for name, path in spec["fields"].items():
        _require(type(name) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name),
                 "HOST_FIELD_NAME_REFUSED")
        if name == "tasks" and type(path) is dict:
            _keys(path, TASK_IDS, "HOST_FIXED_TASK_SELECTORS_REQUIRED")
            _require(spec["format"] == "json", "HOST_TASK_SCHEMA_REFUSED")
            for steps in path.values(): _selector(steps)
        else:
            _selector(path)
        if spec["format"] == "ini":
            _require(len(path) == 2 and all(type(key) is str for key in path), "HOST_INI_SELECTOR_REFUSED")


def _read_existing_hold(path, maximum=1024 * 1024):
    """Read the exact protected hold only, preserving existing parent modes.

    Group-writable ancestors are part of the existing data trust model, not
    executable/publication authority. Every ancestor and the owned leaf remain
    identity-checked; this reader never writes and is used only by _hold().
    """
    path = _path(str(path))
    parents = {}
    for parent in reversed(path.parents):
        value = parent.lstat()
        _require(stat.S_ISDIR(value.st_mode) and not stat.S_ISLNK(value.st_mode)
                 and value.st_uid in (0, os.getuid()) and not value.st_mode & 0o002,
                 "HOST_HOLD_PARENT_UNQUALIFIED")
        parents[parent] = (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid)
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        _require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                 and before.st_nlink == 1 and not before.st_mode & 0o7022
                 and 0 <= before.st_size <= maximum, "HOST_HOLD_FILE_UNQUALIFIED")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    _require(len(raw) <= maximum and _signature(before) == _signature(after)
             and _signature(after) == _signature(path.lstat()), "HOST_HOLD_CHANGED")
    for parent, expected in parents.items():
        value = parent.lstat()
        _require((value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid) == expected,
                 "HOST_HOLD_PARENT_CHANGED")
    return raw


def _existing_data_grant(existing_data_reads, role):
    """Return one exact private outer-policy grant; absence grants no exception."""
    if existing_data_reads is None:
        return None
    try:
        value = copy.deepcopy(existing_data_reads)
        authority.validate_existing_data_reads(value)
        return value[role]
    except Exception:
        raise HostRefused("HOST_EXISTING_DATA_READS_REFUSED") from None


def _strategy_gate_spec(specification, registry, existing_data_reads=None):
    """Bind the data-only exception to one protected strategy and six flags.

    This is not a configurable weaker reader. The fixed existing path must be
    pinned by the private outer policy and explicitly preserved by an enabled
    application profile whose scope is bound by the private application contract.
    """
    _keys(specification, ("path", "format", "fields"), "HOST_STRATEGY_GATES_REQUIRED")
    grant = _existing_data_grant(existing_data_reads, "strategy_gates")
    _require(grant is not None and specification["path"] == grant["path"]
             and specification["format"] == "json"
             and specification["fields"] == {name: [name] for name in GATE_FIELDS},
             "HOST_STRATEGY_GATES_REQUIRED")
    profiles = [profile for target, profile in registry["targets"].items()
                if target in TARGETS and profile is not None]
    preserved = {path for profile in profiles for path in profile["runtime"]["preserved_paths"]}
    owned = {path for profile in profiles for path in profile["runtime"]["owned_code_paths"].values()}
    _require(specification["path"] in preserved and specification["path"] not in owned,
             "HOST_STRATEGY_PROTECTED_PATH_REQUIRED")


def _read_existing_strategy_gates(specification, registry, existing_data_reads=None):
    """Read only the six existing JSON gates without changing file authority.

    Existing group-write permissions on this nonexecuted data and its ancestors
    are preserved. The no-follow regular-file descriptor is read twice, with
    exact content, leaf metadata and ancestor identity checks. No file content
    other than the six false booleans is returned or included in exceptions.
    """
    _strategy_gate_spec(specification, registry, existing_data_reads)
    grant = _existing_data_grant(existing_data_reads, "strategy_gates")
    allowed = {Path(path) for path in grant["group_writable_ancestors"]}
    maximum = 262144
    try:
        path = _path(specification["path"])
        parents = {}
        for parent in reversed(path.parents):
            value = parent.lstat()
            forbidden = 0o7002 if parent in allowed else 0o7022
            _require(stat.S_ISDIR(value.st_mode) and not stat.S_ISLNK(value.st_mode)
                     and value.st_uid in (0, os.getuid()) and not value.st_mode & forbidden,
                     "HOST_STRATEGY_PARENT_UNQUALIFIED")
            parents[parent] = (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid)
        descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            _require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                     and before.st_nlink == 1 and not before.st_mode & 0o7113
                     and 0 < before.st_size <= maximum, "HOST_STRATEGY_FILE_UNQUALIFIED")
            first = stream.read(maximum + 1)
            stream.seek(0)
            second = stream.read(maximum + 1)
            after = os.fstat(stream.fileno())
        _require(len(first) <= maximum and first == second
                 and _signature(before) == _signature(after)
                 and _signature(after) == _signature(path.lstat()), "HOST_STRATEGY_CHANGED")
        for parent, expected in parents.items():
            value = parent.lstat()
            _require((value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid) == expected,
                     "HOST_STRATEGY_PARENT_CHANGED")
        gates = _project_raw(specification, first)
        _require(set(gates) == GATE_FIELDS and all(type(value) is bool for value in gates.values()),
                 "HOST_STRATEGY_BOOLEAN_REQUIRED")
        _require(all(value is False for value in gates.values()), "HOST_FINANCIAL_GATE_CHANGED")
        return gates
    except HostRefused:
        raise
    except Exception:
        raise HostRefused("HOST_STRATEGY_UNAVAILABLE") from None


def _database_parent_vector(path, existing_data_reads=None):
    """Observe database ancestry without changing its existing permissions.

    Only the private-policy-pinned Kanban database permits owning-group write on
    its three explicitly granted data directories. This is data identity evidence, not
    proof of exclusive writers or authority to read executable/financial data.
    Callers retain and compare the complete vector around their observation.
    Other paths retain the existing strict immediate-parent policy.
    """
    path = _path(str(path))
    def identity(value):
        return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid)
    grant = _existing_data_grant(existing_data_reads, "kanban_queue")
    if grant is None or str(path) != grant["path"]:
        _directory(path.parent)
        return {str(parent): identity(parent.lstat()) for parent in path.parents}
    allowed = {Path(parent) for parent in grant["group_writable_ancestors"]}
    descriptors, parents = [], {}
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        for parent in reversed(path.parents):
            before = parent.lstat()
            forbidden = 0o7002 if parent in allowed else 0o7022
            _require(stat.S_ISDIR(before.st_mode) and before.st_uid in (0, os.getuid())
                     and not before.st_mode & forbidden, "HOST_DATABASE_PARENT_UNQUALIFIED")
            descriptor = (os.open(str(parent), flags) if not descriptors else
                          os.open(parent.name, flags, dir_fd=descriptors[-1][1]))
            descriptors.append((parent, descriptor))
            expected = identity(before)
            _require(identity(os.fstat(descriptor)) == identity(parent.lstat()) == expected,
                     "HOST_DATABASE_PARENT_CHANGED")
            parents[str(parent)] = expected
        for parent, descriptor in descriptors:
            _require(identity(os.fstat(descriptor)) == identity(parent.lstat()) == parents[str(parent)],
                     "HOST_DATABASE_PARENT_CHANGED")
        return parents
    except HostRefused:
        raise
    except Exception:
        raise HostRefused("HOST_DATABASE_PARENT_UNAVAILABLE") from None
    finally:
        for unused, descriptor in reversed(descriptors):
            os.close(descriptor)


def _database_file_identity(specification, existing_data_reads=None):
    """Preserve an exact database file without opening SQLite or reading pages.

    This proves file identity/permissions only. It does not inspect or claim a
    fresh schema, financial setting, row value or transaction snapshot.
    """
    _keys(specification, ("path", "observation", "identity"))
    _require(specification["observation"] == "file_identity", "HOST_DATABASE_IDENTITY_MODE_REQUIRED")
    path = _path(specification["path"])
    parents = _database_parent_vector(path, existing_data_reads)
    def facts(value):
        _require(stat.S_ISREG(value.st_mode) and value.st_uid == os.getuid()
                 and value.st_nlink == 1 and not value.st_mode & 0o7022,
                 "HOST_DATABASE_CONTROL_REFUSED")
        return {"device": value.st_dev, "inode": value.st_ino, "uid": value.st_uid,
                "gid": value.st_gid, "mode": stat.S_IMODE(value.st_mode)}
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = facts(os.fstat(descriptor))
        _require(before == specification["identity"] and facts(path.lstat()) == before
                 and facts(os.fstat(descriptor)) == before, "HOST_DATABASE_IDENTITY_CHANGED")
    finally:
        os.close(descriptor)
    _require(_database_parent_vector(path, existing_data_reads) == parents, "HOST_DATABASE_PARENT_CHANGED")
    return dict(before, observation="file_identity")


def _exclusive_lock_busy(path):
    """Observe an exact approved open(O_EXCL) lock, without opening or deleting it.

    Root-owned sticky /tmp is the only writable-by-others parent accepted here.
    Presence is always busy, even if its recorded PID would appear stale.
    """
    path = _path(str(path))
    parents = {}
    for parent in reversed(path.parents):
        value = parent.lstat()
        sticky_tmp = (parent == Path("/tmp") and value.st_uid == 0
                      and stat.S_IMODE(value.st_mode) == 0o1777)
        _require(stat.S_ISDIR(value.st_mode) and not stat.S_ISLNK(value.st_mode)
                 and value.st_uid in (0, os.getuid())
                 and (not value.st_mode & 0o022 or sticky_tmp), "HOST_LOCK_PARENT_UNQUALIFIED")
        parents[parent] = (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid)
    try:
        before = path.lstat()
    except FileNotFoundError:
        before = None
    if before is not None:
        _require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                 and before.st_nlink == 1 and not before.st_mode & 0o7022,
                 "HOST_LOCK_IDENTITY_REFUSED")
    try:
        after = path.lstat()
    except FileNotFoundError:
        after = None
    _require((before is None and after is None) or
             (before is not None and after is not None and _signature(before) == _signature(after)),
             "HOST_LOCK_CHANGED")
    for parent, expected in parents.items():
        value = parent.lstat()
        _require((value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid) == expected,
                 "HOST_LOCK_PARENT_CHANGED")
    return before is not None


def _project(spec):
    return _project_raw(spec, _read(spec["path"]))


def _project_raw(spec, raw):
    try:
        if spec["format"] == "json":
            parsed = _json(raw)
            def selected(steps):
                value = parsed
                for key in steps:
                    _require((type(value) is dict and type(key) is str and key in value)
                             or (type(value) is list and type(key) is int and 0 <= key < len(value)),
                             "HOST_STATE_FIELD_MISSING")
                    value = value[key]
                return value
            result = {field: ({task: selected(path) for task, path in steps.items()}
                              if type(steps) is dict else selected(steps))
                      for field, steps in spec["fields"].items()}
        else:
            parser = configparser.ConfigParser(interpolation=None, strict=True,
                                               empty_lines_in_values=False)
            parser.optionxform = str
            parser.read_string(raw.decode("utf-8"))
            _require(not parser.defaults(), "HOST_INI_DEFAULTS_REFUSED")
            result = {field: parser[section][option] for field, (section, option)
                      in spec["fields"].items()}
        _require(len(authority.encoded(result)) <= 65536, "HOST_PROJECTION_BOUND")
        return result
    except HostRefused:
        raise
    except Exception:
        raise HostRefused("HOST_STATE_SCHEMA_REFUSED") from None


def _url(value):
    _require(type(value) is str and len(value) <= 512, "HOST_HEALTH_URL_REFUSED")
    try:
        parts = urlsplit(value)
        _require(parts.scheme == "http" and parts.hostname in ("127.0.0.1", "::1")
                 and parts.port is not None and 1 <= parts.port <= 65535
                 and parts.username is None and parts.password is None and not parts.query
                 and not parts.fragment and re.fullmatch(r"/[A-Za-z0-9_./-]{0,200}", parts.path)
                 and ".." not in parts.path.split("/"), "HOST_HEALTH_URL_REFUSED")
    except (ValueError, TypeError):
        raise HostRefused("HOST_HEALTH_URL_REFUSED") from None
    return parts


def validate_contract(value, registry, context, existing_data_reads=None):
    """Validate a reviewed contract, never promote a qualification report.

    The application scope omits controller implementation, registry revision,
    contract locator and profile display labels, avoiding content-hash cycles.
    It preserves exact source/runtime/permission facts. Active transactions stay
    bound to their controller context; verified terminal code history survives
    compatible controller-only migration without recapturing a live baseline.

    Required top-level keys are exact. `baseline` hashes every current owned
    file, while `coupled_sources` additionally approves the actual API/relay
    bytes even for a KIS-only profile. `units` contains exact drop-in path/hash
    maps and the qualified effective no-forced-kill properties. `selectors`
    hashes immutable selectors (including the KIS wrapper); `gates`, `hold`,
    `audit` and `preserved` contain bounded literal field projections. `audit`
    declares existing state counters, ingress/scheduler state, exact process
    cgroups/executables and existing flock paths. It names no invented writer.
    `databases`
    binds inode and bounded schema facts, never database contents. `health`
    is a reviewed loopback endpoint with the receipt schema below. No value is
    inferred from a request, repository HEAD, an empty scan or an HTTP 200.

    Schema2 replaces audit counters/ingress/scheduler projections with only
    locks/processes plus `maintenance`: fixed deployment root, exact API/relay
    sourceFiles maps, and fixed api.json/relay.json receipt names. Its hold
    projection selects state, pause_reason, the five complete task objects and
    an explicitly reviewed operator timestamp field. Null task scheduling and
    pending-invocation values are counted here. `health.relay` is the fixed
    discord_relay provider, whose transport evidence is receipt-bound. Schema1
    remains supported without importing or initializing the maintenance bridge.
    """
    required = {"schema", "approval", "application_scope_sha256", "boot_id", "units",
                "baseline", "coupled_sources", "selectors", "hold", "gates", "audit",
                "preserved", "databases", "health", "compatibility", "network"}
    _require(type(value) is dict and type(value.get("schema")) is int and value["schema"] in (1, 2),
             "HOST_REVIEWED_CONTRACT_REQUIRED")
    managed = value["schema"] == 2
    if managed: required.add("maintenance")
    if "kis_checkout" in value: required.add("kis_checkout")
    _require(set(value) in (required, required | {"maintenance_stop"}),
             "HOST_CONTRACT_FIELDS_REFUSED")
    if "maintenance_stop" in value:
        _require(value["maintenance_stop"] == {"kind": "temporary_dropin", "name": NONFORCING_DROPIN_NAME,
                 "sha256": NONFORCING_DROPIN_SHA256}, "HOST_MAINTENANCE_STOP_CONTRACT_REFUSED")
    _require(value["approval"] == "APPROVED", "HOST_REVIEWED_CONTRACT_REQUIRED")
    _require(context.get("registry_sha256") == authority.digest(registry), "HOST_CONTEXT_CHANGED")
    _require(value["application_scope_sha256"] == authority.digest(registry_module.application_scope(registry)),
             "HOST_APPLICATION_SCOPE_CHANGED")
    _require(type(value["boot_id"]) is str and registry_module._BOOT_PATTERN.fullmatch(value["boot_id"]),
             "HOST_BOOT_REQUIRED")
    _keys(value["compatibility"], ("old_hold", "new_hold", "state_contract_sha256"))
    _require(value["compatibility"]["old_hold"] is True and value["compatibility"]["new_hold"] is True,
             "HOST_HOLD_COMPATIBILITY_REQUIRED")
    _hash(value["compatibility"]["state_contract_sha256"])
    enabled = {target: profile for target, profile in registry["targets"].items()
               if target in TARGETS and profile is not None}
    _require(enabled, "HOST_NO_APPLICATION_PROFILE")
    dedicated_kis = "kis_checkout" in value
    if dedicated_kis:
        _require("approved_kis_wrapper" in value["selectors"], "HOST_APPROVED_WRAPPER_PAIR_REQUIRED")
    if dedicated_kis:
        _require(managed and "KIS" in enabled, "HOST_KIS_CHECKOUT_CONTRACT_REQUIRED")
        try:
            kis_application_backend.validate_contract(value["kis_checkout"], enabled["KIS"])
        except Exception:
            raise HostRefused("HOST_KIS_CHECKOUT_CONTRACT_REFUSED") from None
    elif "KIS" in enabled:
        _require(enabled["KIS"]["runtime"]["workdir"] !=
                 str(kis_checkout.DEPLOY_ROOT / "managed-targets/kis/current"),
                 "HOST_KIS_CHECKOUT_CONTRACT_REQUIRED")
    _keys(value["baseline"], enabled)
    shared = None
    for target, profile in enabled.items():
        runtime = profile["runtime"]
        _require({item["role"]: item["name"] for item in runtime["units"]} == ROLES,
                 "HOST_FIXED_UNITS_REQUIRED")
        _keys(value["baseline"][target], ("approval", "files"))
        _require(value["baseline"][target]["approval"] == "APPROVED", "HOST_BASELINE_APPROVAL_REQUIRED")
        _keys(value["baseline"][target]["files"], runtime["owned_code_paths"])
        for name, expected in value["baseline"][target]["files"].items():
            _hash(expected)
            if name.startswith("deploy-patches/"):
                _patch_destination(target, name, runtime)
            else:
                _require((name in HERMES_FILES if target != "KIS" else
                          re.fullmatch(r"kis_trading_lab/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+\.py", name)),
                         "HOST_EXACT_CODE_FILE_REQUIRED")
        _require(len(runtime["owned_code_paths"]) <=
                 (kis_checkout.MAX_FILES if target == "KIS" and dedicated_kis else MAX_FILES),
                 "HOST_CODE_FILE_BOUND")
        if shared is not None:
            _require(runtime["shared_lease"] == shared, "HOST_SHARED_LEASE_REQUIRED")
        shared = runtime["shared_lease"]
        _require(runtime["health"]["contract_sha256"] == digest(value["health"]),
                 "HOST_HEALTH_CONTRACT_CHANGED")
        for unit in runtime["units"]:
            if "dropins" in unit:
                _require({item["path"]: item["sha256"] for item in unit["dropins"]}
                         == value["units"][unit["name"]]["dropins"], "HOST_REGISTRY_DROPINS_CHANGED")
    _keys(value["units"], ROLES.values())
    for name, item in value["units"].items():
        _keys(item, ("dropins", "effective"))
        _require(type(item["dropins"]) is dict and len(item["dropins"]) <= 16,
                 "HOST_DROPIN_SET_REFUSED")
        for path, expected in item["dropins"].items():
            path = _path(path)
            _require(path.parent.name == name + ".d" and path.suffix == ".conf", "HOST_DROPIN_PATH_REFUSED")
            _hash(expected)
        if name in SERVICES.values():
            _keys(item["effective"], ("SendSIGKILL", "KillSignal", "KillMode"))
            _require(item["effective"]["SendSIGKILL"] in ("yes", "no")
                     and (item["effective"]["SendSIGKILL"] == "no" or "maintenance_stop" in value)
                     and item["effective"]["KillSignal"] in ("15", "SIGTERM")
                     and item["effective"]["KillMode"] in ("process", "control-group"),
                     "HOST_NONFORCING_STOP_REQUIRED")
        else:
            _keys(item["effective"], ())
    application_network.validate(value["network"], SERVICES.values())
    _keys(value["coupled_sources"], ("server.js", "discord-relay.js"))
    for name, item in value["coupled_sources"].items():
        _keys(item, ("path", "sha256", "approval"))
        _require(_path(item["path"]).name == name and item["approval"] == "APPROVED",
                 "HOST_COUPLED_BASELINE_APPROVAL_REQUIRED")
        _hash(item["sha256"])
    _require(type(value["selectors"]) is dict and 1 <= len(value["selectors"]) <= 32
             and "kis_wrapper" in value["selectors"], "HOST_SELECTORS_REQUIRED")
    for item in value["selectors"].values():
        _keys(item, ("path", "sha256")); _path(item["path"]); _hash(item["sha256"])
    _require(Path(value["selectors"]["kis_wrapper"]["path"]).name == "kis-ai-market-open-dry-run-task.js",
             "HOST_KIS_WRAPPER_REQUIRED")
    if "approved_kis_wrapper" in value["selectors"]:
        api = enabled.get("HERMES_API")
        _require(api is not None, "HOST_APPROVED_WRAPPER_PAIR_REQUIRED")
        mapping = api["runtime"]["owned_code_paths"]
        live_key = "deploy-patches/kis-ai-market-open-dry-run-task.js.patch.json"
        copy_key = "deploy-patches/approved-kis-ai-market-open-dry-run-task.js.patch.json"
        _require(mapping.get(live_key) == value["selectors"]["kis_wrapper"]["path"]
                 == api["runtime"]["workdir"] + "/kis-ai-market-open-dry-run-task.js"
                 and mapping.get(copy_key) == value["selectors"]["approved_kis_wrapper"]["path"]
                 == api["runtime"]["workdir"] + "/.deploy-approved/kis-ai-market-open-dry-run-task.js"
                 and value["selectors"]["kis_wrapper"]["sha256"] ==
                 value["selectors"]["approved_kis_wrapper"]["sha256"],
                 "HOST_APPROVED_WRAPPER_PAIR_REQUIRED")
    _projection_spec(value["hold"], MAINTENANCE_HOLD_FIELDS if managed else HOLD_FIELDS)
    _require(value["hold"]["format"] == "json", "HOST_HOLD_SCHEMA_REQUIRED")
    if managed:
        fields = value["hold"]["fields"]
        _require(fields["global"] == ["state"] and fields["reason"] == ["pause_reason"]
                 and fields["tasks"] == {task: ["tasks", task] for task in TASK_IDS},
                 "HOST_ACTUAL_HOLD_SELECTORS_REQUIRED")
    _projection_spec(value["gates"], GATE_FIELDS)
    grant = _existing_data_grant(existing_data_reads, "strategy_gates")
    if grant is not None:
        _strategy_gate_spec(value["gates"], registry, existing_data_reads)
    audit = value["audit"]
    _keys(audit, ("locks", "processes") if managed else
          ("counters", "ingress", "scheduler", "locks", "processes"))
    if not managed:
        _projection_spec(audit["counters"], QUIET_KEYS)
        _projection_spec(audit["ingress"], {"ingress_excluded"})
        _projection_spec(audit["scheduler"], {"scheduler_count", "tasks_registered", "compatibility"})
    _require(type(audit["locks"]) is list and 1 <= len(audit["locks"]) <= 64,
             "HOST_INDEPENDENT_LOCKS_REQUIRED")
    for item in audit["locks"]:
        _keys(item, ("path", "kind")); _path(item["path"])
        _require(item["kind"] in ("flock", "exclusive_file"), "HOST_LOCK_PROTOCOL_UNQUALIFIED")
    processes = audit["processes"]
    _keys(processes, ("cgroup_root", "groups", "node_executables", "python_executables", "escaped_pid_sources"))
    _path(processes["cgroup_root"])
    _keys(processes["groups"], SERVICES.values(), "HOST_FIXED_CGROUPS_REQUIRED")
    for group in processes["groups"].values(): registry_module._path(group)
    for key in ("node_executables", "python_executables"):
        paths = processes[key]
        _require(type(paths) is list and 1 <= len(paths) <= 16 and len(set(paths)) == len(paths),
                 "HOST_PROCESS_CONTRACT_REQUIRED")
        for path in paths: _path(path)
    _require(type(processes["escaped_pid_sources"]) is list and len(processes["escaped_pid_sources"]) <= 16,
             "HOST_ESCAPED_PROCESS_CONTRACT_REQUIRED")
    for spec in processes["escaped_pid_sources"]: _projection_spec(spec, {"pids"})
    _require(type(value["preserved"]) is dict and 1 <= len(value["preserved"]) <= 32,
             "HOST_PRESERVED_FIELDS_REQUIRED")
    for item in value["preserved"].values():
        _projection_spec(item)
    _require(type(value["databases"]) is dict and 1 <= len(value["databases"]) <= 8,
             "HOST_DATABASE_CONTRACT_REQUIRED")
    for item in value["databases"].values():
        if item.get("observation") == "file_identity":
            _require(managed, "HOST_DATABASE_IDENTITY_MODE_REQUIRES_MANAGED_CONTRACT")
            _keys(item, ("path", "observation", "identity")); _path(item["path"])
            _keys(item["identity"], ("device", "inode", "uid", "gid", "mode"))
            _require(all(type(number) is int and number >= 0 for number in item["identity"].values())
                     and item["identity"]["inode"] > 0 and item["identity"]["mode"] <= 0o777
                     and not item["identity"]["mode"] & 0o022, "HOST_DATABASE_IDENTITY_CONTRACT_REQUIRED")
        else:
            _keys(item, ("path", "user_version", "schema_sha256")); _path(item["path"]); _hash(item["schema_sha256"])
            _require(type(item["user_version"]) is int and 0 <= item["user_version"] < 2**31,
                     "HOST_DATABASE_SCHEMA_REQUIRED")
    _keys(value["health"], ("url", "api_checks", "relay"))
    _url(value["health"]["url"])
    _require(type(value["health"]["api_checks"]) is list and 1 <= len(value["health"]["api_checks"]) <= 16,
             "HOST_API_HEALTH_SCHEMA_REQUIRED")
    for check in value["health"]["api_checks"]:
        _keys(check, ("path", "equals")); _selector(check["path"])
        _require(type(check["equals"]) in (bool, str, int)
                 and len(str(check["equals"])) <= 128, "HOST_API_HEALTH_VALUE_REFUSED")
    if managed:
        _require(value["health"]["relay"] == {"provider": "discord_relay"},
                 "HOST_SOURCE_BOUND_RELAY_HEALTH_REQUIRED")
        maintenance = value["maintenance"]
        _keys(maintenance, ("root", "sourceFiles", "receipts"))
        _require(_path(maintenance["root"]) == Path(shared).parent
                 and maintenance["receipts"] == {"api": "api.json", "relay": "relay.json"},
                 "HOST_FIXED_MAINTENANCE_LAYOUT_REQUIRED")
        source_paths = {"api": value["coupled_sources"]["server.js"]["path"],
                        "relay": value["coupled_sources"]["discord-relay.js"]["path"],
                        "kis": value["selectors"]["kis_wrapper"]["path"]}
        _require(maintenance["sourceFiles"] == {"api": source_paths,
                 "relay": {key: source_paths[key] for key in ("relay", "kis")}},
                 "HOST_FIXED_MAINTENANCE_SOURCES_REQUIRED")
    else:
        _projection_spec(value["health"]["relay"], {"ready", "observed_at"})
    owned = {path for profile in enabled.values() for path in profile["runtime"]["owned_code_paths"].values()}
    protected = {value[key]["path"] for key in ("hold", "gates")}
    if not managed:
        protected |= {audit[key]["path"] for key in ("counters", "ingress", "scheduler")}
    protected |= {item["path"] for item in audit["locks"]}
    if not managed: protected.add(value["health"]["relay"]["path"])
    protected |= {item["path"] for key in ("preserved", "databases") for item in value[key].values()}
    for name, item in value["selectors"].items():
        if item["path"] in owned:
            _require(name in ("kis_wrapper", "approved_kis_wrapper")
                     and Path(item["path"]).name == "kis-ai-market-open-dry-run-task.js"
                     and any(item["sha256"] == value["baseline"][target]["files"].get(key)
                             for target, profile in enabled.items()
                             for key, path in profile["runtime"]["owned_code_paths"].items()
                             if path == item["path"]), "HOST_MANAGED_SELECTOR_REFUSED")
        else:
            protected.add(item["path"])
    _require(not owned & protected, "HOST_PRESERVED_CODE_OVERLAP")
    queue_grant = _existing_data_grant(existing_data_reads, "kanban_queue")
    if queue_grant is not None:
        preserved_paths = {path for profile in enabled.values()
                           for path in profile["runtime"]["preserved_paths"]}
        _require(queue_grant["path"] in preserved_paths and queue_grant["path"] not in owned
                 and sum(item["path"] == queue_grant["path"] for item in value["databases"].values()) == 1,
                 "HOST_QUEUE_PROTECTED_PATH_REQUIRED")
    return value


class ApplicationHost:
    def __init__(self, registry, contract_path=None, contract_sha256=None, context=None, source_reader=None,
                 *, runner=None, http_get=None, audit_reader=None, proc_root=Path("/proc"), clock=time.time,
                 invocation_deadline=None, monotonic=time.monotonic, kis_source_verifier=None,
                 kis_initial_authority=None, existing_data_reads=None):
        # Runtime dispatcher form: ApplicationHost(context, store, target).
        # The store is not authority; the kernel-selected context supplies all paths
        # and the already authenticated exact-SHA reader. No second token route.
        self.target = None
        self.invocation_deadline, self.monotonic = invocation_deadline, monotonic
        self._remaining(3)
        if context is None and source_reader is None and contract_sha256 in TARGETS:
            runtime, self.target = registry, contract_sha256
            try:
                registry = runtime["registry"]
                contract_path = runtime["application_contract_path"]
                contract_sha256 = runtime["application_contract_sha256"]
                context = runtime["application_context"]
                source_reader = runtime["application_source_reader"]
                kis_source_verifier = runtime.get("kis_source_verifier")
                kis_initial_authority = runtime.get("kis_initial_authority")
                existing_data_reads = runtime.get("policy", {}).get("runtime_bounds", {}).get("existing_data_reads")
            except Exception:
                raise HostRefused("HOST_RUNTIME_CONTEXT_REQUIRED") from None
        try:
            # Only the caller's immutable private kernel policy supplies this
            # grant. Neither application registries nor requests are defaults.
            self.existing_data_reads = copy.deepcopy(existing_data_reads)
            _existing_data_grant(self.existing_data_reads, "strategy_gates")
            self.registry = registry_module._structure(registry)
            _keys(context, CONTEXT_KEYS)
            _require(all(type(value) is str and value for value in context.values()), "HOST_CONTEXT_REQUIRED")
            _hash(context["controller_sha256"]); _hash(context["registry_sha256"])
            self.context = copy.deepcopy(context)
            self.contract_path, self.contract_sha256 = _path(str(contract_path)), _hash(contract_sha256)
            raw = _read(self.contract_path, 1024 * 1024)
            _require(hashlib.sha256(raw).hexdigest() == contract_sha256, "HOST_CONTRACT_HASH_CHANGED")
            self.contract = validate_contract(_json(raw), self.registry, self.context, self.existing_data_reads)
            self._kis_adapter, self.kis_source_verifier = None, kis_source_verifier
            self.kis_initial_authority = kis_initial_authority
            self.managed_ingress = self.contract["schema"] == 2
            self.source_reader, self.runner = source_reader, runner or Observer.capture
            self.http_get, self.proc_root, self.clock = http_get or self._http, Path(proc_root), clock
            _require(not self.managed_ingress or audit_reader is None, "HOST_MANAGED_AUDIT_OVERRIDE_REFUSED")
            self.audit_reader = audit_reader or self._runtime_audit
            if self.managed_ingress:
                from maintenance_control import MaintenanceControl
                self._maintenance_class = MaintenanceControl
            self.profile = next(profile for target, profile in self.registry["targets"].items()
                                if target in TARGETS and profile is not None)
            self.root = _path(self.profile["runtime"]["shared_lease"])
            if self.root.exists():
                _directory(self.root)
            else:
                _require(not self.root.is_symlink(), "HOST_LEASE_PATH_REFUSED")
                _directory(self.root.parent)  # Read-only installer preflight; never mkdir here.
            self.unit_definitions = {item["name"]: item for item in self.profile["runtime"]["units"]}
            self.observer = Observer(proc_root=self.proc_root, clock=clock)
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_CONFIGURATION_REFUSED") from None

    def directory_backend(self, target):
        if target != "KIS" or "kis_checkout" not in self.contract:
            return None
        if self._kis_adapter is None:
            specification = self.contract["kis_checkout"]
            def verify(alias, sha):
                _require(alias == "KIS" and callable(self.kis_source_verifier), "HOST_KIS_SOURCE_VERIFIER_REQUIRED")
                return self.kis_source_verifier(alias, sha)
            checkout = kis_checkout.KISCheckout(verify, root=kis_checkout.DEPLOY_ROOT,
                calendar_root=specification["calendar"]["root"],
                calendar_files=specification["calendar"]["files"], clock=self.clock,
                deadline=self.invocation_deadline, monotonic=self.monotonic)
            self._kis_adapter = kis_application_backend.KISApplicationBackend(checkout, self.root,
                specification["baseline"], contract_sha256=self.contract_sha256,
                application_scope_sha256=self.contract["application_scope_sha256"],
                initial_authority=self.kis_initial_authority)
        return self._kis_adapter

    def _kis_journal(self, binding):
        if binding is None or binding.get("target") != "KIS" or not binding.get("request_id"):
            return None
        path = self.root / binding["request_id"] / "journal.json"
        if not path.exists():
            return None
        journal = _json(_read(path, 1024 * 1024))
        _require(journal.get("binding") == binding and journal.get("binding_digest") == digest(binding)
                 and journal.get("context") == self.context, "HOST_CURRENT_JOURNAL_CHANGED")
        return journal if "publication" in journal else None

    def validate_configuration(self):
        """Validate pinned installation facts without effects or source/network reads.

        Runtime context must contain registry, application_contract_path,
        application_contract_sha256, application_context (the four controller/
        registry epoch and digest keys), and application_source_reader. The
        optional third constructor argument is one fixed application target.
        Missing reviewed facts fail closed; this is not current health evidence.
        """
        self._check_contract()
        _require(callable(self.source_reader), "HOST_SOURCE_READER_REQUIRED")
        if self.target is not None:
            _require(self.registry["targets"][self.target] is not None, "HOST_TARGET_NOT_QUALIFIED")
        self._selectors()
        for name in ROLES.values():
            self._unit(name)
        self._verify_code()
        self._hold()
        return True

    def validate_current_code(self):
        """Read-only migration gate for approved units/selectors/current code.

        This does not call source transport, require a running scheduler, perform
        HTTP health, adopt current bytes, or change the installed contract.
        """
        self._check_contract()
        self._selectors()
        for name in ROLES.values():
            self._unit(name)
        self._verify_code()
        return True

    def _remaining(self, maximum):
        remaining = maximum if self.invocation_deadline is None else min(maximum, self.invocation_deadline - self.monotonic())
        _require(type(remaining) in (int, float) and math.isfinite(remaining),
                 "HOST_INVOCATION_DEADLINE_INVALID")
        if remaining <= 0:
            raise TimeoutError("HOST_INVOCATION_DEADLINE")
        return remaining

    def _http(self, url, timeout=3, maximum=65536):
        _url(url)
        timeout = self._remaining(timeout)
        try:
            result = subprocess.run(["/usr/bin/python3", "-I", "-S", "-B", "-c", HTTP_HELPER],
                input=json.dumps({"url": url, "timeout": timeout, "maximum": maximum}).encode(),
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout,
                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
            self._remaining(3)
            _require(result.returncode == 0 and len(result.stdout) <= maximum + 4, "HOST_HEALTH_TRANSPORT_REFUSED")
            status, raw = result.stdout.split(b"\n", 1)
            _require(re.fullmatch(rb"[1-5][0-9]{2}", status) and len(raw) <= maximum, "HOST_HEALTH_TRANSPORT_REFUSED")
            return {"status": int(status), "body": raw}
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_HEALTH_TRANSPORT_UNAVAILABLE") from None

    def _lock_held(self, request_id):
        _require(type(request_id) is str and re.fullmatch(r"[A-Za-z0-9_-]{8,64}", request_id),
                 "HOST_REQUEST_ID_REFUSED")
        try:
            descriptor = os.open(str(self.root / ".lock"), os.O_RDONLY | os.O_NOFOLLOW)
            try:
                facts = os.fstat(descriptor)
                _require(stat.S_ISREG(facts.st_mode) and facts.st_uid == os.getuid()
                         and facts.st_nlink == 1 and not facts.st_mode & 0o022, "HOST_LEASE_CONTROL_REFUSED")
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    raise HostRefused("HOST_COORDINATION_LOCK_REQUIRED")
            finally:
                os.close(descriptor)
            self._active_request_id = request_id
            for path in self.root.iterdir():
                if path.name.startswith("."):
                    continue
                journal = _json(_read(path / "journal.json", 1024 * 1024))
                if journal.get("state") not in ("HELD_DEPLOYED", "HELD_ROLLED_BACK"):
                    _require(path.name == request_id and journal.get("request", {}).get("id") == request_id,
                             "HOST_SHARED_LEASE_BUSY")
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_LEASE_UNAVAILABLE") from None

    def _boot(self):
        self._remaining(3)
        try:
            raw = self._read_proc(self.proc_root / "sys/kernel/random/boot_id", 64)
            boot = raw.decode("ascii").strip()
            _require(registry_module._BOOT_PATTERN.fullmatch(boot), "HOST_BOOT_UNAVAILABLE")
            return boot
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_BOOT_UNAVAILABLE") from None

    def _check_contract(self):
        self._remaining(3)
        _require(hashlib.sha256(_read(self.contract_path, 1024 * 1024)).hexdigest() == self.contract_sha256,
                 "HOST_CONTRACT_CHANGED")
        self._boot()  # Contract boot is historical evidence; each attempt binds the current boot.

    def _run(self, arguments):
        try:
            result = self.runner(["/usr/bin/systemctl", "--user"] + arguments,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=self._remaining(3), env={key: value for key, value in os.environ.items()
                               if key in ("HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")})
            self._remaining(3)
            _require(result.returncode == 0 and type(result.stdout) is bytes and len(result.stdout) <= 16384,
                     "HOST_SYSTEMCTL_REFUSED")
            return result.stdout
        except (TimeoutError, subprocess.TimeoutExpired):
            raise TimeoutError("HOST_SYSTEMCTL_OUTCOME_UNKNOWN") from None
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_SYSTEMCTL_UNAVAILABLE") from None

    def _unit(self, name):
        _require(name in ROLES.values(), "HOST_UNIT_REFUSED")
        timer = name.endswith('.timer')
        properties = (runtime_facts.TIMER_UNIT_PROPERTIES + runtime_facts.applicable_effective_properties(name)
                      if timer else PROPERTIES)
        raw = self._run(["show", name, "--no-pager", "--all", "--property=" + ",".join(properties)])
        try:
            values = {}
            for line in raw.decode("ascii").splitlines():
                if not line:
                    continue
                key, value = line.split("=", 1)
                _require(key in properties and key not in values, "HOST_UNIT_FIELDS_REFUSED")
                values[key] = value
            _keys(values, properties, "HOST_UNIT_FIELDS_REFUSED")
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_UNIT_RESPONSE_REFUSED") from None
        definition, contract = self.unit_definitions[name], self.contract["units"][name]
        _require(values["Id"] == name and values["LoadState"] == "loaded"
                 and values["FragmentPath"] == definition["fragment_path"]
                 and values["NeedDaemonReload"] == "no", "HOST_UNIT_IDENTITY_CHANGED")
        _require(hashlib.sha256(_read(definition["fragment_path"], 32768)).hexdigest() == definition["sha256"],
                 "HOST_FRAGMENT_CHANGED")
        # Exact tokenization: systemd escapes or whitespace in a path is not silently normalized.
        extra, effective = self._maintenance_expected(name, contract)
        expected_paths = sorted(list(contract["dropins"]) + extra)
        _require(values["DropInPaths"].split() == expected_paths, "HOST_DROPIN_SET_CHANGED")
        for path, expected in contract["dropins"].items():
            _require(hashlib.sha256(_read(path, 32768)).hexdigest() == expected, "HOST_DROPIN_CHANGED")
        _require(all(values[key] == expected for key, expected in effective.items()),
                 "HOST_EFFECTIVE_POLICY_CHANGED")
        if "effective_identity_sha256" in definition:
            measured = dict(values)
            if extra:
                # The reviewed fixed temporary drop-in changes this one property.
                # All other effective launch/dependency settings remain qualified.
                measured["SendSIGKILL"] = contract["effective"]["SendSIGKILL"]
            try:
                identity = runtime_facts.effective_identity(measured, name)
            except Exception:
                raise HostRefused("HOST_EFFECTIVE_IDENTITY_UNAVAILABLE") from None
            _require(identity == definition["effective_identity_sha256"], "HOST_EFFECTIVE_IDENTITY_CHANGED")
        return values

    def _validate_maintenance_record(self, record):
        _keys(record, ("schema", "state", "context", "contract_sha256", "request_id", "attempt_id", "effect_id", "files"),
              "HOST_MAINTENANCE_JOURNAL_REFUSED")
        _require(type(record["schema"]) is int and record["schema"] == 1
                 and type(record["files"]) is dict and set(record["files"]) <= set(SERVICES.values())
                 and _hex(record["attempt_id"], 32) and _hex(record["effect_id"], 32),
                 "HOST_MAINTENANCE_JOURNAL_REFUSED")
        for name, item in record["files"].items():
            _keys(item, ("path", "identity"), "HOST_MAINTENANCE_JOURNAL_REFUSED")
            expected = Path(self.unit_definitions[name]["fragment_path"]).parent / (name + ".d") / NONFORCING_DROPIN_NAME
            _require(item["path"] == str(expected) and type(item["identity"]) is dict
                     and item["identity"].get("sha256") == NONFORCING_DROPIN_SHA256
                     and item["identity"].get("size") == len(NONFORCING_DROPIN_BYTES),
                     "HOST_MAINTENANCE_JOURNAL_REFUSED")

    def _maintenance_expected(self, unit, contract):
        extra, effective = [], dict(contract["effective"])
        path = self.root / ".nonforcing-stop.json"
        if unit not in SERVICES.values() or not path.exists():
            return extra, effective
        record = _json(_read(path, 131072))
        if record.get("state") == "RESTORED":
            return extra, effective
        self._validate_maintenance_record(record)
        _require("maintenance_stop" in self.contract and record.get("contract_sha256") == self.contract_sha256
                 and record.get("context") == self.context
                 and record.get("request_id") == getattr(self, "_active_request_id", None),
                 "HOST_MAINTENANCE_LEASE_CHANGED")
        _require(record.get("state") in ("FILES_PUBLISHED", "ACTIVE", "RESTORING"),
                 "HOST_MAINTENANCE_OUTCOME_UNKNOWN")
        item = record["files"].get(unit)
        if item is not None:
            expected = Path(self.unit_definitions[unit]["fragment_path"]).parent / (unit + ".d") / NONFORCING_DROPIN_NAME
            _require(item["path"] == str(expected), "HOST_MAINTENANCE_PATH_CHANGED")
            if expected.exists():
                raw = _read(expected, 128)
                _, identity = release_read(expected, 128)
                _require(raw == NONFORCING_DROPIN_BYTES and identity == item["identity"],
                         "HOST_MAINTENANCE_FILE_CHANGED")
                extra.append(str(expected)); effective["SendSIGKILL"] = "no"
            else:
                _require(record["state"] == "RESTORING", "HOST_MAINTENANCE_FILE_MISSING")
        return extra, effective

    def prepare_nonforcing_stop(self, binding, snapshot, attempt_id, effect_id):
        """Narrow reviewed hook, called only inside a leased quiet stop effect.

        The optional pinned maintenance_stop contract authorizes exactly two
        existing unit drop-in directories and the fixed SendSIGKILL=no bytes.
        It changes no KillMode, timing, ingress, enablement or application state.
        Publication, daemon-reload and restoration identities are journaled;
        unknown/crashed publication is quarantined rather than adopted/retried.
        """
        needs = [name for name in SERVICES.values()
                 if self.contract["units"][name]["effective"]["SendSIGKILL"] == "yes"]
        if not needs:
            return
        _require("maintenance_stop" in self.contract, "HOST_NONFORCING_STOP_REQUIRED")
        self._lock_held(binding["request_id"]); self._check_contract()
        fresh = self._facts(binding)
        _require(self._cas(fresh) == self._cas(snapshot), "HOST_MAINTENANCE_CAS_CHANGED")
        _require(self._quiet(snapshot)
                 and all(not item["active"] and item["settled"] for item in snapshot["watchers"].values()),
                 "HOST_MAINTENANCE_QUIESCENCE_REQUIRED")
        for name in ROLES.values(): self._unit(name)
        journal_path = self.root / ".nonforcing-stop.json"
        if journal_path.exists():
            previous = _json(_read(journal_path, 131072))
            _require(previous.get("state") == "RESTORED", "HOST_MAINTENANCE_OUTCOME_UNKNOWN")
        record = {"schema": 1, "state": "PREPARING", "context": self.context,
                  "contract_sha256": self.contract_sha256, "request_id": binding["request_id"],
                  "attempt_id": attempt_id, "effect_id": effect_id, "files": {}}
        _atomic(journal_path, record)
        for name in needs:
            directory = _directory(Path(self.unit_definitions[name]["fragment_path"]).parent / (name + ".d"))
            path = directory / NONFORCING_DROPIN_NAME
            _require(not path.exists() and not path.is_symlink(), "HOST_MAINTENANCE_PATH_OCCUPIED")
            _exclusive(path, NONFORCING_DROPIN_BYTES, 0o600); _sync(directory)
            _, identity = release_read(path, 128)
            record["files"][name] = {"path": str(path), "identity": identity}
            _atomic(journal_path, record)
        record["state"] = "FILES_PUBLISHED"; _atomic(journal_path, record)
        self._run(["daemon-reload"])
        for name in needs:
            _require(self._unit(name)["SendSIGKILL"] == "no", "HOST_NONFORCING_POLICY_NOT_LOADED")
        record["state"] = "ACTIVE"; _atomic(journal_path, record)

    def restore_nonforcing_stop(self, binding, snapshot):
        """Restore only this attempt's exact owned temporary files after stop."""
        path = self.root / ".nonforcing-stop.json"
        if not path.exists():
            return
        record = _json(_read(path, 131072))
        if record.get("state") == "RESTORED":
            return
        self._validate_maintenance_record(record)
        self._lock_held(binding["request_id"])
        fresh = self._facts(binding)
        _require(self._cas(fresh) == self._cas(snapshot), "HOST_MAINTENANCE_RESTORE_CAS_CHANGED")
        _require(record.get("request_id") == binding["request_id"]
                 and record.get("context") == self.context
                 and record.get("contract_sha256") == self.contract_sha256
                 and record.get("state") == "ACTIVE" and self._quiet(snapshot)
                 and all(item["state"] == "stopped" and item["settled"] for item in snapshot["services"].values()),
                 "HOST_MAINTENANCE_RESTORE_REFUSED")
        for name in SERVICES.values():
            actual = self._unit(name)
            _require(actual["ActiveState"] == "inactive" and actual["MainPID"] == "0"
                     and actual["Job"] in ("", "0") and actual["ControlPID"] == "0",
                     "HOST_MAINTENANCE_RESTORE_REQUIRES_STOPPED")
        record["state"] = "RESTORING"; _atomic(path, record)
        for item in record["files"].values():
            raw = _read(item["path"], 128)
            _, actual = release_read(item["path"], 128)
            _require(raw == NONFORCING_DROPIN_BYTES and actual == item["identity"],
                     "HOST_MAINTENANCE_RESTORE_FILE_CHANGED")
            Path(item["path"]).unlink(); _sync(Path(item["path"]).parent)
        self._run(["daemon-reload"])
        for name in SERVICES.values(): self._unit(name)
        record["state"] = "RESTORED"; _atomic(path, record)

    def _selectors(self):
        result = {}
        owned = self._initial_code()
        for name, item in self.contract["selectors"].items():
            if item["path"] in owned:
                _require(owned[item["path"]]["sha256"] == item["sha256"], "HOST_SELECTOR_BASELINE_CHANGED")
                # Managed code evolves only through retained publication history.
                # _facts verifies its current/attempt identity separately. The
                # selector's path and role remain fixed across those changes.
                result[name] = {"path": item["path"], "managed_code": True}
            else:
                actual = hashlib.sha256(_read(item["path"], MAX_FILE)).hexdigest()
                _require(actual == item["sha256"], "HOST_SELECTOR_CHANGED")
                result[name] = actual
        gates = self._state_projection(self.contract["gates"])
        if self.contract["gates"]["format"] == "ini":
            _require(all(value.lower() in ("false", "no", "0", "off") for value in gates.values()),
                     "HOST_FINANCIAL_GATE_CHANGED")
        else:
            _require(all(value is False for value in gates.values()), "HOST_FINANCIAL_GATE_CHANGED")
        return digest({"selectors": result, "gates": gates})

    def _unit_identity(self):
        return digest({name: {"fragment": self.unit_definitions[name], "contract": self.contract["units"][name]}
                       for name in sorted(ROLES.values())})

    def _binding_template(self, target):
        _require(target in TARGETS and (self.target is None or target == self.target), "HOST_TARGET_REFUSED")
        profile = self.registry["targets"][target]
        _require(profile is not None, "HOST_TARGET_NOT_QUALIFIED")
        result = copy.deepcopy({"qualified": True, "target": target, "context": self.context, "boot_id": self._boot(),
            "contract_sha256": self.contract_sha256,
            "application_scope_sha256": self.contract["application_scope_sha256"],
            "unit_identity": self._unit_identity(), "selector_identity": self._selectors(),
            "old_hold_compatible": True, "new_hold_compatible": True,
            "services": SERVICES, "watchers": WATCHERS, "task_ids": list(TASK_IDS),
            "files": {name: {"path": path, "kind": "code"}
                      for name, path in profile["runtime"]["owned_code_paths"].items()}})
        if self.managed_ingress: result["managed_ingress"] = True
        backend = self.directory_backend(target)
        if backend is not None:
            result["files"], result["publication"] = {}, backend.binding
        return result

    def _binding(self, request):
        binding = self._binding_template(request["target"])
        binding["request_id"] = request["id"]
        if request.get("schema") == 2:
            binding["operation"] = request["operation"]
            binding["source"] = copy.deepcopy(request["source"])
        else:
            binding["source"] = {key: request[key] for key in ("repo", "sha", "manifest_sha256")}
        binding["binding_id"] = digest(binding)
        return binding

    def local_current(self, target):
        self.validate_current_code()
        self._facts()  # Existing exact hold and independent target-impact proof.
        template = self._binding_template(target)
        files, identities = {}, {}
        for name, item in template["files"].items():
            _read(item["path"], MAX_FILE)
            files[name], identities[name] = release_read(item["path"], MAX_FILE)
        return {"binding_template": template, "files": files, "identities": identities,
                "baseline_sha256": digest({"contract_sha256": self.contract_sha256,
                    "accepted": self._accepted_code(), "identities": identities})}

    def qualify_local(self, request, retained_files):
        _keys(request, ("schema", "id", "target", "operation", "source"), "HOST_LOCAL_REQUEST_REFUSED")
        _require(type(request["schema"]) is int and request["schema"] == 2
                 and request["operation"] in ("deploy.rollback", "deploy.restart_service")
                 and type(request["source"]) is dict, "HOST_LOCAL_REQUEST_REFUSED")
        self._lock_held(request["id"])
        backend = self.directory_backend(request["target"])
        if backend is not None:
            _keys(retained_files, (), "HOST_LOCAL_FILE_SET_CHANGED")
            self.validate_current_code()
            binding = self._binding(request)
            qualified = backend.qualify(request, binding)
            self.observe(binding)
            return qualified
        current = self.local_current(request["target"])
        _keys(retained_files, current["files"], "HOST_LOCAL_FILE_SET_CHANGED")
        _require(all(type(raw) is bytes and 0 < len(raw) <= MAX_FILE for raw in retained_files.values())
                 and sum(len(raw) for raw in retained_files.values()) <= MAX_TOTAL, "HOST_LOCAL_FILE_BOUND")
        release = digest({name: hashlib.sha256(raw).hexdigest() for name, raw in retained_files.items()})
        _require(request["source"].get("release_identity") == release, "HOST_LOCAL_RELEASE_CHANGED")
        if request["operation"] == "deploy.restart_service":
            _require(retained_files == current["files"]
                     and request["source"].get("baseline_sha256") == current["baseline_sha256"],
                     "HOST_LOCAL_RESTART_BASELINE_CHANGED")
        binding = self._binding(request)
        self.observe(binding)
        return {"binding": binding, "files": dict(retained_files)}

    def _candidate(self, request, profile, allow_preview=False):
        try:
            source = self.source_reader(copy.deepcopy(request), copy.deepcopy(profile))
        except Exception:
            raise HostRefused("HOST_EXACT_SOURCE_UNAVAILABLE") from None
        _keys(source, ("manifest", "files"), "HOST_SOURCE_FORMAT_REFUSED")
        _require(type(source["manifest"]) is bytes and 0 < len(source["manifest"]) <= 65536,
                 "HOST_MANIFEST_CHANGED")
        manifest_sha256 = hashlib.sha256(source["manifest"]).hexdigest()
        _require(request.get("manifest_sha256", manifest_sha256) == manifest_sha256, "HOST_MANIFEST_CHANGED")
        manifest = _json(source["manifest"])
        _keys(manifest, ("schema", "target", "repo", "files", "compatibility"), "HOST_MANIFEST_FIELDS_REFUSED")
        _require(manifest["schema"] in (1, 2) and type(manifest["schema"]) is int
                 and all(manifest[key] == request[key] for key in ("target", "repo"))
                 and manifest["compatibility"] == self.contract["compatibility"], "HOST_CANDIDATE_COMPATIBILITY_REFUSED")
        _keys(source["files"], profile["runtime"]["owned_code_paths"], "HOST_SOURCE_SET_CHANGED")
        _keys(source["files"], profile["source"]["files"], "HOST_SOURCE_SET_CHANGED")
        _keys(manifest["files"], source["files"], "HOST_MANIFEST_SET_CHANGED")
        patches = manifest["schema"] == 2
        accepted = self._verify_code() if patches else None
        candidate_files = {}
        total = 0
        for name, raw in source["files"].items():
            metadata = manifest["files"][name]
            _keys(metadata, ("kind", "sha256", "size", "output") if patches else ("sha256", "size"),
                  "HOST_SOURCE_METADATA_REFUSED")
            _require(type(raw) is bytes and 0 < len(raw) <= (pinned_byte_patch.MAX_RECIPE if patches else MAX_FILE),
                     "HOST_SOURCE_BOUND")
            _require(type(metadata["size"]) is int and metadata["size"] == len(raw)
                     and metadata["sha256"] == hashlib.sha256(raw).hexdigest(), "HOST_SOURCE_HASH_CHANGED")
            _require(patches or not name.startswith("deploy-patches/"), "HOST_PATCH_SCHEMA_REQUIRED")
            if patches:
                _require(metadata["kind"] == "byte_patch_v1", "HOST_PATCH_KIND_REFUSED")
                destination = _patch_destination(request["target"], name, profile["runtime"])
                _keys(metadata["output"], ("sha256", "size"), "HOST_PATCH_OUTPUT_METADATA_REFUSED")
                output = metadata["output"]
                _require(type(output["size"]) is int and 0 < output["size"] <= MAX_FILE
                         and (_hex(output["sha256"]) or allow_preview and output["sha256"] is None),
                         "HOST_PATCH_SEALED_OUTPUT_REQUIRED")
                # The raw recipe bound and blob identity are checked before JSON
                # parsing. Duplicate/unknown fields cannot become successful edits.
                recipe = _json(raw)
                _require(recipe.get("output") == output, "HOST_PATCH_OUTPUT_METADATA_CHANGED")
                _require(destination in accepted, "HOST_PATCH_BASELINE_REQUIRED")
                _read(destination, MAX_FILE)
                try:
                    before, identity = release_read(destination, MAX_FILE)
                except Exception:
                    raise HostRefused("HOST_CODE_IDENTITY_UNAVAILABLE") from None
                _require(all(identity.get(key) == value for key, value in accepted[destination].items()),
                         "HOST_ACCEPTED_CODE_CHANGED")
                try:
                    if output["sha256"] is not None and identity["sha256"] == output["sha256"]:
                        raw = pinned_byte_patch.verify_recipe_output(before, recipe)
                    elif allow_preview:
                        raw = pinned_byte_patch.preview_recipe(before, recipe)
                    else:
                        raw = pinned_byte_patch.apply_recipe(before, recipe)
                except pinned_byte_patch.PatchRecipeError:
                    raise HostRefused("HOST_PATCH_RECIPE_REFUSED") from None
            candidate_files[name] = raw
            total += len(raw)
        approved_key = "deploy-patches/approved-kis-ai-market-open-dry-run-task.js.patch.json"
        wrapper_key = "deploy-patches/kis-ai-market-open-dry-run-task.js.patch.json"
        if approved_key in candidate_files:
            _require(wrapper_key in candidate_files and candidate_files[approved_key] == candidate_files[wrapper_key],
                     "HOST_APPROVED_WRAPPER_PAIR_CHANGED")
        _require(total <= MAX_TOTAL, "HOST_SOURCE_TOTAL_BOUND")
        return {"manifest": source["manifest"], "files": candidate_files}, manifest_sha256

    def _candidate_for_job(self, job, allow_preview=False):
        _require(not allow_preview or job.get("operation") == "deploy.verify", "HOST_PATCH_PREVIEW_OPERATION_REFUSED")
        accepted = job.get("request", job)
        target = job.get("target")
        _require(target in TARGETS and (self.target is None or target == self.target)
                 and _hex(accepted.get("sha"), 40), "HOST_CANDIDATE_JOB_REFUSED")
        profile = self.registry["targets"][target]
        _require(profile is not None and accepted.get("repo") == profile["repo"], "HOST_TARGET_NOT_QUALIFIED")
        self.validate_current_code()
        request = {"id": job["request_id"], "target": target, "repo": accepted["repo"], "sha": accepted["sha"]}
        backend = self.directory_backend(target)
        if backend is not None:
            manifest = authority.encoded(kis_application_backend.artifact(backend.checkout.inspect(request["sha"])))
            return {"manifest": manifest, "files": {}}, hashlib.sha256(manifest).hexdigest()
        return self._candidate(request, profile, allow_preview=allow_preview)

    def candidate_identity(self, job):
        # Identity lookup is strict even if a caller supplies a verify-shaped job.
        # Only readonly's explicit deploy.verify branch can request preparation.
        return self._candidate_for_job(job)[1]

    def qualify(self, request):
        _keys(request, ("id", "target", "repo", "sha", "manifest_sha256"), "HOST_REQUEST_REFUSED")
        _require(request["target"] in TARGETS and (self.target is None or request["target"] == self.target)
                 and _hex(request["sha"], 40)
                 and _hex(request["manifest_sha256"]), "HOST_REQUEST_REFUSED")
        profile = self.registry["targets"][request["target"]]
        _require(profile is not None and request["repo"] == profile["repo"], "HOST_TARGET_NOT_QUALIFIED")
        self._lock_held(request["id"]); self._check_contract()
        for name in ROLES.values():
            self._unit(name)
        # Only approved initial bytes or verified terminal owned journals establish
        # a current baseline. An ordinary read never adopts observed live bytes.
        self._verify_code()
        backend = self.directory_backend(request["target"])
        if backend is not None:
            binding = self._binding(request)
            qualified = backend.qualify(request, binding)
            self.observe(binding)
            return qualified
        source, _ = self._candidate(request, profile)
        binding = self._binding(request)
        self.observe(binding)  # Prove the existing hold and independent evidence before admitting a transaction.
        return {"binding": binding, "files": dict(source["files"])}

    def _initial_code(self):
        result = {}
        for target, baseline in self.contract["baseline"].items():
            if target == "KIS" and "kis_checkout" in self.contract:
                continue
            for name, expected in baseline["files"].items():
                path = self.registry["targets"][target]["runtime"]["owned_code_paths"][name]
                _require(path not in result or result[path]["sha256"] == expected, "HOST_BASELINE_ALIAS_CHANGED")
                result[path] = {"sha256": expected}
        for item in self.contract["coupled_sources"].values():
            path = item["path"]
            _require(path not in result or result[path]["sha256"] == item["sha256"], "HOST_BASELINE_ALIAS_CHANGED")
            result[path] = {"sha256": item["sha256"]}
        return result

    def _accepted_code(self):
        """Reconstruct per-path identity chains from terminal owned journals.

        Byte-equal rollbacks still have distinct installed inodes. Following the
        exact old -> installed identity edge avoids wall-clock ordering and does
        not mistake copied, forked or stale journals for a deployment history.
        """
        expected = self._initial_code()
        if not self.root.exists():
            _directory(self.root.parent)
            return expected
        edges = {path: [] for path in expected}
        journals = []
        for directory in self.root.iterdir():
            self._remaining(3)
            if directory.name.startswith("."):
                continue
            _require(len(journals) < 1024, "HOST_HISTORY_BOUND")
            journal = _json(_read(directory / "journal.json", 1024 * 1024))
            journals.append(journal)
            if journal.get("state") not in ("HELD_DEPLOYED", "HELD_ROLLED_BACK"):
                continue
            binding = journal.get("binding", {})
            _require(journal.get("schema") == 1 and type(journal.get("context")) is dict
                     and set(journal["context"]) == CONTEXT_KEYS
                     and _hex(journal["context"].get("controller_sha256"))
                     and _hex(journal["context"].get("registry_sha256"))
                     and binding.get("context") == journal["context"]
                     and journal.get("binding_digest") == digest(binding)
                     and binding.get("contract_sha256") == self.contract_sha256
                     and binding.get("application_scope_sha256") == self.contract["application_scope_sha256"]
                     and journal.get("request", {}).get("id") == directory.name
                     and journal.get("phase") == "COMPLETE", "HOST_TERMINAL_HISTORY_UNQUALIFIED")
            if binding.get("target") == "KIS" and "kis_checkout" in self.contract:
                _require(binding.get("publication") == {"kind": kis_application_backend.KIND,
                         "current": self.contract["kis_checkout"]["current"]}
                         and binding.get("files") == {} and journal.get("files") == [],
                         "HOST_KIS_TERMINAL_PUBLICATION_REFUSED")
                continue  # The dedicated adapter validates the full tree and its terminal lineage.
            files = journal.get("files")
            _require(type(files) is list and 1 <= len(files) <= MAX_FILES
                     and {item.get("name") for item in files} == set(binding.get("files", {})),
                     "HOST_TERMINAL_FILES_REFUSED")
            for item in files:
                path, name = item.get("path"), item.get("name")
                _require(path in edges and binding["files"][name] == {"path": path, "kind": "code"},
                         "HOST_TERMINAL_PATH_REFUSED")
                _require(type(item.get("index")) is int and 0 <= item["index"] < MAX_FILES,
                         "HOST_TERMINAL_INDEX_REFUSED")
                if journal.get("request", {}).get("schema") == 2 and journal["request"].get("operation") == "deploy.restart_service":
                    _require(journal["state"] == "HELD_DEPLOYED" and journal.get("old_release") == journal.get("new_release")
                             and item.get("state") == "OLD" and type(item.get("old")) is dict,
                             "HOST_TERMINAL_RESTART_CHANGED")
                    old = _read(directory / (str(item["index"]) + ".old"), MAX_FILE)
                    new = _read(directory / (str(item["index"]) + ".new"), MAX_FILE)
                    _require(old == new and hashlib.sha256(old).hexdigest() == item["old"].get("sha256")
                             and item.get("new_sha256") == item["old"].get("sha256"),
                             "HOST_TERMINAL_RESTART_RETAINED_CHANGED")
                    continue  # No filesystem identity edge: restart never republishes code.
                rollback = journal["state"] == "HELD_ROLLED_BACK"
                final = item.get("restored" if rollback else "published")
                _require(item.get("state") == ("RESTORED" if rollback else "NEW")
                         and type(item.get("old")) is dict and type(final) is dict,
                         "HOST_TERMINAL_IDENTITY_MISSING")
                retained = _read(directory / (str(item["index"]) + (".old" if rollback else ".new")), MAX_FILE)
                _require(hashlib.sha256(retained).hexdigest() == final.get("sha256"),
                         "HOST_TERMINAL_RETAINED_CODE_CHANGED")
                edges[path].append((item["old"], final))
        for path, pending in edges.items():
            if not pending:
                continue
            roots = [(old, final) for old, final in pending
                     if not any(old == previous for _, previous in pending)]
            _require(len(roots) == 1 and roots[0][0].get("sha256") == expected[path]["sha256"],
                     "HOST_TERMINAL_CHAIN_UNQUALIFIED")
            current = roots[0][0]
            remaining = list(pending)
            while remaining:
                next_edges = [(old, final) for old, final in remaining if old == current]
                _require(len(next_edges) == 1, "HOST_TERMINAL_CHAIN_AMBIGUOUS")
                edge = next_edges[0]
                remaining.remove(edge)
                current = edge[1]
            expected[path] = current
        return expected

    def _verify_code(self, binding=None):
        expected = self._accepted_code()
        allowed = {path: [identity] for path, identity in expected.items()}
        if binding is not None:
            journal_path = self.root / binding["request_id"] / "journal.json"
            if journal_path.exists():
                journal = _json(_read(journal_path, 1024 * 1024))
                _require(journal.get("context") == self.context and journal.get("binding") == binding
                         and journal.get("binding_digest") == digest(binding), "HOST_CURRENT_JOURNAL_CHANGED")
                if journal.get("state") not in ("HELD_DEPLOYED", "HELD_ROLLED_BACK"):
                    for item in journal.get("files", []):
                        path = item["path"]
                        _require(path in expected and item["name"] in binding["files"]
                                 and binding["files"][item["name"]]["path"] == path
                                 and all(item["old"].get(key) == value for key, value in expected[path].items()),
                                 "HOST_CURRENT_BASELINE_CHANGED")
                        state = item["state"]
                        if state == "OLD": identities = [item["old"]]
                        elif state == "NEW": identities = [item["published"]]
                        elif state == "RESTORED": identities = [item["restored"]]
                        elif state in ("PUBLISHING", "RESTORING"): identities = [item["before"], item["replacement"]]
                        else: raise HostRefused("HOST_PUBLICATION_STATE_REFUSED")
                        allowed[path] = identities
        verified = {}
        for path, identities in allowed.items():
            self._remaining(3)
            _read(path, MAX_FILE)
            try:
                _, actual = release_read(path, MAX_FILE)
            except Exception:
                raise HostRefused("HOST_CODE_IDENTITY_UNAVAILABLE") from None
            matching = [identity for identity in identities
                        if all(actual.get(key) == value for key, value in identity.items())]
            _require(matching, "HOST_ACCEPTED_CODE_CHANGED")
            # Return the approved identity that matched, never adopt the live
            # digest as source authority. Publication identities come only from
            # this transaction's validated retained-code journal.
            verified[path] = copy.deepcopy(matching[0])
        backend = self.directory_backend("KIS")
        if backend is not None:
            active_journal = self._kis_journal(binding)
            current = backend.current_identity(active_journal)
            # The preserved original strategy and the executing managed
            # checkout are independent. The adapter binds these six false
            # flags to the effective current receipt, including active exchange
            # recovery. This gate also runs in health and before ingress OPEN.
            backend.effective_strategy(active_journal)
            _require(backend.current_identity(active_journal) == current,
                     "HOST_KIS_STRATEGY_RELEASE_CHANGED")
            verified[str(backend.checkout.current)] = {"kind": kis_application_backend.KIND, **current}
        return verified

    def validate_binding(self, binding):
        try:
            self._lock_held(binding["request_id"]); self._check_contract()
            if "operation" in binding:
                request = {"schema": 2, "id": binding["request_id"], "target": binding["target"],
                           "operation": binding["operation"], "source": binding["source"]}
            else:
                request = dict(binding["source"], id=binding["request_id"], target=binding["target"])
            _require(binding == self._binding(request), "HOST_BINDING_CHANGED")
            for name in ROLES.values():
                self._unit(name)
            return True
        except TimeoutError:
            raise
        except Exception:
            return False

    def _services(self, units):
        result = {}
        for name in SERVICES.values():
            item = units[name]
            _require(item["MainPID"].isdigit() and item["ExecMainStartTimestampMonotonic"].isdigit(),
                     "HOST_PROCESS_FIELDS_REFUSED")
            pid = int(item["MainPID"])
            settled = item["Job"] in ("", "0") and item["ControlPID"] == "0"
            if item["ActiveState"] == "active" and item["SubState"] == "running" and pid > 0:
                self.observer.process(item)
                state = "running"
            elif item["ActiveState"] == "inactive" and item["SubState"] == "dead" and pid == 0:
                state = "stopped"
            else:
                raise HostRefused("HOST_PROCESS_STATE_UNRESOLVED")
            result[name] = {"state": state, "settled": settled, "invocation_id": item["InvocationID"],
                            "pid": pid, "started_at": int(item["ExecMainStartTimestampMonotonic"]) / 1000000}
        return result

    def _state_projection(self, specification):
        # The strategy exception is exact, data-only and limited to contract.gates.
        # Other projections, code and control files keep their strict readers.
        existing_data_reads = getattr(self, "existing_data_reads", None)
        grant = _existing_data_grant(existing_data_reads, "strategy_gates")
        if self.managed_ingress and grant is not None and specification["path"] == grant["path"]:
            _require(specification == self.contract.get("gates"), "HOST_STRATEGY_GATES_REQUIRED")
            return _read_existing_strategy_gates(specification, self.registry, existing_data_reads)
        if (self.managed_ingress and specification["path"] == self.contract["hold"]["path"]):
            return _project_raw(specification, _read_existing_hold(specification["path"]))
        return _project(specification)

    def _hold(self):
        specification = self.contract["hold"]
        hold = (_project_raw(specification, _read_existing_hold(specification["path"]))
                if self.managed_ingress else _project(specification))
        if self.managed_ingress:
            tasks = hold["tasks"]
            _require(type(tasks) is dict and set(tasks) == set(TASK_IDS)
                     and all(type(task) is dict and
                             {"state", "next_run_at", "pending_invocation"} <= set(task)
                             for task in tasks.values()), "HOST_ACTUAL_HOLD_SCHEMA_REQUIRED")
            generation = hold["operator_generation"]
            _require(type(generation) is str and 1 <= len(generation) <= 128,
                     "HOST_OPERATOR_GENERATION_REQUIRED")
            hold = dict(hold, tasks={key: task["state"] for key, task in tasks.items()},
                        next_runs=sum(task["next_run_at"] is not None for task in tasks.values()),
                        pending_tasks=sum(task["pending_invocation"] is not None for task in tasks.values()),
                        operator_generation=digest({"operator_generation": generation}))
        _require(hold["global"] == "PAUSED" and hold["reason"] == HOLD_REASON
                 and hold["tasks"] == {task: "PAUSED" for task in TASK_IDS}
                 and type(hold["next_runs"]) is int and hold["next_runs"] == 0
                 and type(hold["pending_tasks"]) is int and hold["pending_tasks"] == 0
                 and type(hold["operator_generation"]) is str
                 and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", hold["operator_generation"]),
                 "HOST_EXACT_EXISTING_HOLD_REQUIRED")
        return hold

    def _database(self, item):
        if item.get("observation") == "file_identity":
            return _database_file_identity(item, getattr(self, "existing_data_reads", None))
        path = _path(item["path"])
        _directory(path.parent)
        before = path.lstat()
        _require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                 and before.st_nlink == 1 and not before.st_mode & 0o022, "HOST_DATABASE_CONTROL_REFUSED")
        try:
            # Schema mode is only valid for a settled rollback-journal database.
            # Production preserved databases use file_identity; initial queue
            # schema/counts have their own explicitly approved snapshot reader.
            descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as stream:
                _require(_signature(os.fstat(stream.fileno())) == _signature(before),
                         "HOST_DATABASE_CHANGED")
                header = stream.read(100)
            _require(len(header) == 100 and header[:16] == b"SQLite format 3\0"
                     and header[18:20] == b"\x01\x01", "HOST_DATABASE_SCHEMA_STORAGE_UNQUALIFIED")
            for suffix in ("-wal", "-shm", "-journal"):
                sidecar = Path(str(path) + suffix)
                _require(not sidecar.exists() and not sidecar.is_symlink(),
                         "HOST_DATABASE_SCHEMA_STORAGE_UNQUALIFIED")
            connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=self._remaining(0.1))
            try:
                connection.execute("PRAGMA query_only=ON")
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                rows = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 257").fetchall()
                _require(len(rows) <= 256 and sum(len(str(row)) for row in rows) <= 65536, "HOST_DATABASE_SCHEMA_BOUND")
            finally:
                connection.close()
            after = path.lstat()
            for suffix in ("-wal", "-shm", "-journal"):
                sidecar = Path(str(path) + suffix)
                _require(not sidecar.exists() and not sidecar.is_symlink(),
                         "HOST_DATABASE_SCHEMA_STORAGE_UNQUALIFIED")
            _require(_signature(before) == _signature(after)
                     and version == item["user_version"] and digest(rows) == item["schema_sha256"],
                     "HOST_DATABASE_SCHEMA_CHANGED")
            return {"device": after.st_dev, "inode": after.st_ino, "user_version": version,
                    "schema_sha256": item["schema_sha256"]}
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_DATABASE_OBSERVATION_UNAVAILABLE") from None

    def _preserved(self, hold):
        return digest({"hold": hold, "gates": self._state_projection(self.contract["gates"]),
            "fields": {name: self._state_projection(spec) for name, spec in self.contract["preserved"].items()},
            "databases": {name: self._database(spec) for name, spec in self.contract["databases"].items()}})

    def _read_proc(self, path, maximum):
        """Read kernel proc facts; proc net tables need not be owned by the user."""
        path = Path(path)
        try:
            path.relative_to(self.proc_root)
        except ValueError:
            raise HostRefused("HOST_PROC_PATH_REFUSED") from None
        try:
            descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as stream:
                _require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "HOST_PROC_TYPE_REFUSED")
                raw = stream.read(maximum + 1)
            _require(len(raw) <= maximum, "HOST_PROC_BOUND")
            return raw
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_PROC_UNAVAILABLE") from None

    @staticmethod
    def _process_start(raw, pid):
        end = raw.rfind(b")")
        fields = raw[end + 2:].split()
        _require(raw.startswith(str(pid).encode() + b" (") and end >= 0 and len(fields) >= 20
                 and fields[19].isdigit() and int(fields[19]) > 0, "HOST_PROCESS_IDENTITY_INVALID")
        return pid, fields[19]

    def _cgroup_members(self, services):
        specification = self.contract["audit"]["processes"]
        root = _path(specification["cgroup_root"])
        members, directories = set(), []
        for unit, group in specification["groups"].items():
            path = root / group.lstrip("/")
            if not path.exists():
                _require(services[unit]["state"] == "stopped" and services[unit]["settled"]
                         and not path.is_symlink(),
                         "HOST_TARGET_CGROUP_UNAVAILABLE")
                continue
            directories.append(path)
        visited = 0
        while directories:
            self._remaining(3)
            directory = directories.pop(); visited += 1
            _require(visited <= 128 and directory.resolve() == directory
                     and stat.S_ISDIR(directory.lstat().st_mode), "HOST_CGROUP_TREE_REFUSED")
            path = directory / "cgroup.procs"
            try:
                descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(descriptor, "rb") as stream:
                    _require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "HOST_CGROUP_MEMBERSHIP_TYPE")
                    raw = stream.read(65537)
                _require(len(raw) <= 65536 and all(value.isdigit() for value in raw.split()),
                         "HOST_CGROUP_MEMBERSHIP_REFUSED")
                members.update(int(value) for value in raw.split())
                _require(len(members) <= 4096 and all(pid > 0 for pid in members), "HOST_CGROUP_MEMBER_BOUND")
                for entry in directory.iterdir():
                    if entry.is_symlink():
                        raise HostRefused("HOST_CGROUP_SYMLINK_REFUSED")
                    if entry.is_dir(): directories.append(entry)
            except HostRefused:
                raise
            except Exception:
                raise HostRefused("HOST_TARGET_CGROUP_UNAVAILABLE") from None
        escaped = set()
        for spec in specification["escaped_pid_sources"]:
            values = _project(spec)["pids"]
            _require(type(values) is list and len(values) <= 4096
                     and all(type(pid) is int and pid > 0 for pid in values),
                     "HOST_ESCAPED_PID_STATE_UNQUALIFIED")
            escaped.update(values)
        return members, escaped

    def _process_counts(self, services):
        """Scan only the reviewed target-impact graph, including owned escapes.

        Exact cgroup membership and recursive subgroups capture children retained
        by KillMode=process. Reviewed existing PID-state selectors cover work
        intentionally placed elsewhere. Unrelated shared-Hermes/Phone/Dashboard
        processes and their locks are never scanned or required to be idle.
        """
        specification = self.contract["audit"]["processes"]
        primary = {facts["pid"] for facts in services.values() if facts["state"] == "running"}
        counts = {"node_work": 0, "python_work": 0, "other_work": 0}
        members, escaped = self._cgroup_members(services)
        _require(primary <= members, "HOST_PRIMARY_CGROUP_UNQUALIFIED")
        for pid in members | escaped:
            self._remaining(3)
            directory = self.proc_root / str(pid)
            try:
                _require(directory.stat().st_uid == os.getuid(), "HOST_OWNED_PROCESS_UID_CHANGED")
                before = self._process_start(self._read_proc(directory / "stat", 8192), pid)
                executable = str((directory / "exe").resolve(strict=True))
                _require(self._process_start(self._read_proc(directory / "stat", 8192), pid) == before,
                         "HOST_PROCESS_SCAN_CHANGED")
                if pid in primary:
                    continue
                category = ("node_work" if executable in specification["node_executables"] else
                            "python_work" if executable in specification["python_executables"] else "other_work")
                counts[category] += 1
            except HostRefused:
                raise
            except Exception:
                raise HostRefused("HOST_TARGET_IMPACT_UNCERTAIN") from None
        _require(self._cgroup_members(services) == (members, escaped), "HOST_CGROUP_MEMBERS_CHANGED")
        return counts

    def _kernel_locks(self):
        held = 0
        for item in self.contract["audit"]["locks"]:
            self._remaining(3)
            path = _path(item["path"])
            if item["kind"] == "exclusive_file":
                held += int(_exclusive_lock_busy(path))
                continue
            _read(path, 16384)
            descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                before = os.fstat(descriptor)
                _require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                         and before.st_nlink == 1, "HOST_LOCK_IDENTITY_REFUSED")
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    held += 1
                else:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
                _require(_signature(before) == _signature(path.lstat()), "HOST_LOCK_CHANGED")
            finally:
                os.close(descriptor)
        return held

    def _bridge(self, binding=None, release_identity=None):
        return self._maintenance_class(self.contract["maintenance"]["root"], clock=self.clock,
            commit_verifier=lambda attempt, generation:
                self._maintenance_commit_verified(binding, release_identity, attempt, generation))

    def _maintenance_journal(self, binding, attempt=None):
        _require(binding is not None and binding.get("managed_ingress") is True,
                 "HOST_MANAGED_BINDING_REQUIRED")
        value = _json(_read(self.root / binding["request_id"] / "journal.json", 1024 * 1024))
        _require(value.get("schema") == 1 and value.get("context") == self.context
                 and value.get("request", {}).get("id") == binding["request_id"]
                 and value.get("binding") == binding and value.get("binding_digest") == digest(binding)
                 and _hex(value.get("attempt_id"), 32)
                 and (attempt is None or value["attempt_id"] == attempt),
                 "HOST_MAINTENANCE_JOURNAL_CHANGED")
        return value

    def _maintenance_commit_verified(self, binding, release_identity, attempt, generation):
        """OPEN authority is the fsynced release journal, never a caller flag."""
        if binding is None or not _hex(release_identity): return False
        journal = self._maintenance_journal(binding, attempt)
        # request_open invokes this while holding the bridge's control lock;
        # do not reacquire it. The generation was durably recorded when this
        # same attempt requested HELD, and the bridge checks current control.
        hold_proven = any(record["action"] == "exclude_ingress" and record["state"] == "COMPLETE"
                          and record.get("maintenance_generation") == generation
                          for record in self._maintenance_effect_records(binding, journal))
        self._verify_code(binding)
        wanted = journal.get("old_release") if journal.get("rollback") else journal.get("new_release")
        return (journal.get("phase") == "REOPEN_INGRESS" and journal.get("state") == "RUNNING"
                and journal.get("committed_release") == wanted == release_identity
                and type(journal.get("committed_at")) in (int, float)
                and math.isfinite(journal["committed_at"])
                and journal.get("held_health", {}).get("status") == "healthy"
                and journal["held_health"].get("release_identity") == release_identity
                and journal["held_health"].get("attempt_id") == attempt
                and hold_proven
                and self._release(binding) == release_identity)

    def _managed_process_selectors(self, services):
        """Check three initial environment selectors, without retaining other data.

        Reviewed API/KIS sources read these constants at module load and do not
        mutate process.env first. This is not a general JS environment oracle.
        """
        if "kis_checkout" not in self.contract:
            return
        service = services[SERVICES["HERMES_API"]]
        if service["state"] == "stopped" and service["settled"]:
            return
        _require(service["state"] == "running" and service["settled"],
                 "HOST_SELECTOR_PROCESS_UNSETTLED")
        expected = {b"KIS_TRADING_LAB_REPO_DIR": self.contract["kis_checkout"]["current"].encode("utf-8"),
            b"KIS_HERMES_APPROVED_SOURCE_PATH": self.contract["selectors"]["approved_kis_wrapper"]["path"].encode("utf-8"),
            b"PYTHONDONTWRITEBYTECODE": b"1"}
        pid = service["pid"]
        directory = self.proc_root / str(pid)
        try:
            before = self._process_start(self._read_proc(directory / "stat", 8192), pid)
            process_owner = directory.lstat()
            _require(stat.S_ISDIR(process_owner.st_mode) and process_owner.st_uid == os.getuid(),
                     "HOST_SELECTOR_PROCESS_OWNER_REFUSED")
            descriptor = os.open(str(directory / "environ"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            found, name, value = {}, bytearray(), bytearray()
            reading_name, selected, ignored_name, total = True, None, False, 0
            try:
                info = os.fstat(descriptor)
                _require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(),
                         "HOST_SELECTOR_ENVIRONMENT_REFUSED")
                while True:
                    self._remaining(1)
                    chunk = os.read(descriptor, 4096)
                    if not chunk: break
                    total += len(chunk)
                    _require(total <= 1024 * 1024, "HOST_SELECTOR_ENVIRONMENT_BOUND")
                    for byte in chunk:
                        if byte == 0:
                            if selected is not None:
                                _require(selected not in found, "HOST_SELECTOR_DUPLICATE")
                                found[selected] = bytes(value)
                            name.clear(); value.clear()
                            reading_name, selected, ignored_name = True, None, False
                        elif reading_name and byte == 61:
                            key = bytes(name) if not ignored_name else None
                            selected = key if key in expected else None
                            reading_name = False; name.clear()
                        elif reading_name:
                            if not ignored_name and len(name) < 128: name.append(byte)
                            else: ignored_name = True; name.clear()
                        elif selected is not None:
                            _require(len(value) < 4096, "HOST_SELECTOR_VALUE_BOUND")
                            value.append(byte)
                        # All other values are discarded, never decoded or logged.
                _require(reading_name and not name and not ignored_name and found == expected,
                         "HOST_EFFECTIVE_SELECTOR_MISMATCH")
            finally:
                os.close(descriptor)
            after_owner = directory.lstat()
            _require(self._process_start(self._read_proc(directory / "stat", 8192), pid) == before
                     and (after_owner.st_dev, after_owner.st_ino, after_owner.st_uid) ==
                         (process_owner.st_dev, process_owner.st_ino, process_owner.st_uid),
                     "HOST_SELECTOR_PROCESS_CHANGED")
        except (HostRefused, TimeoutError):
            raise
        except Exception:
            raise HostRefused("HOST_EFFECTIVE_SELECTOR_UNAVAILABLE") from None

    def _maintenance_expected_processes(self, binding, services):
        verified = self._verify_code(binding)
        for item in self.contract["selectors"].values():
            if item["path"] not in verified:
                _require(hashlib.sha256(_read(item["path"], MAX_FILE)).hexdigest() == item["sha256"],
                         "HOST_SELECTOR_CHANGED")
                verified[item["path"]] = {"sha256": item["sha256"]}
        result, boot = {}, self._boot()
        for name, unit in (("api", SERVICES["HERMES_API"]), ("relay", SERVICES["HERMES_DISCORD_RELAY"])):
            service = services[unit]
            _require(service["state"] == "running" and service["settled"], "HOST_RECEIPT_PROCESS_NOT_RUNNING")
            hashes = {label: verified[path]["sha256"]
                      for label, path in self.contract["maintenance"]["sourceFiles"][name].items()}
            packed = json.dumps(sorted(hashes.items()), separators=(",", ":"), ensure_ascii=True).encode("ascii")
            pid = service["pid"]
            ticks = self._process_start(self._read_proc(self.proc_root / str(pid) / "stat", 8192), pid)[1]
            result[name] = {"sourceId": "sha256:" + hashlib.sha256(packed).hexdigest(), "sourceHashes": hashes,
                            "processId": pid, "processStartTicks": ticks.decode("ascii"), "bootId": boot}
        return result

    def _maintenance_effect_records(self, binding, journal):
        result = []
        for effect in journal.get("effects", {}).values():
            path = self._effect_path(binding, effect["effect_id"])
            if not path.exists(): continue
            record = _json(_read(path, 131072))
            _require(record.get("binding_id") == binding["binding_id"]
                     and record.get("attempt_id") == journal["attempt_id"]
                     and record.get("effect_id") == effect["effect_id"], "HOST_EFFECT_BINDING_CHANGED")
            result.append(record)
        return result

    def _maintenance_stopped(self, binding, services, process_counts, locks):
        journal = self._maintenance_journal(binding)
        observed = self._bridge().observe_control()
        _require(observed.get("ok") is True, "HOST_MAINTENANCE_CONTROL_UNAVAILABLE")
        control = observed["control"]
        _require(control["state"] == "HELD" and control["attemptId"] == journal["attempt_id"]
                 and all(item["state"] == "stopped" and item["settled"] for item in services.values())
                 and all(value == 0 for value in process_counts.values()) and locks == 0,
                 "HOST_STOPPED_INGRESS_UNPROVEN")
        records = self._maintenance_effect_records(binding, journal)
        proofs = [record for record in records if record["action"] == "stop_services"
                  and record["state"] in ("ACCEPTED", "COMPLETE")
                  and self._quiet(record["expected"])
                  and record["expected"].get("maintenance", {}).get("control") == control
                  and record["expected"]["maintenance"].get("mode") == "live"
                  and set(record["expected"]["maintenance"].get("receipts", {})) == set(MAINTENANCE_PROVIDERS)
                  and all(value["state"] == "HELD" for value in
                          record["expected"]["maintenance"].get("receipts", {}).values())]
        _require(proofs, "HOST_STOPPED_DRAIN_PROOF_REQUIRED")
        # This is proof that no service exists, not a fresh receipt from a dead
        # PID. Publishing remains gated on independent empty cgroups and locks.
        return {"control": control, "mode": "stopped", "receipts": {}, "reopenStatus": None}

    def _maintenance_pending_receipts(self, binding, observed):
        if binding is None or not (self.root / binding["request_id"] / "journal.json").exists(): return False
        journal = self._maintenance_journal(binding)
        control = observed.get("control")
        if not (control and control["attemptId"] == journal["attempt_id"]): return False
        pending = {"EXCLUDE_INGRESS": "exclude_ingress", "START_NEW": "start_held",
                   "START_OLD": "start_held", "REOPEN_INGRESS": "reopen_ingress"}.get(journal["phase"])
        return pending is not None and any(record["action"] == pending and record["state"] == "ACCEPTED"
            for record in self._maintenance_effect_records(binding, journal))

    def _maintenance_control_guard(self, binding, control):
        if binding is None or not (self.root / binding["request_id"] / "journal.json").exists(): return
        journal = self._maintenance_journal(binding)
        holds = [record for record in self._maintenance_effect_records(binding, journal)
                 if record["action"] == "exclude_ingress" and record["state"] in ("ACCEPTED", "COMPLETE")]
        if not holds: return  # Qualification and the as-yet-unsubmitted hold effect.
        _require(len(holds) == 1 and control["attemptId"] == journal["attempt_id"]
                 and control["generation"] == holds[0].get("maintenance_generation"),
                 "HOST_MAINTENANCE_GENERATION_CHANGED")
        if control["state"] == "OPEN":
            release = journal.get("old_release") if journal.get("rollback") else journal.get("new_release")
            _require(journal["phase"] in ("REOPEN_INGRESS", "COMPLETE")
                     and journal.get("committed_release") == release,
                     "HOST_OPEN_WITHOUT_DURABLE_COMMIT")

    def _maintenance_audit(self, binding, services, hold, preserved):
        first, locks = self._process_counts(services), self._kernel_locks()
        counters = {key: 0 for key in QUIET_KEYS}
        counters.update(first); counters["writer_locks"] = locks
        scheduler = {"scheduler_count": 0, "tasks_registered": False, "compatibility": False}
        if all(value["state"] == "stopped" for value in services.values()):
            metadata = self._maintenance_stopped(binding, services, first, locks)
            excluded = True
        else:
            expected = self._maintenance_expected_processes(binding, services)
            observed = self._bridge().observe(expected)
            if observed.get("ok") is not True:
                if observed.get("code") in {"RECEIPT_GENERATION_MISMATCH", "RECEIPT_NOT_FRESH", "TRANSPORT_MISSING",
                                            "PROCESS_MISMATCH", "SOURCE_MISMATCH", "BINDING_MISMATCH"} \
                        and self._maintenance_pending_receipts(binding, observed):
                    raise TimeoutError("HOST_MAINTENANCE_ACK_PENDING")
                raise HostRefused("HOST_MAINTENANCE_RECEIPT_UNQUALIFIED")
            _require(self._maintenance_expected_processes(binding, services) == expected,
                     "HOST_MAINTENANCE_PROCESS_CHANGED")
            receipts, control = observed["receipts"], observed["control"]
            self._maintenance_control_guard(binding, control)
            _require(all(set(receipts[name]["providers"]) == providers
                         and receipts[name]["providerHealthy"] is True
                         and receipts[name]["receiptHealthy"] is True
                         for name, providers in MAINTENANCE_PROVIDERS.items()),
                     "HOST_MAINTENANCE_PROVIDER_UNQUALIFIED")
            excluded = (control["state"] == "HELD" and
                        all(value["state"] == "HELD" and value["blockedReason"] is None
                            for value in receipts.values()))
            providers = receipts["api"]["providers"]
            kis = providers["kis_scheduler"]
            counters["node_work"] += sum(value["total"] for value in receipts.values())
            counters["node_work"] += sum(int(provider["running"]) for receipt in receipts.values()
                                           for provider in receipt["providers"].values())
            counters["active_runs"] = int(kis["running"])
            counters["pending_recovery"] = sum(int(providers[name]["running"]) for name in
                                               ("kis_recovery", "kis_state_fault_notification"))
            scheduler = {"scheduler_count": int(kis["ownerActive"]),
                         "tasks_registered": kis.get("configured") is True and kis.get("taskCount") == len(TASK_IDS),
                         "compatibility": kis.get("faulted") is False}
            metadata = {"control": control, "mode": "live", "reopenStatus": observed.get("reopenStatus"),
                        "receipts": {name: {key: receipt[key] for key in
                            ("sourceId", "sourceHashes", "processId", "processInstanceId", "processStartTicks", "bootId",
                             "attemptId", "generation", "state", "blockedReason", "providers")}
                            for name, receipt in receipts.items()}}
        _require(self._process_counts(services) == first and self._kernel_locks() == locks,
                 "HOST_INDEPENDENT_FACTS_CHANGED")
        return (dict(counters, **scheduler, ingress_excluded=excluded, observed_at=self.clock(),
                     boot_id=self._boot(), operator_generation=hold["operator_generation"],
                     services=services, preserved_identity=preserved), metadata)

    def _runtime_audit(self, binding, services, hold, preserved):
        self._remaining(3)
        specification = self.contract["audit"]
        counters = _project(specification["counters"])
        for key, value in counters.items():
            if type(value) in (list, dict):
                value = len(value)
            _require(type(value) is int and 0 <= value <= 1000000, "HOST_WORK_STATE_SCHEMA_REFUSED")
            counters[key] = value
        ingress = _project(specification["ingress"])
        scheduler = _project(specification["scheduler"])
        first = self._process_counts(services)
        locks = self._kernel_locks()
        _require(self._process_counts(services) == first
                 and _project(specification["ingress"]) == ingress
                 and _project(specification["scheduler"]) == scheduler,
                 "HOST_INDEPENDENT_FACTS_CHANGED")
        for key, count in first.items():
            counters[key] += count
        counters["writer_locks"] += locks
        # Every returned value is measured now; no claimed receipt-file timestamp
        # or caller-provided zero-work assertion is promoted to independent proof.
        return dict(counters, **ingress, **scheduler, observed_at=self.clock(),
                    boot_id=self._boot(), operator_generation=hold["operator_generation"],
                    services=services, preserved_identity=preserved)

    def _health_socket_owned(self, services):
        pid = services[SERVICES["HERMES_API"]]["pid"]
        _require(pid > 0, "HOST_API_NOT_RUNNING")
        parts = _url(self.contract["health"]["url"])
        directory = self.proc_root / str(pid)
        try:
            entries = list((directory / "fd").iterdir())
            _require(len(entries) <= 4096, "HOST_API_FD_BOUND")
            sockets = set()
            for entry in entries:
                target = os.readlink(entry)
                match = re.fullmatch(r"socket:\[([0-9]+)\]", target)
                if match:
                    sockets.add(match[1])
            table = directory / "net" / ("tcp" if parts.hostname == "127.0.0.1" else "tcp6")
            raw = self._read_proc(table, 262144)
            matches = []
            for line in raw.decode("ascii").splitlines()[1:]:
                columns = line.split()
                _require(len(columns) >= 10, "HOST_TCP_METADATA_INVALID")
                address, port = columns[1].split(":")
                if columns[3] == "0A" and int(port, 16) == parts.port and columns[9] in sockets:
                    expected = {"0100007F", "00000000"} if parts.hostname == "127.0.0.1" else {
                        "00000000000000000000000001000000", "00000000000000000000000000000000"}
                    if address in expected:
                        matches.append(columns[9])
            _require(len(matches) == 1, "HOST_HEALTH_SOCKET_UNQUALIFIED")
        except HostRefused:
            raise
        except Exception:
            raise HostRefused("HOST_HEALTH_SOCKET_UNAVAILABLE") from None

    def _effects(self, binding):
        path = self.root / binding["request_id"]
        result = {}
        if not path.exists():
            return result
        for item in sorted(path.glob("host-effect-*.json")):
            _require(len(result) < 32, "HOST_EFFECT_BOUND")
            record = _json(_read(item, 131072))
            _require(record.get("binding_id") == binding["binding_id"], "HOST_EFFECT_BINDING_CHANGED")
            if record.get("state") == "COMPLETE":
                result[record["effect_id"]] = {"attempt_id": record["attempt_id"],
                                              "effect_id": record["effect_id"], "complete": True}
        return result

    def _network(self, services):
        try:
            return application_network.observe(self.proc_root, services, self.contract["network"],
                                               self._read_proc, self._remaining)
        except application_network.NetworkRefused as error:
            raise HostRefused(str(error)) from None

    def _facts(self, binding=None):
        self._check_contract()
        boot = self._boot()
        selector_identity = self._selectors()
        units = {name: self._unit(name) for name in ROLES.values()}
        services, hold = self._services(units), self._hold()
        self._managed_process_selectors(services)
        network = self._network(services)
        self._verify_code(binding)
        watchers = {}
        for name in WATCHERS.values():
            item = units[name]
            _require(item["UnitFileState"] in ("enabled", "disabled", "static")
                     and item["ActiveState"] in ("active", "inactive"), "HOST_WATCHER_STATE_UNRESOLVED")
            watchers[name] = {"active": item["ActiveState"] == "active",
                              "enabled": item["UnitFileState"] == "enabled",
                              "settled": item["Job"] in ("", "0")
                              and (name == WATCHERS["timer"] or item["ControlPID"] == "0")}
        preserved = self._preserved(hold)
        maintenance = None
        try:
            if self.managed_ingress:
                audit, maintenance = self._maintenance_audit(binding, services, hold, preserved)
            else:
                audit = self.audit_reader(binding, services, hold, preserved)
            self._remaining(3)
        except (HostRefused, TimeoutError):
            raise
        except Exception:
            raise HostRefused("HOST_INDEPENDENT_AUDIT_UNAVAILABLE") from None
        _keys(audit, AUDIT_FIELDS, "HOST_INDEPENDENT_AUDIT_FIELDS_REFUSED")
        observed = audit["observed_at"]
        _require(type(observed) in (int, float) and math.isfinite(observed)
                 and self.clock() - 5 <= observed <= self.clock() + 1
                 and audit["boot_id"] == boot
                 and audit["operator_generation"] == hold["operator_generation"]
                 and audit["services"] == services, "HOST_INDEPENDENT_OBSERVATION_STALE")
        _require(all(type(audit[key]) is int and 0 <= audit[key] <= 1000000 for key in QUIET_KEYS)
                 and type(audit["ingress_excluded"]) is bool
                 and type(audit["scheduler_count"]) is int and 0 <= audit["scheduler_count"] <= 100
                 and type(audit["tasks_registered"]) is bool and type(audit["compatibility"]) is bool,
                 "HOST_INDEPENDENT_OBSERVATION_REFUSED")
        _require(audit["preserved_identity"] == preserved, "HOST_PRESERVED_AUDIT_CHANGED")
        for name, before in units.items():
            _require(self._unit(name) == before, "HOST_UNIT_CHANGED_DURING_OBSERVATION")
        _require(self._network(services) == network, "HOST_NETWORK_CHANGED_DURING_OBSERVATION")
        self._managed_process_selectors(services)
        _require(self._hold() == hold and self._selectors() == selector_identity and self._boot() == boot,
                 "HOST_STATE_CHANGED_DURING_OBSERVATION")
        result = {"boot_id": boot, "unit_identity": self._unit_identity(), "selector_identity": selector_identity,
            "operator_generation": hold["operator_generation"], "observed_at": self.clock(),
            "services": services, "watchers": watchers,
            "hold": {key: hold[key] for key in ("global", "reason", "tasks")},
            "ingress_excluded": audit["ingress_excluded"],
            "quiescence": dict({key: audit[key] for key in QUIET_KEYS}, independently_observed=True),
            "preserved_identity": preserved,
            "scheduler": {key: audit[key] for key in ("scheduler_count", "tasks_registered", "compatibility")},
            "effect_receipts": self._effects(binding) if binding is not None else {}}
        if binding is not None:
            result.update(binding_id=binding["binding_id"], lease_owner=binding["request_id"])
        if maintenance is not None: result["maintenance"] = maintenance
        return result

    def observe(self, binding):
        _require(self.validate_binding(binding), "HOST_BINDING_CHANGED")
        result = self._facts(binding)
        self._reconcile(binding, result)
        result["effect_receipts"] = self._effects(binding)
        return result

    def idle_maintenance_identity(self):
        """Bridge-free, read-only identity for an already accepted same source.

        The idle OPEN commit verifier calls this with the bridge control lock
        held. Do not call _facts, _maintenance_audit, or any bridge method here.
        Current bytes are checked against baseline plus verified terminal
        journals; observed bytes never become a new accepted baseline.
        """
        _require(self.managed_ingress, "HOST_MANAGED_MAINTENANCE_REQUIRED")
        self._check_contract()
        accepted = self._verify_code()
        units = {name: self._unit(name) for name in ROLES.values()}
        services = self._services(units)
        hold, selectors = self._hold(), self._selectors()
        preserved, network = self._preserved(hold), self._network(services)
        expected = self._maintenance_expected_processes(None, services)
        result = {"context": copy.deepcopy(self.context), "contract_sha256": self.contract_sha256,
            "application_scope_sha256": self.contract["application_scope_sha256"],
            "accepted_code": accepted, "unit_identity": self._unit_identity(),
            "selector_identity": selectors, "hold": hold, "preserved_identity": preserved,
            "services": services, "network": network, "expected_processes": expected}
        _require(all(self._unit(name) == value for name, value in units.items())
                 and self._verify_code() == accepted and self._hold() == hold
                 and self._selectors() == selectors and self._preserved(hold) == preserved
                 and self._network(services) == network
                 and self._maintenance_expected_processes(None, services) == expected,
                 "HOST_IDLE_IDENTITY_CHANGED")
        self._check_contract()
        return result

    def idle_maintenance_health(self):
        """Normal fresh health/quiet proof after the idle HELD generation lands."""
        _require(self.managed_ingress, "HOST_MANAGED_MAINTENANCE_REQUIRED")
        current = self._facts()
        target = self.target or next(target for target in sorted(TARGETS)
                                     if self.registry["targets"].get(target) is not None)
        binding = self._binding_template(target)
        release = self._release(binding)
        health = self._health_facts(current, release, self._facts, lambda: self._release(binding))
        return {"quiet": self._quiet(current), "healthy": health["status"] == "healthy"}

    def readonly(self, job):
        target = job.get("target")
        _require(target in TARGETS and (self.target is None or target == self.target)
                 and job.get("operation") in ("deploy.status", "deploy.health", "deploy.verify"),
                 "HOST_READONLY_JOB_REFUSED")
        # Reading never acquires/creates the mutation lock or reconciles effect
        # journals. Report active maintenance explicitly instead of racing it.
        for directory in (self.root.iterdir() if self.root.exists() else []):
            self._remaining(3)
            if directory.name.startswith("."): continue
            journal = _json(_read(directory / "journal.json", 1024 * 1024))
            if journal.get("state") not in ("HELD_DEPLOYED", "HELD_ROLLED_BACK"):
                return {"target": target, "status": "unknown", "reason": "APPLICATION_TRANSACTION_ACTIVE",
                        "financial_activation": False}
        template = self._binding_template(target)
        current = self._facts()
        release = self._release(template)
        health = self._health_facts(current, release, self._facts, lambda: self._release(template))
        result = {"target": target, "release_identity": release, "services": current["services"],
                  "hold": current["hold"], "quiescence": current["quiescence"], "health": health,
                  "financial_activation": False}
        if job["operation"] == "deploy.verify":
            source, manifest_sha256 = self._candidate_for_job(job, allow_preview=True)
            manifest = _json(source["manifest"])
            if manifest["schema"] == 1:
                result["candidate"] = {"manifest_sha256": manifest_sha256, "qualified": True}
            else:
                result["candidate"] = {"manifest_sha256": manifest_sha256, "preparation_only": True,
                    "deployed": False, "sealed": all(item["output"]["sha256"] is not None
                                                       for item in manifest["files"].values()),
                    "outputs": {name: {"sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)}
                                for name, raw in source["files"].items()}}
        return result

    @staticmethod
    def _cas(snapshot):
        result = copy.deepcopy({key: value for key, value in snapshot.items()
                                if key not in ("observed_at", "effect_receipts")})
        # This monotonically advancing age is freshly checked on both sides of
        # health, but is not a process/source or business-state identity.
        for receipt in result.get("maintenance", {}).get("receipts", {}).values():
            receipt.get("providers", {}).get("discord_relay", {}).pop("heartbeatAckAgeMs", None)
        return result

    @staticmethod
    def _quiet(snapshot):
        return snapshot["ingress_excluded"] is True and all(snapshot["quiescence"][key] == 0 for key in QUIET_KEYS)

    def _effect_path(self, binding, effect):
        _require(_hex(effect, 32), "HOST_EFFECT_ID_REFUSED")
        return _directory(self.root / binding["request_id"]) / ("host-effect-" + effect + ".json")

    def _satisfied(self, record, current):
        action = record["action"]
        if action == "suspend_watchers":
            return all(not value["active"] and value["settled"] for value in current["watchers"].values())
        if action == "enter_hold":
            return True  # observe independently rejects anything except the exact existing hold.
        if action == "exclude_ingress":
            if not self.managed_ingress: return current["ingress_excluded"] is True
            control = current.get("maintenance", {}).get("control", {})
            return (current["ingress_excluded"] is True and control.get("state") == "HELD"
                    and control.get("attemptId") == record["attempt_id"]
                    and control.get("generation") == record.get("maintenance_generation"))
        if action == "reopen_ingress":
            control = current.get("maintenance", {}).get("control", {})
            return (self.managed_ingress and current["ingress_excluded"] is False
                    and current.get("maintenance", {}).get("reopenStatus") == "OPEN"
                    and control.get("state") == "OPEN" and control.get("attemptId") == record["attempt_id"]
                    and control.get("generation") == record.get("maintenance_generation"))
        if action == "stop_services":
            return all(value["state"] == "stopped" and value["settled"] for value in current["services"].values())
        if action == "start_held":
            previous = record["expected"]["services"]
            return all(value["state"] == "running" and value["settled"]
                       and value["invocation_id"] != previous[name]["invocation_id"]
                       for name, value in current["services"].items())
        if action == "restore_watchers":
            return current["watchers"] == record["details"]["watchers"]
        return False

    def _reconcile(self, binding, current):
        directory = self.root / binding["request_id"]
        if not directory.exists():
            return
        paths = list(directory.glob("host-effect-*.json"))
        _require(len(paths) <= 32, "HOST_EFFECT_BOUND")
        for path in paths:
            record = _json(_read(path, 131072))
            if record.get("state") != "ACCEPTED":
                continue
            expected = record["expected"]
            _require(record["binding_id"] == binding["binding_id"]
                     and all(current[key] == expected[key] for key in
                             ("operator_generation", "preserved_identity", "unit_identity", "selector_identity"))
                     and all(value["enabled"] == expected["watchers"][name]["enabled"]
                             for name, value in current["watchers"].items()), "HOST_EFFECT_GUARD_CHANGED")
            if self._satisfied(record, current):
                if record["action"] == "stop_services":
                    self.restore_nonforcing_stop(binding, current)
                record["state"] = "COMPLETE"
                _atomic(path, record)

    def _action(self, action, binding, expected, attempt, effect, details):
        _require(action in EFFECTS and _hex(attempt, 32), "HOST_EFFECT_REFUSED")
        current = self.observe(binding)
        _require(self._cas(current) == self._cas(expected), "HOST_EFFECT_CAS_FAILED")
        path = self._effect_path(binding, effect)
        if path.exists():
            record = _json(_read(path, 131072))
            _require(record["attempt_id"] == attempt and record["action"] == action
                     and record["details"] == details and record["binding_id"] == binding["binding_id"],
                     "HOST_EFFECT_ID_REUSED")
            _require(record["state"] == "COMPLETE", "HOST_EFFECT_OUTCOME_UNKNOWN")
            return
        suspended = all(not value["active"] and value["settled"] for value in current["watchers"].values())
        if action == "enter_hold":
            _require(details == {"reason": HOLD_REASON} and suspended, "HOST_HOLD_ACTION_REFUSED")
        elif action == "exclude_ingress":
            _require(details == {} and suspended and (self.managed_ingress or current["ingress_excluded"]),
                     "HOST_INGRESS_EXCLUSION_REQUIRED")
            if self.managed_ingress:
                journal = self._maintenance_journal(binding, attempt)
                _require(journal["phase"] == "EXCLUDE_INGRESS", "HOST_MAINTENANCE_PHASE_CHANGED")
                planned = journal.get("effects", {}).get("exclude_ingress", {})
                _require(planned.get("effect_id") == effect and planned.get("attempt_id") == attempt
                         and self._cas(planned.get("expected", {})) == self._cas(expected),
                         "HOST_MAINTENANCE_EFFECT_UNPLANNED")
        elif action == "stop_services":
            _require(details == {} and suspended and self._quiet(current), "HOST_INDEPENDENT_QUIESCENCE_REQUIRED")
        elif action == "start_held":
            _keys(details, ("release_identity",), "HOST_START_DETAILS_REFUSED"); _hash(details["release_identity"])
            _require(suspended and self._quiet(current)
                     and all(value["state"] == "stopped" and value["settled"] for value in current["services"].values()),
                     "HOST_HELD_STOPPED_START_REQUIRED")
            _require(self._release(binding) == details["release_identity"], "HOST_START_RELEASE_CHANGED")
        elif action == "restore_watchers":
            _keys(details, ("watchers",), "HOST_WATCHER_DETAILS_REFUSED")
            _keys(details["watchers"], WATCHERS.values(), "HOST_WATCHER_DETAILS_REFUSED")
            _require(all(type(value) is dict and set(value) == {"active", "enabled", "settled"}
                         and all(type(flag) is bool for flag in value.values())
                         and value["enabled"] == current["watchers"][name]["enabled"]
                         for name, value in details["watchers"].items()), "HOST_WATCHER_ENABLEMENT_REFUSED")
            _require(self.health(binding, current, attempt, self._release(binding))["status"] == "healthy",
                     "HOST_HELD_HEALTH_REQUIRED")
        elif action == "reopen_ingress":
            _keys(details, ("release_identity",), "HOST_OPEN_DETAILS_REFUSED")
            _hash(details["release_identity"])
            _require(self.managed_ingress and self._quiet(current), "HOST_OPEN_REQUIRES_DRAINED")
            control = current["maintenance"]["control"]
            _require(self._maintenance_commit_verified(binding, details["release_identity"], attempt,
                                                       control["generation"]), "HOST_OPEN_COMMIT_UNPROVEN")
            planned = self._maintenance_journal(binding, attempt).get("effects", {}).get("reopen_ingress", {})
            _require(planned.get("effect_id") == effect and planned.get("attempt_id") == attempt
                     and self._cas(planned.get("expected", {})) == self._cas(expected),
                     "HOST_MAINTENANCE_EFFECT_UNPLANNED")
        else:
            _require(details == {}, "HOST_EFFECT_DETAILS_REFUSED")
        record = {"binding_id": binding["binding_id"], "attempt_id": attempt, "effect_id": effect,
                  "action": action, "details": details, "expected": current, "state": "INTENT"}
        _atomic(path, record)  # Intent survives a timeout; an ambiguous external effect is NEVER retried.
        if action == "suspend_watchers":
            self._run(["stop", "--no-block", WATCHERS["timer"]])
            # No kill of an active watchdog oneshot. Reconciliation waits for natural completion.
        elif action == "exclude_ingress" and self.managed_ingress:
            observed = self._bridge().request_hold(attempt)
            _require(observed.get("ok") is True and observed.get("control", {}).get("state") == "HELD"
                     and observed["control"]["attemptId"] == attempt, "HOST_HOLD_CONTROL_OUTCOME_UNKNOWN")
            record["maintenance_generation"] = observed["control"]["generation"]
        elif action == "reopen_ingress":
            observed = self._bridge(binding, details["release_identity"]).request_open(attempt,
                current["maintenance"]["control"]["generation"],
                self._maintenance_expected_processes(binding, current["services"]))
            _require(observed.get("ok") is True and observed.get("committedOpen") is True,
                     "HOST_OPEN_CONTROL_OUTCOME_UNKNOWN")
            record["maintenance_generation"] = observed["control"]["generation"]
        elif action == "stop_services":
            self.prepare_nonforcing_stop(binding, current, attempt, effect)
            for name in SERVICES.values():
                _require(self._unit(name)["SendSIGKILL"] == "no", "HOST_NONFORCING_STOP_REQUIRED")
            self._run(["stop", "--no-block", SERVICES["HERMES_DISCORD_RELAY"], SERVICES["HERMES_API"]])
        elif action == "start_held":
            self._run(["start", "--no-block", SERVICES["HERMES_API"], SERVICES["HERMES_DISCORD_RELAY"]])
        elif action == "restore_watchers":
            names = [name for name, facts in details["watchers"].items() if facts["active"]]
            if names:
                self._run(["start", "--no-block"] + names)
        record["state"] = "ACCEPTED"
        _atomic(path, record)

    def _release(self, binding):
        backend = self.directory_backend(binding["target"])
        if backend is not None:
            return backend.current_identity(self._kis_journal(binding))["release_identity"]
        return digest({name: hashlib.sha256(_read(item["path"], MAX_FILE)).hexdigest()
                       for name, item in binding["files"].items()})

    def health(self, binding, snapshot, attempt_id, release_identity):
        current = self.observe(binding)
        _require(self._cas(current) == self._cas(snapshot), "HOST_HEALTH_CAS_FAILED")
        return self._health_facts(current, release_identity, lambda: self.observe(binding),
                                  lambda: self._release(binding), attempt_id)

    def _health_facts(self, current, release_identity, refresh, current_release, attempt_id=None):
        base = {"status": "unknown", "attempt_id": attempt_id, "release_identity": release_identity,
                "services": current["services"], "preserved_identity": current["preserved_identity"],
                "held": True, "scheduler_count": 0, "tasks_registered": False, "compatibility": False,
                "observed_at": self.clock()}
        open_current = (self.managed_ingress and attempt_id is None
                        and current.get("maintenance", {}).get("reopenStatus") == "OPEN")
        if (not self._quiet(current) and not open_current) or current_release() != release_identity:
            return base
        try:
            _require(all(value["state"] == "running" and value["settled"]
                         for value in current["services"].values()), "HOST_HEALTH_PROCESS_UNSETTLED")
            self._health_socket_owned(current["services"])
            response = self.http_get(self.contract["health"]["url"], timeout=self._remaining(3), maximum=65536)
            self._remaining(3)
            _keys(response, ("status", "body"), "HOST_HEALTH_RESPONSE_REFUSED")
            _require(response["status"] == 200 and type(response["body"]) is bytes
                     and len(response["body"]) <= 65536, "HOST_HEALTH_RESPONSE_REFUSED")
            body = _json(response["body"])
            healthy = True
            for check in self.contract["health"]["api_checks"]:
                value = body
                for key in check["path"]:
                    _require(type(value) is dict and key in value, "HOST_API_HEALTH_SCHEMA_CHANGED")
                    value = value[key]
                healthy &= type(value) is type(check["equals"]) and value == check["equals"]
            if self.managed_ingress:
                healthy &= self._maintenance_relay_ready(current)
            else:
                relay = _project(self.contract["health"]["relay"])
                _require(type(relay["ready"]) is bool and type(relay["observed_at"]) in (int, float)
                         and math.isfinite(relay["observed_at"])
                         and self.clock() - 5 <= relay["observed_at"] <= self.clock() + 1,
                         "HOST_RELAY_HEALTH_UNQUALIFIED")
                healthy &= relay["ready"]
            after = refresh()
            self._health_socket_owned(after["services"])
            _require(self._cas(after) == self._cas(current) and current_release() == release_identity,
                     "HOST_HEALTH_PROCESS_CHANGED")
            if self.managed_ingress: healthy &= self._maintenance_relay_ready(after)
            scheduler = current["scheduler"]
            held_compatible = (scheduler["scheduler_count"] == 1 and scheduler["tasks_registered"] is True
                               and scheduler["compatibility"] is True)
            base.update(status="healthy" if healthy and held_compatible else "unhealthy", **scheduler)
        except Exception:
            return base
        return base

    @staticmethod
    def _maintenance_relay_ready(current):
        metadata = current.get("maintenance", {})
        if metadata.get("mode") != "live": return False
        relay = metadata.get("receipts", {}).get("relay", {})
        if relay.get("blockedReason") is not None: return False
        provider = relay.get("providers", {}).get("discord_relay", {})
        interval, age = provider.get("heartbeatIntervalMs"), provider.get("heartbeatAckAgeMs")
        return (provider.get("transportConnected") is True and provider.get("transportReady") is True
                and type(provider.get("sessionGeneration")) is int and provider["sessionGeneration"] > 0
                and type(interval) is int and interval > 0 and type(age) is int
                and 0 <= age <= min(120000, 2 * interval))


for _action_name in sorted(EFFECTS):
    def _method(self, binding, expected_snapshot, attempt_id, effect_id, details, _name=_action_name):
        return self._action(_name, binding, expected_snapshot, attempt_id, effect_id, details)
    setattr(ApplicationHost, _action_name, _method)
