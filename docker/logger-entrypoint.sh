#!/usr/bin/env bash
# Entry point of the otelscope-logger image. Modes (the first argument, default "logger"):
#   logger    one OTLP port per entry of $OTEL_LOGGER_LISTEN, writing into $OTEL_LOGGER_DIR
#   listeners print what $OTEL_LOGGER_LISTEN means: name, port, protocol, folder
#   cat       print .pblog files as JSON lines:             cat /data/logs/claude/logs.pblog | jq ...
#   convert   turn old .jsonl logs into .pblog files:        convert SRC DST [--dry-run]
#   test      run the logger's Python tests (the site image runs those and the JavaScript ones)
#   shell     a shell (python3 and jq are installed)
# Anything else is run as a command, e.g.: docker run --rm <image> jq --version
# No port is built into the image: OTEL_LOGGER_LISTEN is set when the container starts (docker-compose.yml).
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
LOG_DIR="${OTEL_LOGGER_DIR:-/data/logs}"
MOUNTINFO="${MOUNTINFO:-/proc/self/mountinfo}" # a variable only so that the checks below can be tried on a fake one
cd "$APP_DIR"

say() { printf '[otelscope] %s\n' "$*"; }

need_env() { # NAME, an example
  if [ -z "${!1:-}" ]; then
    say "error: $1 is not set. The image has no ports of its own; set it when the container starts, e.g. $1=$2"
    exit 64
  fi
}

listeners() { python3 otel-logger.py listeners; } # name, port, protocol, folder: tab separated

# True if the folder, or one above it (other than /), is a mount point.
is_mounted() {
  local dir="$1"
  while [ -n "$dir" ] && [ "$dir" != / ]; do
    awk -v dir="$dir" '$5 == dir { found = 1 } END { exit !found }' "$MOUNTINFO" 2>/dev/null && return 0
    dir="$(dirname "$dir")"
  done
  return 1
}

# The logs must live outside the container: anything written inside it is lost when the container is removed.
# That goes for the log folder and for any folder a listener was given of its own.
require_mounted_logs() {
  if [ "${ALLOW_UNMOUNTED_LOGS:-}" = 1 ]; then
    say "warning: the log folders are not mounted, so what is logged will be lost with this container"
    return
  fi
  local dir
  { echo "$LOG_DIR"; listeners | cut -f4; } | while IFS= read -r dir; do
    if ! is_mounted "$dir"; then
      say "error: $dir is not on a mounted folder. Refusing to log inside the container."
      say "       Mount your log folder:  --mount type=bind,src=\$HOME/otelscope,dst=$LOG_DIR"
      say "       (throwaway test only:   -e ALLOW_UNMOUNTED_LOGS=1)"
      exit 1
    fi
  done || exit 64
}

health() { # every listener has to answer
  local port
  for port in $(listeners | cut -f2); do
    python3 -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=8)' "http://127.0.0.1:$port/healthz" || return 1
  done
}

mode="${1:-logger}"
[ "$#" -gt 0 ] && shift

case "$mode" in
  logger)
    need_env OTEL_LOGGER_LISTEN claude:4318,vscode:4316
    require_mounted_logs
    exec python3 otel-logger.py serve
    ;;
  listeners) exec python3 otel-logger.py listeners ;;
  cat) exec python3 otel-logger.py cat "$@" ;;
  convert) exec python3 otel-logger.py convert "$@" ;;
  test) exec python3 -m unittest discover -s tests -p 'test_*.py' ;;
  health | healthcheck) health ;;
  shell) exec bash ;;
  *) exec "$mode" "$@" ;;
esac
