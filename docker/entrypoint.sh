#!/usr/bin/env bash
# Entrypoint for the emulate container.
#
# Two shapes are supported:
#
#   docker run <image>
#       Serves the emulator. Uses a seed found in the import directory when one
#       is present, so a snapshot volume is picked up automatically.
#
#   docker run <image> scripts/import-github <owner/repo> [options]
#       Imports a real repository, then serves it. Any other command is executed
#       verbatim, which keeps the image usable as a general-purpose shell.
set -euo pipefail

GIT_DIR_ROOT="${EMULATE_GIT_DIR:-/data/git}"
IMPORT_DIR="${EMULATE_IMPORT_DIR:-/data/import}"
PORT="${EMULATE_PORT:-80}"
SERVICE="${EMULATE_SERVICE:-github}"

# The transport spawns git, so a missing binary must fail loudly at startup
# rather than surfacing later as a confusing clone failure.
if ! command -v git >/dev/null 2>&1; then
  echo "entrypoint: git is required but was not found on PATH" >&2
  exit 1
fi

serve() {
  local seed_args=()
  if [ -f "${IMPORT_DIR}/emulate.config.json" ]; then
    seed_args=(--seed "${IMPORT_DIR}/emulate.config.json")
    echo "entrypoint: serving seed from ${IMPORT_DIR}/emulate.config.json" >&2
    if [ -f "${IMPORT_DIR}/manifest.json" ]; then
      node -e '
        const m = require(process.argv[1]);
        const c = m.counts || {};
        console.error(`entrypoint: ${m.served_as} - ${c.issues} issues, ${c.pull_requests} pull requests, ${c.commits} commits`);
      ' "${IMPORT_DIR}/manifest.json" || true
    fi
  fi

  local base_url_args=()
  if [ -n "${EMULATE_BASE_URL:-}" ]; then
    base_url_args=(--base-url "${EMULATE_BASE_URL}")
  fi

  exec node "${EMULATE_CLI:-/app/emulate/index.js}" start \
    --service "${SERVICE}" \
    --port "${PORT}" \
    "${base_url_args[@]}" \
    "${seed_args[@]}"
}

if [ "$#" -eq 0 ]; then
  serve
fi

case "$1" in
  scripts/import-github|scripts/import-github.mjs|import-github)
    shift
    # Import into the snapshot directory, then serve it. Re-running replaces the
    # snapshot atomically, so a failed import leaves the previous one intact.
    node /app/scripts/import-github.mjs "$@" --out "${IMPORT_DIR}"
    export EMULATE_GIT_DIR="${GIT_DIR_ROOT}"
    serve
    ;;
  serve)
    serve
    ;;
  *)
    exec "$@"
    ;;
esac
