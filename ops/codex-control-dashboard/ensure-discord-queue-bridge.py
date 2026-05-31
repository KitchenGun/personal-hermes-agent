#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

TARGET = Path('/home/ubuntu/.hermes/hermes-agent/plugins/platforms/discord/adapter.py')
START = '    # -- Codex Control queue bridge (VM local patch) ---------------------\n'
END = '    # -- End Codex Control queue bridge ---------------------------------\n'

HELPERS = r'''    # -- Codex Control queue bridge (VM local patch) ---------------------
    def _codex_control_queue_env(self) -> Dict[str, str]:
        env_path = os.getenv("CODEX_CONTROL_ENV_FILE", "").strip()
        if not env_path:
            hermes_home = os.getenv("HERMES_HOME", os.path.expanduser("~/.hermes"))
            env_path = os.path.join(hermes_home, "codex-control.env")
        values: Dict[str, str] = {}
        try:
            with open(env_path, "r", encoding="utf-8") as handle:
                for raw_line in handle:
                    line = raw_line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    values[key.strip()] = value.strip().strip('"').strip("'")
        except FileNotFoundError:
            return values
        except Exception as exc:
            logger.debug("Codex Control env read failed: %s", exc)
        return values

    def _codex_control_queue_value(self, env: Dict[str, str], key: str, default: str = "") -> str:
        return (os.getenv(key) or env.get(key) or default).strip()

    def _codex_control_queue_bool(self, value: str, default: bool) -> bool:
        if value == "":
            return default
        return value.lower() in {"1", "true", "yes", "on"}

    def _codex_control_queue_config(self) -> Dict[str, Any]:
        env = self._codex_control_queue_env()
        explicit_enabled = "DISCORD_QUEUE_TO_CODEX_CONTROL" in os.environ or "DISCORD_QUEUE_TO_CODEX_CONTROL" in env
        enabled = self._codex_control_queue_bool(
            self._codex_control_queue_value(env, "DISCORD_QUEUE_TO_CODEX_CONTROL", "1"),
            True,
        )
        channels_raw = self._codex_control_queue_value(env, "DISCORD_GATEWAY_QUEUE_CHANNEL_IDS")
        channel_ids = {item.strip() for item in channels_raw.split(",") if item.strip()}
        return {
            "enabled": enabled and (explicit_enabled or bool(channel_ids)),
            "endpoint": self._codex_control_queue_value(env, "DISCORD_RELAY_ENDPOINT", "http://127.0.0.1:17640/api/discord/task"),
            "secret": self._codex_control_queue_value(env, "DISCORD_SHARED_SECRET"),
            "board": self._codex_control_queue_value(env, "SUPERVISOR_BOARD", "codex-control"),
            "channel_ids": channel_ids,
        }

    def _codex_control_queue_channel_id(self, interaction: discord.Interaction) -> str:
        channel = getattr(interaction, "channel", None)
        return str(getattr(interaction, "channel_id", None) or getattr(channel, "id", "") or "")

    def _should_bridge_codex_control_queue(self, interaction: discord.Interaction, config: Dict[str, Any]) -> bool:
        if not config.get("enabled"):
            return False
        channel_ids = config.get("channel_ids") or set()
        if not channel_ids:
            return True
        return self._codex_control_queue_channel_id(interaction) in channel_ids

    def _post_codex_control_queue_task(
        self,
        interaction: discord.Interaction,
        prompt: str,
        config: Dict[str, Any],
    ) -> Dict[str, Any]:
        endpoint = str(config.get("endpoint") or "")
        secret = str(config.get("secret") or "")
        if not endpoint or not secret:
            raise RuntimeError("Codex Control endpoint or shared secret is not configured")
        user = getattr(interaction, "user", None)
        payload = {
            "content": prompt,
            "detail": prompt,
            "userId": str(getattr(user, "id", "") or ""),
            "username": str(getattr(user, "name", "") or getattr(user, "global_name", "") or ""),
            "messageId": str(getattr(interaction, "id", "") or ""),
            "discordInteractionId": str(getattr(interaction, "id", "") or ""),
            "channelId": self._codex_control_queue_channel_id(interaction),
            "guildId": str(getattr(interaction, "guild_id", "") or ""),
            "board": str(config.get("board") or "codex-control"),
            "source": "discord-slash-queue",
            "orchestrate": False,
        }
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=data,
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {secret}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"Codex Control API failed: {exc.code} {body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Codex Control API connection failed: {exc.reason}") from exc
        return json.loads(body or "{}")

    def _format_codex_control_queue_ack(self, result: Dict[str, Any], prompt: str) -> str:
        spec = result.get("spec") or {}
        task = result.get("task") or {}
        swarm = result.get("swarmCreated") or {}
        task_id = task.get("id") or task.get("task_id") or result.get("id") or swarm.get("root_id") or "-"
        worker_ids = swarm.get("worker_ids") or []
        title = spec.get("title") or prompt.splitlines()[0][:120] or "Discord task"
        lines = [
            f"[대기열 등록] {title}",
            f"작업 ID: {task_id}",
            f"보드: {result.get('board') or 'codex-control'}",
            f"모드: {result.get('mode') or 'task'}",
            f"담당: {spec.get('assignee') or '-'}",
        ]
        if worker_ids:
            lines.append(f"병렬 worker: {', '.join(worker_ids)}")
        return "\n".join(lines)[:1900]

    async def _run_codex_control_queue_slash(self, interaction: discord.Interaction, prompt: str) -> bool:
        config = self._codex_control_queue_config()
        if not self._should_bridge_codex_control_queue(interaction, config):
            return False
        command_text = f"/queue {prompt}".strip()
        try:
            _user = interaction.user
            logger.info(
                "[Discord] slash '%s' bridged to Codex Control by user=%s id=%s channel=%s guild=%s",
                command_text,
                getattr(_user, "name", "?"),
                getattr(_user, "id", "?"),
                self._codex_control_queue_channel_id(interaction),
                getattr(interaction, "guild_id", None),
            )
        except Exception:
            pass
        if not await self._check_slash_authorization(interaction, command_text):
            return True
        await interaction.response.defer(ephemeral=True)
        try:
            result = await asyncio.to_thread(self._post_codex_control_queue_task, interaction, prompt, config)
            await interaction.edit_original_response(content=self._format_codex_control_queue_ack(result, prompt))
        except Exception as exc:
            logger.exception("Codex Control queue bridge failed")
            message = f"[대기열 등록 실패] {exc}\n일반 Hermes /queue로 fallback하지 않았습니다."
            try:
                await interaction.edit_original_response(content=message[:1900])
            except Exception as cleanup_exc:
                logger.debug("Discord queue bridge failure response failed: %s", cleanup_exc)
        return True

    # -- End Codex Control queue bridge ---------------------------------
'''

