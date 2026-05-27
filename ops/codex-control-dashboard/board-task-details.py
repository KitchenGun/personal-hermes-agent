import json
import os
import re
import sqlite3
import sys
from pathlib import Path


def decode_json(value, fallback):
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def row_dict(row):
    return dict(row) if row is not None else None


def main():
    board = sys.argv[1] if len(sys.argv) > 1 else "codex-control"
    task_id = sys.argv[2] if len(sys.argv) > 2 else ""
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", board):
        raise SystemExit("invalid board slug")
    if not re.fullmatch(r"t_[A-Za-z0-9_-]+", task_id):
        raise SystemExit("invalid task id")

    db_path = Path(os.environ.get("HERMES_KANBAN_ROOT", "/home/ubuntu/.hermes/kanban")) / "boards" / board / "kanban.db"
    if not db_path.exists():
        raise SystemExit("kanban db not found")

    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=2)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=2000")

    task = row_dict(con.execute("select * from tasks where id = ?", (task_id,)).fetchone())
    if task is None:
        raise SystemExit("task not found")

    if task.get("skills"):
        task["skills"] = decode_json(task["skills"], [part.strip() for part in str(task["skills"]).split(",") if part.strip()])
    else:
        task["skills"] = []

    runs = []
    for row in con.execute("select * from task_runs where task_id = ? order by id", (task_id,)):
        item = dict(row)
        item["metadata"] = decode_json(item.get("metadata"), {})
        runs.append(item)

    comments = [dict(row) for row in con.execute(
        "select id, task_id, author, body, created_at from task_comments where task_id = ? order by id",
        (task_id,),
    )]

    events = []
    for row in con.execute(
        "select id, task_id, run_id, kind, payload, created_at from task_events where task_id = ? order by id",
        (task_id,),
    ):
        item = dict(row)
        item["payload"] = decode_json(item.get("payload"), {})
        events.append(item)

    latest_summary = task.get("result") or ""
    for run in reversed(runs):
        latest_summary = run.get("summary") or run.get("error") or latest_summary
        if latest_summary:
            break

    out = dict(task)
    out.update({
        "runs": runs,
        "comments": comments,
        "events": events,
        "latest_summary": latest_summary or "",
    })
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
