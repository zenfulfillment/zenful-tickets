#!/usr/bin/env bash
# Loads .env.build secrets (e.g. ELEVENLABS_API_KEY) into the environment so
# `option_env!()` can bake them into the Rust binary, then runs `tauri build`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.build"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "warn: $ENV_FILE not found — voice will be disabled in the bundled app." >&2
fi

cd "$ROOT"
exec pnpm tauri build "$@"
