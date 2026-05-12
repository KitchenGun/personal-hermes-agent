#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"
OUT="${2:-/tmp/hermes-job-registry-index.txt}"

find "$ROOT/jobs" -type f -name '*.yaml' ! -path '*/examples/*' | sort > "$OUT"
echo "Wrote registry index to $OUT"
echo "Cron runners can read this index and dispatch enabled jobs by schedule."
