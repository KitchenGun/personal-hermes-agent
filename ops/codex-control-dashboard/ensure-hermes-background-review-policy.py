\
#!/usr/bin/env python3
"""Keep one-off personal schedule edits out of background skill creation."""

from __future__ import annotations

from pathlib import Path

TARGET = Path('/home/ubuntu/.hermes/hermes-agent/agent/background_review.py')
MARKER = 'Personal data/schedule edits in Discord, Calendar, or Sheets'
NEEDLE = '''"market' or 'analyze this PR' is not a class of work that warrants "\n    "a skill.\\n\\n"'''
REPLACEMENT = '''"market' or 'analyze this PR' is not a class of work that warrants "\n    "a skill.\\n"\n    "  • Personal data/schedule edits in Discord, Calendar, or Sheets "\n    "(for example workout routine changes) unless the user explicitly "\n    "asks to create or update a reusable skill/runbook.\\n\\n"'''


def main() -> int:
    text = TARGET.read_text()
    if MARKER in text:
        print('background review personal-task policy ok')
        return 0
    count = text.count(NEEDLE)
    if count < 2:
        raise RuntimeError(f'background review insertion marker not found twice; found {count}')
    TARGET.write_text(text.replace(NEEDLE, REPLACEMENT))
    print('background review personal-task policy repaired')
    print(f'restored: {TARGET}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
