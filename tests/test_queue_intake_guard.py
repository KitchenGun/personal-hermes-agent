from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace


PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "queue_intake_guard" / "__init__.py"
SPEC = importlib.util.spec_from_file_location("queue_intake_guard", PLUGIN)
queue = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = queue
SPEC.loader.exec_module(queue)


def cfg() -> queue.QueueConfig:
    return queue.QueueConfig(channel_ids=("123456789012345678",), assignee="planner", priority=70)


def event(**source_kwargs):
    defaults = {
        "platform": "discord",
        "chat_id": "123456789012345678",
        "parent_chat_id": "",
        "thread_id": "",
        "is_bot": False,
    }
    defaults.update(source_kwargs)
    return SimpleNamespace(source=SimpleNamespace(**defaults), raw_message=None, text="제목 테스트")


def test_target_channel_matches_chat_or_parent():
    assert queue._is_target(event(), cfg()) is True
    assert queue._is_target(event(chat_id="thread", parent_chat_id="123456789012345678"), cfg()) is True
    assert queue._is_target(event(chat_id="other"), cfg()) is False


def test_target_channel_matches_raw_parent_for_slash_thread():
    raw = SimpleNamespace(channel=SimpleNamespace(id="thread", parent_id="123456789012345678"))
    ev = event(chat_id="thread")
    ev.raw_message = raw
    assert queue._is_target(ev, cfg()) is True


def test_strip_queue_markers_and_slash_queue():
    assert queue._strip_intake_markers("[queue]\n제목 테스트") == "제목 테스트"
    assert queue._strip_intake_markers("/queue AI 뉴스 보고서 한글화") == "AI 뉴스 보고서 한글화"
    assert queue._strip_intake_markers("<@123456> 제목 테스트") == "제목 테스트"


def test_parse_request_fields():
    title, body, assignee, priority = queue._parse_request(
        "[queue]\n제목: AI 뉴스 보고서 한글화\n담당: coder\n우선순위: 82\n세부내용: 본문",
        cfg(),
    )
    assert title == "AI 뉴스 보고서 한글화"
    assert "세부내용" in body
    assert assignee == "coder"
    assert priority == 82


def test_parse_slash_queue_uses_prompt_as_title():
    title, body, assignee, priority = queue._parse_request("/queue AI 뉴스 보고서 한글화", cfg())
    assert title == "AI 뉴스 보고서 한글화"
    assert body == "AI 뉴스 보고서 한글화"
    assert assignee == "planner"
    assert priority == 70


def test_trivial_ack_not_queued():
    assert queue._is_trivial_ack("확인") is True
    assert queue._is_trivial_ack("제목 확인") is False
