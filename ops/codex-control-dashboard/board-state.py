import json
import os
import re
import sqlite3
import sys
from pathlib import Path


def main():
    board = sys.argv[1] if len(sys.argv) > 1 else "codex-control"
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", board):
        raise SystemExit("invalid board slug")

    db_path = Path(os.environ.get("HERMES_KANBAN_ROOT", "/home/ubuntu/.hermes/kanban")) / "boards" / board / "kanban.db"
    include_archived = os.environ.get("DASHBOARD_INCLUDE_ARCHIVED", "0").lower() in {"1", "true", "yes", "on"}
    if not db_path.exists():
        print("[]")
        return

    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=2)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=2000")

    where = "" if include_archived else "where status != 'archived'"
    rows = con.execute(
        f"""
        select id, title, substr(coalesce(body, ''), 1, 4000) as body, assignee, status, priority, tenant,
               workspace_kind, workspace_path, created_by, created_at,
               started_at, completed_at, substr(coalesce(result, ''), 1, 2000) as result, skills, max_retries
        from tasks
        {where}
        order by priority desc, created_at asc
        """
    ).fetchall()

    tasks = []
    for row in rows:
        item = dict(row)
        skills = item.get("skills")
        if not skills:
            item["skills"] = []
        else:
            try:
                item["skills"] = json.loads(skills)
            except Exception:
                item["skills"] = [part.strip() for part in str(skills).split(",") if part.strip()]
        tasks.append(item)

    print(json.dumps(tasks, ensure_ascii=False))


if __name__ == "__main__":
    main()
