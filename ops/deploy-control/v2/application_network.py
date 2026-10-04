"""Bounded service-owned listening/bound socket facts; no address disclosure.

This checks local TCP listeners and bound UDP endpoints in the updater's network
namespace. It does not constrain outbound destinations or sandbox trusted code.
"""
import hashlib
import ipaddress
import struct
import os
from pathlib import Path
import re

import authority


class NetworkRefused(ValueError):
    pass


def validate(value, services):
    if (not isinstance(value, dict) or set(value) != {'namespace', 'services'}
            or value['namespace'] != 'same-as-updater'
            or not isinstance(value['services'], dict) or set(value['services']) != set(services)):
        raise NetworkRefused('NETWORK_CONTRACT_REQUIRED')
    for entries in value['services'].values():
        if not isinstance(entries, list) or len(entries) > 64:
            raise NetworkRefused('NETWORK_ENDPOINT_BOUND')
        seen = set()
        for item in entries:
            if (not isinstance(item, dict) or set(item) != {'protocol', 'family', 'address_sha256', 'port'}
                    or item['protocol'] not in ('tcp', 'udp') or item['family'] not in ('ipv4', 'ipv6')
                    or type(item['port']) is not int or not 0 < item['port'] < 65536):
                raise NetworkRefused('NETWORK_ENDPOINT_INVALID')
            authority.hash_value(item['address_sha256'], 'NETWORK_ADDRESS_HASH_INVALID')
            token = authority.digest(item)
            if token in seen: raise NetworkRefused('NETWORK_ENDPOINT_DUPLICATE')
            seen.add(token)
    return value


def address_hash(kernel_address):
    # /proc formats each native-endian 32-bit address word as hex. Convert
    # to canonical ipaddress text, matching the qualified VM report format.
    if not re.fullmatch(r'(?:[0-9A-F]{8}|[0-9A-F]{32})', kernel_address):
        raise NetworkRefused('NETWORK_ADDRESS_INVALID')
    raw = b''.join(struct.pack('=I', int(kernel_address[index:index + 8], 16))
                   for index in range(0, len(kernel_address), 8))
    text = str(ipaddress.ip_address(raw))
    return hashlib.sha256(text.encode('ascii')).hexdigest()


def _namespace(path):
    value = os.readlink(path)
    if not re.fullmatch(r'net:\[[0-9]+\]', value):
        raise NetworkRefused('NETWORK_NAMESPACE_INVALID')
    return value


def _sockets(directory, remaining):
    result, count = set(), 0
    for entry in (directory / 'fd').iterdir():
        remaining(3); count += 1
        if count > 4096: raise NetworkRefused('NETWORK_FD_BOUND')
        value = os.readlink(entry)
        match = re.fullmatch(r'socket:\[([0-9]+)\]', value)
        if match: result.add(match[1])
    return result


def observe(proc_root, services, contract, read_proc, remaining):
    validate(contract, services)
    root = Path(proc_root)
    namespace = _namespace(root / 'self/ns/net')
    result = {}
    for name, facts in services.items():
        remaining(3)
        if facts['state'] != 'running':
            result[name] = []
            continue
        pid = facts['pid']
        if type(pid) is not int or pid <= 0: raise NetworkRefused('NETWORK_PROCESS_INVALID')
        directory = root / str(pid)
        if _namespace(directory / 'ns/net') != namespace:
            raise NetworkRefused('NETWORK_NAMESPACE_CHANGED')
        sockets = _sockets(directory, remaining)
        entries = []
        for filename, protocol, family in (('tcp', 'tcp', 'ipv4'), ('tcp6', 'tcp', 'ipv6'),
                                            ('udp', 'udp', 'ipv4'), ('udp6', 'udp', 'ipv6')):
            raw = read_proc(directory / 'net' / filename, 262144)
            for line in raw.decode('ascii').splitlines()[1:]:
                remaining(3)
                columns = line.split()
                if len(columns) < 10: raise NetworkRefused('NETWORK_TABLE_INVALID')
                if columns[9] not in sockets or (protocol == 'tcp' and columns[3] != '0A'):
                    continue
                address, port = columns[1].split(':')
                length = 8 if family == 'ipv4' else 32
                if not re.fullmatch('[0-9A-F]{%d}' % length, address):
                    raise NetworkRefused('NETWORK_ADDRESS_INVALID')
                number = int(port, 16)
                if number == 0: continue
                entries.append({'protocol': protocol, 'family': family,
                    'address_sha256': address_hash(address), 'port': number})
                if len(entries) > 64: raise NetworkRefused('NETWORK_ENDPOINT_BOUND')
        if (_sockets(directory, remaining) != sockets or _namespace(directory / 'ns/net') != namespace):
            raise NetworkRefused('NETWORK_FACTS_CHANGED')
        entries.sort(key=authority.digest)
        if entries != sorted(contract['services'][name], key=authority.digest):
            raise NetworkRefused('NETWORK_ENDPOINT_SET_CHANGED')
        result[name] = entries
    if _namespace(root / 'self/ns/net') != namespace:
        raise NetworkRefused('NETWORK_NAMESPACE_CHANGED')
    return {'namespace_sha256': hashlib.sha256(namespace.encode('ascii')).hexdigest(), 'services': result}
