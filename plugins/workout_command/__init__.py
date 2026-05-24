from __future__ import annotations

import dataclasses
import asyncio
import datetime as dt
import importlib.util
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

logger = logging.getLogger(__name__)

DEFAULT_WORKOUT_RANGE = "운동기록!A:H"
DEFAULT_INBODY_RANGE = "인바디!A:U"
DEFAULT_TIMEZONE = "Asia/Seoul"
STATE_DIR = Path.home() / ".hermes" / "workout_command"
UNDO_FILE = STATE_DIR / "undo.json"
ROUTINE_REQUESTS_FILE = STATE_DIR / "routine_requests.jsonl"
GOOGLE_API = (
    Path.home()
    / ".hermes"
    / "hermes-agent"
    / "skills"
    / "productivity"
    / "google-workspace"
    / "scripts"
    / "google_api.py"
)
WEEKDAY_MAP = {
    "월요일": 0,
    "화요일": 1,
    "수요일": 2,
    "목요일": 3,
    "금요일": 4,
    "토요일": 5,
    "일요일": 6,
}


HELP_TEXT = """\
운동 기록 관련 Discord 명령어는 `/workout` 입니다.

`/workout`
`/workout help`
도움말 표시.

`/workout log`
날짜: 2026-05-19
등
바벨로우 30kg 8회 4세트
렛풀다운 31.8kg 10회 6세트

한 줄 입력:
`/workout log 날짜: 2026-05-19; 등; 바벨로우 30kg 8회 4세트; 렛풀다운 31.8kg 10회 6세트`

`/workout inbody`
검사일시: 2026-05-19 20:10
체중: 78.1kg
골격근량: 30.5kg
체지방률: 30.7%
메모: 인바디 사진 입력

`/workout today`
오늘 운동기록 조회.

`/workout recent`
최근 운동기록 조회.

`/workout undo`
직전에 추가한 운동기록 또는 인바디 범위를 비웁니다.

주간 루틴 초안:
`/workout confirm <token>`
`/workout deny <token>`
"""


@dataclasses.dataclass
class WorkoutConfig:
    spreadsheet_id: str = ""
    workout_range: str = DEFAULT_WORKOUT_RANGE
    inbody_range: str = DEFAULT_INBODY_RANGE
    channel_allowlist: tuple[str, ...] = ()
    timezone: str = DEFAULT_TIMEZONE


class WorkoutError(RuntimeError):
    pass


def register(ctx) -> None:
    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)
    if _register_native_slash_enabled():
        ctx.register_command(
            "workout",
            handler=lambda raw: handle_workout(raw, context={}),
            description="운동기록과 인바디 기록을 Google Sheets에 저장합니다.",
            args_hint="help | log ... | inbody ... | today | recent | undo | confirm <token> | deny <token>",
        )


def _register_native_slash_enabled() -> bool:
    raw = os.environ.get("WORKOUT_REGISTER_NATIVE_SLASH")
    if raw is not None:
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    data = _load_yaml_config()
    section = data.get("workout", {}) if isinstance(data.get("workout"), dict) else {}
    discord = section.get("discord", {}) if isinstance(section.get("discord", {}), dict) else {}
    return bool(discord.get("register_native_slash", False))


def _platform_name(source) -> str:
    platform = getattr(source, "platform", "")
    return str(getattr(platform, "value", platform) or "").lower()


def _load_yaml_config() -> dict[str, Any]:
    path = Path.home() / ".hermes" / "config.yaml"
    if not path.exists():
        return {}
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _csv(value: str) -> tuple[str, ...]:
    return tuple(x.strip() for x in str(value or "").split(",") if x.strip())


def _spreadsheet_id_from_url(value: str) -> str:
    value = (value or "").strip()
    match = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]+)", value)
    return match.group(1) if match else value


