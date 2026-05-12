#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"

required=(
  "$ROOT/README.md"
  "$ROOT/SECURITY.md"
  "$ROOT/config/example.env"
  "$ROOT/config/hermes.example.yaml"
  "$ROOT/config/provider-routing.example.yaml"
  "$ROOT/jobs/README.md"
  "$ROOT/prompts/workflows/add-job-to-repo.md"
)

for path in "${required[@]}"; do
  [[ -f "$path" ]] || { echo "Missing required file: $path"; exit 1; }
done

bash "$ROOT/scripts/examples/validate-job-registry.sh" "$ROOT"

echo "Example validation passed."
