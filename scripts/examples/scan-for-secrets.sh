#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"

# Conservative public-repo checks. This intentionally avoids printing matched secrets.
patterns=(
  'sk-[A-Za-z0-9_-]{20,}'
  'xox[baprs]-[A-Za-z0-9-]+'
  'gh[pousr]_[A-Za-z0-9_]{20,}'
  'AKIA[0-9A-Z]{16}'
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
)

failed=0
for pattern in "${patterns[@]}"; do
  if grep -RInE --exclude-dir=.git --exclude='scan-for-secrets.sh' "$pattern" "$ROOT" >/tmp/hermes-secret-scan.$$ 2>/dev/null; then
    echo "Potential secret-like pattern detected. Review repository before publishing."
    cut -d: -f1-2 /tmp/hermes-secret-scan.$$ | sort -u
    failed=1
  fi
done
rm -f /tmp/hermes-secret-scan.$$

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "Secret scan passed."