def load_config() -> WorkoutConfig:
    data = _load_yaml_config()
    section = data.get("workout", {}) if isinstance(data.get("workout"), dict) else {}
    google = section.get("google", {}) if isinstance(section.get("google"), dict) else {}
    discord = section.get("discord", {}) if isinstance(section.get("discord"), dict) else {}
    env_spreadsheet = os.environ.get("WORKOUT_SPREADSHEET_ID") or os.environ.get("WORKOUT_SPREADSHEET_URL", "")
    cfg_spreadsheet = (
        google.get("spreadsheet_id")
        or google.get("spreadsheet_url")
        or ""
    )
    channel_env = os.environ.get("WORKOUT_DISCORD_CHANNEL_ID", "")
    channels = (
        _csv(channel_env)
        or tuple(str(x) for x in discord.get("channel_allowlist", []) if str(x).strip())
    )
    return WorkoutConfig(
        spreadsheet_id=_spreadsheet_id_from_url(str(env_spreadsheet or cfg_spreadsheet)),
        workout_range=str(os.environ.get("WORKOUT_SHEET_RANGE") or google.get("workout_range") or DEFAULT_WORKOUT_RANGE),
        inbody_range=str(os.environ.get("WORKOUT_INBODY_RANGE") or google.get("inbody_range") or DEFAULT_INBODY_RANGE),
        channel_allowlist=channels,
        timezone=str(os.environ.get("WORKOUT_TIMEZONE") or section.get("timezone") or DEFAULT_TIMEZONE),
    )


def _tz(name: str):
    if ZoneInfo is None:
        return dt.timezone.utc
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo(DEFAULT_TIMEZONE)


def _now(cfg: WorkoutConfig) -> dt.datetime:
    return dt.datetime.now(_tz(cfg.timezone))


def _is_workout_text(text: str) -> bool:
    stripped = (text or "").strip()
    if stripped.startswith("/"):
        return bool(re.match(r"^/workout(?:\s|$)", stripped, re.I))
    if re.match(r"^workout(?:\s|$)", stripped, re.I):
        return True
    return stripped in {"이대로 확정", "취소"} or any(word in stripped for word in ("변경", "운동 제외"))


def _is_allowed_channel(event, cfg: WorkoutConfig) -> bool:
    if not cfg.channel_allowlist:
        return False
    source = getattr(event, "source", None)
    ids = {
        str(getattr(source, "chat_id", "") or ""),
        str(getattr(source, "parent_chat_id", "") or ""),
    }
    return bool(ids & set(cfg.channel_allowlist))


def pre_gateway_dispatch(event, gateway, session_store=None):
    source = getattr(event, "source", None)
    if source is None or _platform_name(source) != "discord":
        return None
    if getattr(source, "is_bot", False):
        return None
    text = getattr(event, "text", "") or ""
    if not _is_workout_text(text):
        return None

    cfg = load_config()
    if not _is_allowed_channel(event, cfg):
        _schedule_event_response(event, gateway, "이 `/workout` 명령은 지정된 운동기록 채널에서만 사용할 수 있습니다.")
        return {"action": "skip", "reason": "workout_wrong_channel"}

    try:
        asyncio.get_running_loop().create_task(_handle_gateway_event(event, gateway, cfg))
    except RuntimeError:
        logger.warning("workout_command: no running event loop for gateway event")
    return {"action": "skip", "reason": "workout_command"}


async def _handle_gateway_event(event, gateway, cfg: WorkoutConfig) -> None:
    source = event.source
    reply_to = str(getattr(event, "message_id", "") or getattr(source, "message_id", "") or "") or None
    context = {
        "platform": _platform_name(source),
        "channel_id": str(getattr(source, "chat_id", "") or ""),
        "user_id": str(getattr(source, "user_id", "") or ""),
        "reply_to": reply_to,
    }
    text = getattr(event, "text", "") or ""
    if text.strip().startswith("/"):
        raw = re.sub(r"^/workout(?:\s+)?", "", text.strip(), flags=re.I)
        response = await asyncio.to_thread(handle_workout, raw, context=context, cfg=cfg)
    elif re.match(r"^workout(?:\s|$)", text.strip(), re.I):
        raw = re.sub(r"^workout(?:\s+)?", "", text.strip(), flags=re.I)
        response = await asyncio.to_thread(handle_workout, raw, context=context, cfg=cfg)
    else:
        response = await asyncio.to_thread(handle_routine_text, text, context=context, cfg=cfg)
    await _send(gateway, source, response, reply_to=reply_to)


