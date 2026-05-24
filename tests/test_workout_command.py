from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace


PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "workout_command" / "__init__.py"
SPEC = importlib.util.spec_from_file_location("workout_command", PLUGIN)
workout = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = workout
SPEC.loader.exec_module(workout)


def cfg() -> workout.WorkoutConfig:
    return workout.WorkoutConfig(
        spreadsheet_id="sheet-id",
        channel_allowlist=("123456789012345678",),
        timezone="Asia/Seoul",
    )


def test_parse_workout_log_multiline():
    rows = workout.parse_workout_log(
        "날짜: 2026-05-19\n등\n바벨로우 30kg 8회 4세트\n렛풀다운 31.8kg 10회 6세트",
        cfg(),
    )

    assert len(rows) == 2
    assert rows[0][1:] == ["2026-05-19", "등", "바벨로우", "30", "8", "4", "바벨로우 30kg 8회 4세트"]
    assert rows[1][3:7] == ["렛풀다운", "31.8", "10", "6"]


def test_parse_workout_log_single_line():
    rows = workout.parse_workout_log(
        "날짜: 2026-05-19; 등; 바벨로우 30kg 8회 4세트; 렛풀다운 31.8kg 10회 6세트",
        cfg(),
    )

    assert [row[3] for row in rows] == ["바벨로우", "렛풀다운"]


def test_parse_inbody():
    rows = workout.parse_inbody(
        "검사일시: 2026-05-19 20:10\n체중: 78.1kg\n골격근량: 30.5kg\n체지방률: 30.7%\n메모: 인바디 사진 입력",
        cfg(),
    )

    assert rows[0][1:] == ["2026-05-19 20:10", "78.1", "30.5", "30.7", "인바디 사진 입력", rows[0][-1]]


def test_channel_allowlist_only_target_channel():
    source = SimpleNamespace(
        platform="discord",
        chat_id="123456789012345678",
        parent_chat_id="",
        is_bot=False,
    )
    event = SimpleNamespace(source=source)

    assert workout._is_allowed_channel(event, cfg()) is True
    source.chat_id = "other"
    assert workout._is_allowed_channel(event, cfg()) is False


def test_help_and_unknown_command_do_not_need_sheets():
    assert "운동 기록 관련 Discord 명령어" in workout.handle_workout("help", cfg=cfg())
    assert "알 수 없는" in workout.handle_workout("bad", cfg=cfg())


def test_plain_workout_prefix_is_supported():
    assert workout._is_workout_text("workout help") is True
    assert workout._is_workout_text("WORKOUT today") is True
    assert workout._is_workout_text("workoutlog") is False


def test_sheet_title_extracts_quoted_title():
    assert workout._sheet_title("운동기록!A:H") == "운동기록"
    assert workout._sheet_title("'인바디'!A:G") == "인바디"


def test_register_does_not_add_native_slash_by_default(monkeypatch):
    monkeypatch.delenv("WORKOUT_REGISTER_NATIVE_SLASH", raising=False)

    calls = []
    ctx = SimpleNamespace(
        register_hook=lambda *args: calls.append(("hook", args)),
        register_command=lambda *args, **kwargs: calls.append(("command", args, kwargs)),
    )

    workout.register(ctx)

    assert any(kind == "hook" for kind, *_ in calls)
    assert not any(kind == "command" for kind, *_ in calls)


def test_register_can_enable_native_slash_explicitly(monkeypatch):
    monkeypatch.setenv("WORKOUT_REGISTER_NATIVE_SLASH", "1")

    calls = []
    ctx = SimpleNamespace(
        register_hook=lambda *args: calls.append(("hook", args)),
        register_command=lambda *args, **kwargs: calls.append(("command", args, kwargs)),
    )

    workout.register(ctx)

    assert any(kind == "command" for kind, *_ in calls)
