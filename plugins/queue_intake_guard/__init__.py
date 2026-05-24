from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_BOARD = "codex-control"
DEFAULT_ASSIGNEE = "planner"
DEFAULT_PRIORITY = 70


@dataclass
class QueueConfig:
    enabled: bool = True
    channel_ids: tuple[str, ...] = ()
    board: str = DEFAULT_BOARD
    assignee: str = DEFAULT_ASSIGNEE
    priority: int = DEFAULT_PRIORITY
    ack: bool = True


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)


def _platform_name(source) -> str:
    platform = getattr(source, "platform", "")
    return str(getattr(platform, "value", platform) or "").lower()


def _csv_env(name: str) -> tuple[str, ...] | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    return tuple(x.strip() for x in raw.split(",") if x.strip())


def _load_config() -> QueueConfig:
    try:
        from hermes_cli.config import load_config

        data = load_config()
    except Exception:
        data = {}
    section = data.get("queue_intake", {}) if isinstance(data, dict) else {}
    discord = section.get("discord", {}) if isinstance(section.get("discord", {}), dict) else {}

    channels = (
        _csv_env("QUEUE_INTAKE_CHANNEL_IDS")
        or tuple(str(x) for x in discord.get("channel_ids", []) if str(x).strip())
        or ()
    )
    return QueueConfig(
        enabled=bool(section.get("enabled", True)),
        channel_ids=channels,
        board=str(section.get("board", os.environ.get("QUEUE_INTAKE_BOARD", DEFAULT_BOARD))),
        assignee=str(section.get("assignee", os.environ.get("QUEUE_INTAKE_ASSIGNEE", DEFAULT_ASSIGNEE))),
        priority=int(section.get("priority", os.environ.get("QUEUE_INTAKE_PRIORITY", DEFAULT_PRIORITY))),
        ack=bool(discord.get("ack", True)),
    )


def _event_channel_ids(event) -> set[str]:
    source = getattr(event, "source", None)
    ids = {
        str(getattr(source, "chat_id", "") or ""),
        str(getattr(source, "parent_chat_id", "") or ""),
        str(getattr(source, "thread_id", "") or ""),
        str(getattr(source, "chat_id_alt", "") or ""),
    }
    raw = getattr(event, "raw_message", None)
    channel = getattr(raw, "channel", None)
    ids.add(str(getattr(channel, "id", "") or ""))
    ids.add(str(getattr(channel, "parent_id", "") or ""))
    return {x for x in ids if x}


def _is_target(event, cfg: QueueConfig) -> bool:
    source = getattr(event, "source", None)
    if source is None or _platform_name(source) != "discord":
        return False
    if getattr(source, "is_bot", False):
        return False
    if not cfg.channel_ids:
        return False
    return bool(_event_channel_ids(event) & set(cfg.channel_ids))


def pre_gateway_dispatch(event, gateway, session_store=None):
    cfg = _load_config()
    if not cfg.enabled or not _is_target(event, cfg):
        return None

    text = getattr(event, "text", "") or ""
    source = getattr(event, "source", None)
    message_id = _message_id(event)

    if _is_trivial_ack(text):
        if cfg.ack:
            _schedule_send(
                gateway,
                source,
                "[대기열 미등록]\n확인 응답만 있는 메시지는 작업 큐에 등록하지 않았습니다. 작업 요청은 구체적인 제목/내용으로 다시 보내주세요.",
                reply_to=message_id,
            )
        return {"action": "skip", "reason": "queue_intake_guard_trivial_ack"}

    try:
        asyncio.get_running_loop().create_task(_handle(event, gateway, cfg))
    except RuntimeError:
        logger.warning("queue_intake_guard: no running event loop for gateway event")
    return {"action": "skip", "reason": "queue_intake_guard"}


def _message_id(event) -> str:
    source = getattr(event, "source", None)
    return str(
        getattr(event, "message_id", None)
        or getattr(source, "message_id", "")
        or _stable_fallback_id(event)
    )


def _stable_fallback_id(event) -> str:
    source = getattr(event, "source", None)
    raw = "|".join(
        [
            str(getattr(source, "chat_id", "") or ""),
            str(getattr(source, "user_id", "") or ""),
            str(getattr(event, "timestamp", "") or ""),
            str(getattr(event, "text", "") or ""),
        ]
    )
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()


def _clean_line(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip()).strip()


def _is_trivial_ack(text: str) -> bool:
    normalized = _clean_line(text).strip(".!?。！？")
    return normalized.casefold() in {"yes", "y", "yeah", "yep", "ok", "okay", "ㅇ", "ㅇㅇ", "어", "응", "네", "예", "넵", "확인"}


def _strip_intake_markers(text: str) -> str:
    lines = []
    for line in (text or "").splitlines():
        cleaned = re.sub(r"<@[!&]?\d+>", "", line).strip()
        if not cleaned:
            lines.append("")
            continue
        lowered = cleaned.casefold()
        if lowered in {"[queue]", "queue", "[codex]", "codex", "[task]", "task"}:
            continue
        cleaned = re.sub(r"^\s*(?:\[queue\]|\[codex\]|\[task\])\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"^\s*/(?:queue|task|codex-task)\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"^\s*@Agent-Hermes\b\s*", "", cleaned, flags=re.I)
        lines.append(cleaned)
    body = "\n".join(lines).strip()
    return body or (text or "").strip()