def _schedule_event_response(event, gateway, text: str) -> None:
    source = event.source
    reply_to = str(getattr(event, "message_id", "") or getattr(source, "message_id", "") or "") or None
    try:
        asyncio.get_running_loop().create_task(_send(gateway, source, text, reply_to=reply_to))
    except RuntimeError:
        logger.warning("workout_command: no running event loop for response")


async def _send(gateway, source, text: str, reply_to: str | None = None) -> None:
    adapter = getattr(gateway, "adapters", {}).get(getattr(source, "platform", None))
    if adapter is None:
        logger.warning("workout_command: no adapter for %s", getattr(source, "platform", None))
        return
    await adapter.send(str(source.chat_id), text, reply_to=reply_to)


def _google_module():
    if not GOOGLE_API.exists():
        raise WorkoutError("Google Workspace helper를 찾을 수 없습니다.")
    spec = importlib.util.spec_from_file_location("hermes_google_api", GOOGLE_API)
    if spec is None or spec.loader is None:
        raise WorkoutError("Google Workspace helper를 불러올 수 없습니다.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _sheets_service():
    try:
        return _google_module().build_service("sheets", "v4")
    except SystemExit as exc:
        raise WorkoutError("Google Workspace 인증이 필요합니다.") from exc
    except Exception as exc:
        raise WorkoutError(f"Google Sheets 연결 실패: {exc}") from exc


def _require_spreadsheet(cfg: WorkoutConfig) -> str:
    if not cfg.spreadsheet_id:
        raise WorkoutError("WORKOUT_SPREADSHEET_ID 또는 workout.google.spreadsheet_id 설정이 필요합니다.")
    return cfg.spreadsheet_id


def _sheet_title(sheet_range: str) -> str:
    title = str(sheet_range or "").split("!", 1)[0].strip()
    if title.startswith("'") and title.endswith("'"):
        title = title[1:-1].replace("''", "'")
    return title


def ensure_sheet_exists(service, spreadsheet_id: str, sheet_range: str) -> None:
    title = _sheet_title(sheet_range)
    if not title:
        return
    meta = service.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields="sheets(properties(title))",
    ).execute()
    titles = {
        str(sheet.get("properties", {}).get("title", ""))
        for sheet in meta.get("sheets", [])
    }
    if title in titles:
        return
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": [{"addSheet": {"properties": {"title": title}}}]},
    ).execute()


def append_rows(cfg: WorkoutConfig, sheet_range: str, rows: list[list[Any]]) -> str:
    spreadsheet_id = _require_spreadsheet(cfg)
    service = _sheets_service()
    ensure_sheet_exists(service, spreadsheet_id, sheet_range)
    result = service.spreadsheets().values().append(
        spreadsheetId=spreadsheet_id,
        range=sheet_range,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": rows},
    ).execute()
    return str(result.get("updates", {}).get("updatedRange", ""))


def get_rows(cfg: WorkoutConfig, sheet_range: str) -> list[list[Any]]:
    spreadsheet_id = _require_spreadsheet(cfg)
    service = _sheets_service()
    ensure_sheet_exists(service, spreadsheet_id, sheet_range)
    result = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=sheet_range,
    ).execute()
    return result.get("values", [])


def clear_range(cfg: WorkoutConfig, sheet_range: str) -> None:
    spreadsheet_id = _require_spreadsheet(cfg)
    service = _sheets_service()
    service.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range=sheet_range,
        body={},
    ).execute()


def _undo_key(context: dict[str, str]) -> str:
    return "|".join(
        [
            context.get("platform", "cli"),
            context.get("channel_id", ""),
            context.get("user_id", ""),
        ]
    )


