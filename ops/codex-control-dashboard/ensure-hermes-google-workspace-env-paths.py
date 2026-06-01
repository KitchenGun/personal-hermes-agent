\
#!/usr/bin/env python3
"""Ensure Hermes Google Workspace scripts respect profile/env token paths."""

from __future__ import annotations

from pathlib import Path

ROOT = Path('/home/ubuntu/.hermes/hermes-agent')
SCRIPTS = ROOT / 'skills/productivity/google-workspace/scripts'
GOOGLE_API = SCRIPTS / 'google_api.py'
GWS_BRIDGE = SCRIPTS / 'gws_bridge.py'
SETUP = SCRIPTS / 'setup.py'

PATH_HELPER = '''\n\ndef _path_from_env(name: str, default: Path) -> Path:\n    return Path(os.environ.get(name, str(default))).expanduser()\n'''
TOKEN_BLOCK = '''TOKEN_PATH = _path_from_env(\n    "GOOGLE_WORKSPACE_TOKEN_PATH",\n    HERMES_HOME / "google_token.json",\n)\nCLIENT_SECRET_PATH = _path_from_env(\n    "GOOGLE_WORKSPACE_CLIENT_SECRET_PATH",\n    HERMES_HOME / "google_client_secret.json",\n)'''


def patch_token_constants(path: Path) -> bool:
    text = path.read_text()
    changed = False
    if 'def _path_from_env(name: str, default: Path) -> Path:' not in text:
        marker = 'HERMES_HOME = get_hermes_home()\n'
        if marker not in text:
            raise RuntimeError(f'HERMES_HOME marker not found: {path}')
        text = text.replace(marker, marker + PATH_HELPER + '\n', 1)
        changed = True
    old = '''TOKEN_PATH = HERMES_HOME / "google_token.json"\nCLIENT_SECRET_PATH = HERMES_HOME / "google_client_secret.json"'''
    if old in text:
        text = text.replace(old, TOKEN_BLOCK, 1)
        changed = True
    elif TOKEN_BLOCK not in text:
        raise RuntimeError(f'token constant block not found: {path}')
    if path == SETUP:
        old_msg = 'print(f"Profile-scoped token location: {display_hermes_home()}/google_token.json")'
        new_msg = 'print(f"Profile-scoped token location: {TOKEN_PATH}")'
        if old_msg in text:
            text = text.replace(old_msg, new_msg, 1)
            changed = True
    if changed:
        path.write_text(text)
    return changed


def patch_bridge(path: Path) -> bool:
    text = path.read_text()
    old = '''def get_token_path() -> Path:\n    return get_hermes_home() / "google_token.json"\n'''
    new = '''def get_token_path() -> Path:\n    default = get_hermes_home() / "google_token.json"\n    return Path(os.environ.get("GOOGLE_WORKSPACE_TOKEN_PATH", str(default))).expanduser()\n'''
    if new in text:
        return False
    if old not in text:
        raise RuntimeError(f'gws bridge token path block not found: {path}')
    path.write_text(text.replace(old, new, 1))
    return True


def main() -> int:
    changed = []
    for path in (GOOGLE_API, SETUP):
        if patch_token_constants(path):
            changed.append(str(path))
    if patch_bridge(GWS_BRIDGE):
        changed.append(str(GWS_BRIDGE))
    if changed:
        print('google workspace env path policy repaired')
        for item in changed:
            print(f'restored: {item}')
    else:
        print('google workspace env path policy ok')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