def _extract_field(text: str, names: tuple[str, ...]) -> str | None:
    for line in text.splitlines():
        raw = _clean_line(line)
        for name in names:
            pattern = rf"^{re.escape(name)}\s*[:：]?\s+(.+)$"
            match = re.match(pattern, raw, re.IGNORECASE)
            if match:
                value = match.group(1).strip()
                if value:
                    return value
    return None


def _parse_request(text: str, cfg: QueueConfig) -> tuple[str, str, str, int]:
    body = _strip_intake_markers(text)
    title = _extract_field(body, ("제목", "title"))
    assignee = _extract_field(body, ("담당", "assignee")) or cfg.assignee
    raw_priority = _extract_field(body, ("우선순위", "priority"))
    priority = cfg.priority
    if raw_priority:
        match = re.search(r"-?\d+", raw_priority)
        priority = int(match.group(0)) if match else cfg.priority

    if not title:
        for line in body.splitlines():
            candidate = _clean_line(line)
            if not candidate or candidate.startswith("[Content of "):
                continue
            title = candidate
            break
    title = (title or "Discord 작업 요청")[:120]
    return title, body or "(내용 없음)", assignee[:64], priority


def _create_task_sync(
    *,
    board: str,
    title: str,
    body: str,
    assignee: str,
    priority: int,
    source,
    message_id: str,
    notifier_profile: str | None,
) -> tuple[str, str]:
    from hermes_cli import kanban_db as kb

    platform = _platform_name(source) or "discord"
    chat_id = str(getattr(source, "chat_id", "") or "")
    thread_id = str(getattr(source, "thread_id", "") or "")
    user_id = str(getattr(source, "user_id", "") or "") or None
    channel_id = str(getattr(source, "parent_chat_id", None) or chat_id)
    user_name = str(getattr(source, "user_name", "") or user_id or "discord-user")
    idempotency_key = f"discord-queue:{channel_id}:{message_id}"
    annotated_body = (
        "[Discord Queue Intake]\n"
        f"channel_id: {channel_id}\n"
        f"message_id: {message_id}\n"
        f"author: {user_name}\n\n"
        f"{body}"
    )
    conn = kb.connect(board=board)
    try:
        task_id = kb.create_task(
            conn,
            title=title,
            body=annotated_body,
            assignee=assignee,
            created_by=f"discord:{user_name}",
            priority=priority,
            idempotency_key=idempotency_key,
        )
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform=platform,
            chat_id=chat_id,
            thread_id=thread_id or None,
            user_id=user_id,
            notifier_profile=notifier_profile,
        )
        task = kb.get_task(conn, task_id)
        return task_id, getattr(task, "status", "ready")
    finally:
        conn.close()


def _notifier_profile(gateway) -> str | None:
    profile = getattr(gateway, "_kanban_notifier_profile", None)
    if profile:
        return profile
    if hasattr(gateway, "_active_profile_name"):
        try:
            return gateway._active_profile_name()
        except Exception:
            return None
    return None


async def _handle(event, gateway, cfg: QueueConfig):
    source = event.source
    message_id = _message_id(event)
    title, body, assignee, priority = _parse_request(getattr(event, "text", "") or "", cfg)
    try:
        task_id, status = await asyncio.to_thread(
            _create_task_sync,
            board=cfg.board,
            title=title,
            body=body,
            assignee=assignee,
            priority=priority,
            source=source,
            message_id=message_id,
            notifier_profile=_notifier_profile(gateway),
        )
    except Exception as exc:
        logger.exception("queue_intake_guard: task create failed")
        await _send(
            gateway,
            source,
            "[대기열 등록 실패]\n"
            "작업 큐 생성 중 오류가 발생했습니다.\n"
            f"사유: {str(exc)[-300:]}\n"
            "Hermes 직접 실행은 차단했습니다.",
            reply_to=message_id,
        )
        return

    if cfg.ack:
        await _send(
            gateway,
            source,
            "[대기열 등록]\n"
            f"작업: {title}\n"
            f"작업 ID: {task_id}\n"
            f"보드: {cfg.board}\n"
            f"담당: {assignee}\n"
            f"상태: {status}\n"
            "이 채널의 사용자 메시지는 직접 실행하지 않고 작업 큐로만 등록합니다.",
            reply_to=message_id,
        )


def _schedule_send(gateway, source, text: str, *, reply_to: str | None = None) -> None:
    try:
        asyncio.get_running_loop().create_task(_send(gateway, source, text, reply_to=reply_to))
    except RuntimeError:
        logger.warning("queue_intake_guard: no running event loop for response")


async def _send(gateway, source, text: str, *, reply_to: str | None = None):
    adapter = getattr(gateway, "adapters", {}).get(getattr(source, "platform", None))
    if adapter is None:
        logger.warning("queue_intake_guard: no adapter for %s", getattr(source, "platform", None))
        return
    result = await adapter.send(str(source.chat_id), text, reply_to=reply_to)
    if getattr(result, "success", True) is False:
        logger.info("queue_intake_guard send failed: %s", getattr(result, "error", "unknown"))