def _read_undo() -> dict[str, Any]:
    try:
        return json.loads(UNDO_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_undo(data: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = UNDO_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(UNDO_FILE)


def _save_undo(context: dict[str, str], cfg: WorkoutConfig, range_name: str, kind: str) -> None:
    if not range_name:
        return
    data = _read_undo()
    data[_undo_key(context)] = {
        "spreadsheet_id": cfg.spreadsheet_id,
        "range": range_name,
        "kind": kind,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    _write_undo(data)


def _consume_undo(context: dict[str, str]) -> dict[str, Any] | None:
    data = _read_undo()
    key = _undo_key(context)
    item = data.pop(key, None)
    _write_undo(data)
    return item if isinstance(item, dict) else None


def _range_start_row(range_name: str) -> int | None:
    match = re.search(r"![A-Z]+(\d+)", range_name or "", re.I)
    if not match:
        match = re.search(r"^[A-Z]+(\d+)", range_name or "", re.I)
    return int(match.group(1)) if match else None


def _split_subcommand(raw_args: str) -> tuple[str, str]:
    text = (raw_args or "").strip()
    if not text:
        return "help", ""
    first, _, rest = text.partition(" ")
    action = re.match(r"^action\s*[:=]\s*(log|inbody|today|recent|undo|help)$", first, re.I)
    if action:
        return action.group(1).lower(), rest.strip()
    return first.lower(), rest.strip()


def _normalize_body(body: str) -> list[str]:
    text = body.replace("\r\n", "\n").replace("\r", "\n")
    parts: list[str] = []
    for chunk in text.split("\n"):
        parts.extend(chunk.split(";"))
    return [x.strip() for x in parts if x.strip()]


def _kv_value(line: str, *names: str) -> str | None:
    for name in names:
        match = re.match(rf"^{re.escape(name)}\s*[:：]\s*(.+)$", line.strip(), re.I)
        if match:
            return match.group(1).strip()
    return None


def _num(text: str) -> str:
    match = re.search(r"-?\d+(?:\.\d+)?", text or "")
    return match.group(0) if match else ""


def _date_from_text(text: str, cfg: WorkoutConfig) -> str:
    now = _now(cfg)
    match = re.search(r"(20\d{2})[-./년 ]\s*(\d{1,2})[-./월 ]\s*(\d{1,2})", text or "")
    if match:
        return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
    base = now.date()
    if "그제" in text:
        return (base - dt.timedelta(days=2)).isoformat()
    if "어제" in text:
        return (base - dt.timedelta(days=1)).isoformat()
    for name, target in WEEKDAY_MAP.items():
        if name in text:
            delta = (base.weekday() - target) % 7
            return (base - dt.timedelta(days=delta)).isoformat()
    return base.isoformat()


def _time_range(text: str) -> str:
    match = re.search(r"(\d{1,2})(?::(\d{2}))?\s*(?:-|~|부터)\s*(\d{1,2})(?::(\d{2}))?\s*시?", text or "")
    if not match:
        return ""
    start = f"{int(match.group(1)):02d}:{int(match.group(2) or 0):02d}"
    end = f"{int(match.group(3)):02d}:{int(match.group(4) or 0):02d}"
    return f"{start}-{end}"


def _clean_activity(text: str) -> str:
    cleaned = re.sub(r"(오늘|어제|그제|월요일|화요일|수요일|목요일|금요일|토요일|일요일)", "", text or "")
    cleaned = re.sub(r"(20\d{2})[-./년 ]\s*(\d{1,2})[-./월 ]\s*(\d{1,2})", "", cleaned)
    cleaned = re.sub(r"\d{1,2}(?::\d{2})?\s*(?:-|~|부터)\s*\d{1,2}(?::\d{2})?\s*시?", "", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip(" -~")


def _infer_part(part: str, text: str) -> str:
    if part:
        return part
    if re.search(r"유산소|러닝|걷|산책|스텝밀|에어소프트|게임", text or ""):
        return "유산소"
    return ""


def parse_workout_log(body: str, cfg: WorkoutConfig) -> list[list[Any]]:
    lines = _normalize_body(body)
    date = _date_from_text(body, cfg)
    part = ""
    exercises: list[str] = []
    for line in lines:
        value = _kv_value(line, "날짜", "date")
        if value:
            date = _date_from_text(value, cfg)
            continue
        if not part and ":" not in line and not re.search(r"\d+\s*kg|\d+\s*회|\d+\s*세트", line):
            part = line
            continue
        exercises.append(line)
    if not exercises:
        if part:
            exercises.append(part)
            part = ""
        else:
            raise WorkoutError("운동 항목을 찾지 못했습니다.")
    rows = []
    for exercise in exercises:
        match = re.match(
            r"(?P<name>.+?)\s+(?P<weight>\d+(?:\.\d+)?)\s*kg\s+(?P<reps>\d+(?:\.\d+)?)\s*(?P<unit>회|개)\s+(?P<sets>\d+)\s*세트",
            exercise,
            re.I,
        )
        if match:
            rows.append([
                date,
                "",
                _infer_part(part, exercise),
                match.group("name").strip(),
                f"{match.group('weight')}kg",
                f"{match.group('reps')}{match.group('unit')}",
                match.group("sets"),
                "",
            ])
        else:
            cleaned = _clean_activity(exercise) or exercise
            rows.append([date, "", _infer_part(part, cleaned), cleaned, "", _time_range(exercise), "", ""])
    return rows


def parse_inbody(body: str, cfg: WorkoutConfig) -> list[list[Any]]:
    values: dict[str, str] = {}
    for line in _normalize_body(body):
        for key, aliases in {
            "checked_at": ("검사일시", "검사일", "date"),
            "condition": ("측정조건", "condition"),
            "height": ("신장", "height"),
            "age": ("나이", "age"),
            "gender": ("성별", "gender"),
            "weight": ("체중", "weight"),
            "muscle": ("골격근량", "skeletal muscle"),
            "fat": ("체지방률", "body fat"),
            "fat_mass": ("체지방량",),
            "bmi": ("BMI",),
            "bmr": ("기초대사량",),
            "score": ("인바디점수",),
            "abdominal_fat": ("복부지방률",),
            "visceral_fat": ("내장지방레벨",),
            "lean_mass": ("제지방량",),
            "recommended_calorie": ("권장섭취열량",),
            "target_weight": ("적정체중",),
            "weight_control": ("체중조절",),
            "fat_control": ("지방조절",),
            "muscle_control": ("근육조절",),
            "memo": ("메모", "memo"),
        }.items():
            found = _kv_value(line, *aliases)
            if found is not None:
                values[key] = found
    if not values.get("checked_at"):
        values["checked_at"] = _now(cfg).isoformat(timespec="minutes")
    return [[
        values.get("checked_at", ""),
        values.get("condition", ""),
        _num(values.get("height", "")),
        _num(values.get("age", "")),
        values.get("gender", ""),
        _num(values.get("weight", "")),
        _num(values.get("muscle", "")),
        _num(values.get("fat", "")),
        _num(values.get("fat_mass", "")),
        _num(values.get("bmi", "")),
        _num(values.get("bmr", "")),
        _num(values.get("score", "")),
        _num(values.get("abdominal_fat", "")),
        _num(values.get("visceral_fat", "")),
        _num(values.get("lean_mass", "")),
        _num(values.get("recommended_calorie", "")),
        _num(values.get("target_weight", "")),
        _num(values.get("weight_control", "")),
        _num(values.get("fat_control", "")),
        _num(values.get("muscle_control", "")),
        values.get("memo", ""),
    ]]


def _format_workout_row(row: list[Any]) -> str:
    values = [str(x) for x in row]
    if len(values) >= 8:
        date, _, part, name, weight, reps, sets = values[:7]
        detail = name
        if weight:
            detail += f" {weight}"
        if reps:
            detail += f" {reps}"
        if sets:
            detail += f" {sets}세트"
        return f"- {date} {part} {detail}".strip()
    return "- " + " | ".join(values)


def _handle_log(body: str, cfg: WorkoutConfig, context: dict[str, str]) -> str:
    rows = parse_workout_log(body, cfg)
    updated_range = append_rows(cfg, cfg.workout_range, rows)
    _save_undo(context, cfg, updated_range, "log")
    return f"운동기록 {len(rows)}건을 시트에 추가했습니다."


def _handle_inbody(body: str, cfg: WorkoutConfig, context: dict[str, str]) -> str:
    rows = parse_inbody(body, cfg)
    updated_range = append_rows(cfg, cfg.inbody_range, rows)
    _save_undo(context, cfg, updated_range, "inbody")
    return "인바디 기록 1건을 시트에 추가했습니다."


def _handle_today(cfg: WorkoutConfig) -> str:
    today = _now(cfg).date().isoformat()
    rows = [row for row in get_rows(cfg, cfg.workout_range) if row and str(row[0]) == today]
    if not rows:
        return "오늘 운동기록이 없습니다."
    return "오늘 운동기록:\n" + "\n".join(_format_workout_row(row) for row in rows[-20:])


def _handle_recent(cfg: WorkoutConfig) -> str:
    rows = [row for row in get_rows(cfg, cfg.workout_range) if row]
    if not rows:
        return "최근 운동기록이 없습니다."
    return "최근 운동기록:\n" + "\n".join(_format_workout_row(row) for row in rows[-10:])


def _handle_undo(cfg: WorkoutConfig, context: dict[str, str]) -> str:
    item = _consume_undo(context)
    if not item or not item.get("range"):
        return "되돌릴 직전 `/workout log` 또는 `/workout inbody` 기록이 없습니다."
    if item.get("spreadsheet_id") != cfg.spreadsheet_id:
        return "되돌릴 기록의 시트가 현재 설정과 달라 실행하지 않았습니다."
    if (_range_start_row(str(item["range"])) or 0) <= 1:
        return "헤더 행 보호를 위해 undo를 실행하지 않았습니다."
    clear_range(cfg, str(item["range"]))
    return f"직전 {item.get('kind', 'workout')} 입력 범위를 비웠습니다."


def _pending_plan_path() -> Path:
    return STATE_DIR / "pending_routine.json"


def _handle_confirm(token: str, approve: bool) -> str:
    token = token.strip()
    if not token:
        return "사용법: `/workout confirm <token>` 또는 `/workout deny <token>`"
    path = _pending_plan_path()
    if not path.exists():
        return "확정 대기 중인 주간 루틴 초안이 없습니다."
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return "주간 루틴 초안 상태 파일을 읽을 수 없습니다."
    if token != str(data.get("token", "")):
        return "토큰이 일치하지 않습니다. Calendar write는 실행하지 않았습니다."
    data["status"] = "confirmed" if approve else "denied"
    data["decided_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return "주간 루틴 초안을 확정했습니다." if approve else "주간 루틴 초안을 취소했습니다."


def handle_routine_text(text: str, context: dict[str, str], cfg: WorkoutConfig | None = None) -> str:
    cfg = cfg or load_config()
    stripped = text.strip()
    if stripped == "이대로 확정":
        return "보안을 위해 루틴 확정은 `/workout confirm <token>`으로만 처리합니다."
    if stripped == "취소":
        return "보안을 위해 루틴 취소는 `/workout deny <token>`으로만 처리합니다."
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with ROUTINE_REQUESTS_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "created_at": _now(cfg).isoformat(timespec="seconds"),
            "channel_id": context.get("channel_id", ""),
            "user_id": context.get("user_id", ""),
            "text": stripped,
        }, ensure_ascii=False) + "\n")
    return "루틴 초안 수정 요청을 기록했습니다. 다음 초안 생성/검토 때 반영합니다."


def handle_workout(raw_args: str, context: dict[str, str] | None = None, cfg: WorkoutConfig | None = None) -> str:
    context = context or {}
    cfg = cfg or load_config()
    subcommand, body = _split_subcommand(raw_args)
    try:
        if subcommand in {"help", "-h", "--help"}:
            return HELP_TEXT
        if subcommand == "log":
            return _handle_log(body, cfg, context)
        if subcommand == "inbody":
            return _handle_inbody(body, cfg, context)
        if subcommand == "today":
            return _handle_today(cfg)
        if subcommand == "recent":
            return _handle_recent(cfg)
        if subcommand == "undo":
            return _handle_undo(cfg, context)
        if subcommand == "confirm":
            return _handle_confirm(body, approve=True)
        if subcommand == "deny":
            return _handle_confirm(body, approve=False)
        return f"알 수 없는 `/workout` 하위 명령입니다: {subcommand}\n\n{HELP_TEXT}"
    except WorkoutError as exc:
        return f"운동기록 처리 실패: {exc}"
