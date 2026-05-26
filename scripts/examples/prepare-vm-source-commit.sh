#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TARGET="${1:-${HERMES_VM_SSH_TARGET:-}}"
MODE="${2:-report}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
IMPORT_ROOT="${HERMES_VM_IMPORT_ROOT:-$ROOT/.hermes-import/$STAMP}"

REMOTE_AGENT="${HERMES_VM_AGENT_PATH:-/home/ubuntu/.hermes/hermes-agent}"
REMOTE_DASHBOARD="${HERMES_VM_DASHBOARD_PATH:-/home/ubuntu/.hermes/codex-control-dashboard}"
REMOTE_SYSTEMD="${HERMES_VM_SYSTEMD_PATH:-/home/ubuntu/.config/systemd/user}"

usage() {
  cat <<'EOF'
Usage:
  scripts/examples/prepare-vm-source-commit.sh <ssh-target> [report|import]

Modes:
  report  Read-only VM status and candidate source summary.
  import  Copy allowlisted source candidates into ignored .hermes-import/.

Environment overrides:
  HERMES_VM_SSH_TARGET
  HERMES_VM_AGENT_PATH
  HERMES_VM_DASHBOARD_PATH
  HERMES_VM_SYSTEMD_PATH
  HERMES_VM_IMPORT_ROOT

This script never copies VM .env, auth, DB, memories, sessions, logs, backups,
raw gateway state, or dashboard runtime state into the tracked repo.
EOF
}

if [[ -z "$TARGET" || "$TARGET" == "-h" || "$TARGET" == "--help" ]]; then
  usage
  exit 2
fi

if [[ "$MODE" != "report" && "$MODE" != "import" ]]; then
  usage
  exit 2
fi

ssh_vm() {
  ssh -o BatchMode=yes "$TARGET" "$@"
}

echo "VM target: $TARGET"
echo "Mode: $MODE"
echo

ssh_vm "
set -eu

echo '== hermes-agent git state =='
if [ -d '$REMOTE_AGENT/.git' ]; then
  git -C '$REMOTE_AGENT' status --short
  git -C '$REMOTE_AGENT' diff --stat -- README.md HERMES.md PROJECT.md SECURITY.md CHANGELOG.md docs jobs skills prompts scripts config diagrams ops .gitignore 2>/dev/null || true
else
  echo 'missing git repo: $REMOTE_AGENT'
fi

echo
echo '== dashboard source candidates =='
if [ -d '$REMOTE_DASHBOARD' ]; then
  find '$REMOTE_DASHBOARD' -maxdepth 3 -type f \\
    ! -name '*.env' \\
    ! -name '*.db' \\
    ! -name '*.sqlite' \\
    ! -name '*.sqlite3' \\
    ! -name '*.log' \\
    ! -name 'auth.json' \\
    ! -name '*state*.json' \\
    | sed \"s|^$REMOTE_DASHBOARD/||\" | sort
else
  echo 'missing dashboard path: $REMOTE_DASHBOARD'
fi

echo
echo '== relevant user services =='
for svc in codex-control-api.service codex-discord-relay.service hermes-gateway.service hermes-dashboard.service; do
  systemctl --user show \"\$svc\" --property=Id,LoadState,ActiveState,SubState,FragmentPath --no-pager 2>/dev/null || true
done
"

if [[ "$MODE" == "report" ]]; then
  exit 0
fi

mkdir -p "$IMPORT_ROOT/hermes-agent" "$IMPORT_ROOT/codex-control-dashboard" "$IMPORT_ROOT/systemd/user"

echo
echo "Importing allowlisted source candidates to: $IMPORT_ROOT"

ssh_vm "
set -eu
cd '$REMOTE_AGENT'
for p in README.md HERMES.md PROJECT.md SECURITY.md CHANGELOG.md docs jobs skills prompts scripts diagrams ops .gitignore config/README.md config/example.env config/hermes.example.yaml config/provider-routing.example.yaml; do
  [ -e \"\$p\" ] && printf '%s\\0' \"\$p\"
done | tar --null -cf - --files-from -
" | tar -xf - -C "$IMPORT_ROOT/hermes-agent"

ssh_vm "
set -eu
cd '$REMOTE_DASHBOARD'
for p in server.js discord-relay.js dashboard-smoke.sh codex-control.env.example public/index.html public/app.js public/styles.css; do
  [ -e \"\$p\" ] && printf '%s\\0' \"\$p\"
done | tar --null -cf - --files-from -
" | tar -xf - -C "$IMPORT_ROOT/codex-control-dashboard"

ssh_vm "
set -eu
cd '$REMOTE_SYSTEMD'
for p in codex-control-api.service codex-discord-relay.service hermes-gateway.service hermes-dashboard.service; do
  [ -e \"\$p\" ] && printf '%s\\0' \"\$p\"
done | tar --null -cf - --files-from -
" | tar -xf - -C "$IMPORT_ROOT/systemd/user"

find "$IMPORT_ROOT" -type f | sed "s|^$IMPORT_ROOT/||" | sort > "$IMPORT_ROOT/MANIFEST.txt"

"$ROOT/scripts/examples/scan-for-secrets.sh" "$IMPORT_ROOT"

cat <<EOF

Imported candidates are ignored by git:
  $IMPORT_ROOT

Next:
  1. Review $IMPORT_ROOT/MANIFEST.txt
  2. Manually port only sanitized source changes into tracked repo paths.
  3. Run scripts/examples/scan-for-secrets.sh and validation before commit.
EOF