def replace_between(text: str, start: str, end: str, replacement: str) -> str:
    if start in text and end in text:
        before, rest = text.split(start, 1)
        _, after = rest.split(end, 1)
        return before + replacement + after
    marker = '    async def _run_simple_slash(\n'
    if marker not in text:
        raise SystemExit('target marker not found')
    return text.replace(marker, replacement + '\n' + marker, 1)

text = TARGET.read_text()
if 'import urllib.request' not in text:
    text = text.replace('import tempfile\n', 'import tempfile\nimport urllib.error\nimport urllib.request\n', 1)
text = replace_between(text, START, END, HELPERS)
old = '''        @tree.command(name="queue", description="Queue a prompt for the next turn (doesn't interrupt)")
        @discord.app_commands.describe(prompt="The prompt to queue")
        async def slash_queue(interaction: discord.Interaction, prompt: str):
            await self._run_simple_slash(interaction, f"/queue {prompt}", "Queued for the next turn.")
'''
new = '''        @tree.command(name="queue", description="Create a Codex Control task in queue channels")
        @discord.app_commands.describe(prompt="Task prompt to enqueue")
        async def slash_queue(interaction: discord.Interaction, prompt: str):
            if await self._run_codex_control_queue_slash(interaction, prompt):
                return
            await self._run_simple_slash(interaction, f"/queue {prompt}", "Queued for the next turn.")
'''
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit('slash_queue block not found')
TARGET.write_text(text)
print('codex-control queue bridge ok')
