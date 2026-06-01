#!/usr/bin/env python3
# Ensure Hermes Kanban dispatch uses the configured stale-running timeout.
from __future__ import annotations

from pathlib import Path

ROOT = Path('/home/ubuntu/.hermes/hermes-agent')
KANBAN = ROOT / 'hermes_cli' / 'kanban.py'
GATEWAY = ROOT / 'gateway' / 'run.py'


def patch_kanban(path: Path) -> bool:
    text = path.read_text()
    changed = False
    helper_marker = 'def _kanban_dispatch_stale_timeout_seconds(config: dict[str, Any]) -> int:'
    if helper_marker not in text:
        marker = 'def _cmd_dispatch(args: argparse.Namespace) -> int:\n    # Honour kanban.default_assignee as the fallback for unassigned ready\n'
        helper = '''def _kanban_dispatch_stale_timeout_seconds(config: dict[str, Any]) -> int:
    from hermes_cli.config import DEFAULT_CONFIG

    default_value = int(DEFAULT_CONFIG.get("kanban", {}).get("dispatch_stale_timeout_seconds", 14400) or 14400)
    raw_value = config.get("dispatch_stale_timeout_seconds", default_value) if isinstance(config, dict) else default_value
    try:
        value = int(raw_value if raw_value is not None else default_value)
    except (TypeError, ValueError):
        return default_value
    return value if value >= 0 else default_value


'''
        if marker not in text:
            raise RuntimeError(f'kanban dispatch marker not found: {path}')
        text = text.replace(marker, helper + marker, 1)
        changed = True
    if 'stale_timeout_seconds = _kanban_dispatch_stale_timeout_seconds(_kanban_cfg)' not in text:
        marker = '''        max_in_progress = _coerce_positive_int(_kanban_cfg.get("max_in_progress"))
        # CLI --max overrides config kanban.max_spawn when both are present;
'''
        repl = '''        max_in_progress = _coerce_positive_int(_kanban_cfg.get("max_in_progress"))
        stale_timeout_seconds = _kanban_dispatch_stale_timeout_seconds(_kanban_cfg)
        # CLI --max overrides config kanban.max_spawn when both are present;
'''
        if marker not in text:
            raise RuntimeError(f'kanban stale insert marker not found: {path}')
        text = text.replace(marker, repl, 1)
        changed = True
    if 'stale_timeout_seconds = _kanban_dispatch_stale_timeout_seconds({})' not in text:
        marker = '''        max_in_progress = None
        max_spawn = getattr(args, "max", None)
'''
        repl = '''        max_in_progress = None
        stale_timeout_seconds = _kanban_dispatch_stale_timeout_seconds({})
        max_spawn = getattr(args, "max", None)
'''
        if marker not in text:
            raise RuntimeError(f'kanban fallback marker not found: {path}')
        text = text.replace(marker, repl, 1)
        changed = True
    if 'stale_timeout_seconds=stale_timeout_seconds' not in text:
        marker = '''            failure_limit=getattr(args, "failure_limit", kb.DEFAULT_SPAWN_FAILURE_LIMIT),
            default_assignee=default_assignee,
'''
        repl = '''            failure_limit=getattr(args, "failure_limit", kb.DEFAULT_SPAWN_FAILURE_LIMIT),
            stale_timeout_seconds=stale_timeout_seconds,
            default_assignee=default_assignee,
'''
        if marker not in text:
            raise RuntimeError(f'kanban dispatch call marker not found: {path}')
        text = text.replace(marker, repl, 1)
        changed = True
    if changed:
        path.write_text(text)
    return changed


def patch_gateway(path: Path) -> bool:
    text = path.read_text()
    if 'default_stale_timeout_seconds = int(' in text and 'using default %d' in text:
        return False
    old = '''        # Read stale_timeout_seconds — 0 disables stale detection.
        raw_stale = kanban_cfg.get("dispatch_stale_timeout_seconds", 0)
        try:
            stale_timeout_seconds = int(raw_stale or 0)
        except (TypeError, ValueError):
            logger.warning(
                "kanban dispatcher: invalid kanban.dispatch_stale_timeout_seconds=%r; "
                "disabling stale detection",
                raw_stale,
            )
            stale_timeout_seconds = 0
'''
    new = '''        # Read stale_timeout_seconds — 0 explicitly disables stale detection.
        default_stale_timeout_seconds = int(
            _kb.DEFAULT_CONFIG.get("kanban", {}).get("dispatch_stale_timeout_seconds", 14400)
            if hasattr(_kb, "DEFAULT_CONFIG") else 14400
        )
        raw_stale = kanban_cfg.get("dispatch_stale_timeout_seconds", default_stale_timeout_seconds)
        try:
            stale_timeout_seconds = int(raw_stale if raw_stale is not None else default_stale_timeout_seconds)
        except (TypeError, ValueError):
            logger.warning(
                "kanban dispatcher: invalid kanban.dispatch_stale_timeout_seconds=%r; "
                "using default %d",
                raw_stale,
                default_stale_timeout_seconds,
            )
            stale_timeout_seconds = default_stale_timeout_seconds
        if stale_timeout_seconds < 0:
            logger.warning(
                "kanban dispatcher: kanban.dispatch_stale_timeout_seconds=%r is below 0; using default %d",
                raw_stale,
                default_stale_timeout_seconds,
            )
            stale_timeout_seconds = default_stale_timeout_seconds
'''
    if old not in text:
        raise RuntimeError(f'gateway stale timeout block not found: {path}')
    path.write_text(text.replace(old, new, 1))
    return True


def main() -> int:
    changed = []
    if patch_kanban(KANBAN):
        changed.append(str(KANBAN))
    if patch_gateway(GATEWAY):
        changed.append(str(GATEWAY))
    if changed:
        print('kanban stale-timeout policy repaired')
        for item in changed:
            print(f'restored: {item}')
    else:
        print('kanban stale-timeout policy ok')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
