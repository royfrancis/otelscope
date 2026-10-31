#!/usr/bin/env bash
# Entry point of the otelscope-site image. Modes (the first argument, default "site"):
#   site      the site, on $SITE_PORT (reads every folder of $OTEL_LOGGER_DIR; works with a read-only mount)
#   data      regenerate the site's data files once, then exit
#   test      run the Python and JavaScript test suites
#   shell     a shell (node and python3 are installed)
# Anything else is run as a command, e.g.: docker run --rm <image> node --version
# No port is built into the image: SITE_PORT is set when the container starts (docker-compose.yml).
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
cd "$APP_DIR"

say() { printf '[otelscope] %s\n' "$*"; }

need_env() { # NAME, an example
  if [ -z "${!1:-}" ]; then
    say "error: $1 is not set. The image has no ports of its own; set it when the container starts, e.g. $1=$2"
    exit 64
  fi
}

prepare_data() {
  # No data yet is fine: the site starts, and "Refresh" fills it in once there is some.
  node scripts/prepare-data.mjs || say "no data yet: once something has been logged, press Refresh in the site"
}

health() {
  python3 -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=8)' "http://127.0.0.1:${SITE_PORT}/"
}

mode="${1:-site}"
[ "$#" -gt 0 ] && shift

case "$mode" in
  site)
    need_env SITE_PORT 5174
    prepare_data
    exec ./node_modules/.bin/vitepress dev docs --host "${SITE_HOST:-127.0.0.1}" --port "$SITE_PORT"
    ;;
  data) exec node scripts/prepare-data.mjs "$@" ;;
  test) python3 -m unittest discover -s tests -p 'test_*.py' && exec npm test ;;
  health | healthcheck) health ;;
  shell) exec bash ;;
  *) exec "$mode" "$@" ;;
esac
