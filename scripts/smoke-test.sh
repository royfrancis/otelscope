#!/usr/bin/env bash
# Sends a few clearly synthetic OTLP requests to every port of a running logger container and checks the answers.
#
#   scripts/smoke-test.sh [CONTAINER]
#
# With no argument it uses the compose "logger" service of the project in the current folder. The listeners (tool,
# port, protocol, folder) are read from the container itself, so a port you added or changed is tested as it is.
# It assumes each port is published on 127.0.0.1 under the same number, as docker-compose.yml does.
# It REFUSES to run unless the container's /data/logs is a folder you marked as scratch (a file called
# .otelscope-scratch in it, see README, "Test it first"). Log files are append-only, so a synthetic record sent to
# real logs could never be taken out again: any folder not marked is treated as real, whatever it is called.
# It also REFUSES if the container forwards a copy (OTEL_LOGGER_FORWARD_URL): start the scratch logger with that empty.
set -uo pipefail

name="${1:-}"
[ -n "$name" ] || name="$(docker compose ps -q logger 2>/dev/null | head -n 1)"
[ -n "$name" ] || { echo "no logger container found (start one first, or pass its name)"; exit 2; }

mounted="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/logs"}}{{.Source}}{{end}}{{end}}' "$name" 2>/dev/null || true)"
[ -n "$mounted" ] || { echo "container '$name' not found, or it has no /data/logs mount (is it running? docker ps)"; exit 2; }
here() { (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }
if [ "$(here "$mounted")" = "$(here "$HOME/otelscope")" ]; then
  echo "REFUSING: this logger writes to your real log folder ($mounted)."
  echo "Run the smoke test against a logger that uses a scratch folder (see README, 'Test it first')."
  exit 2
fi
# That only names the usual place. Whatever else this is, it must have been marked as scratch on purpose.
if [ ! -f "$mounted/.otelscope-scratch" ]; then
  echo "REFUSING: $mounted is not marked as a scratch folder (it has no file called .otelscope-scratch)."
  echo "Records sent here could never be taken out again. Use a folder made for this test (see README, 'Test it first')."
  exit 2
fi
echo "logger '$name' writes to the scratch folder $mounted"

# The same goes for the copy docker-compose.yml sends on (OTEL_LOGGER_FORWARD_URL): a synthetic record that reached it stays there.
forwarding="$(docker exec "$name" printenv OTEL_LOGGER_FORWARD_URL 2>/dev/null || true)"
if [ -n "$forwarding" ]; then
  echo "REFUSING: this logger also forwards everything to $forwarding, so the synthetic records would reach that receiver too."
  echo "Start the scratch logger with the copy off (OTEL_LOGGER_FORWARD_URL empty), see README, 'Test it first'."
  exit 2
fi

listeners="$(docker exec "$name" /usr/local/bin/entrypoint.sh listeners)" || { echo "could not read the container's listeners"; exit 2; }
[ -n "$listeners" ] || { echo "the container reports no listeners"; exit 2; }
# a listener with a folder outside /data/logs is not covered by the check above, so it cannot be shown to be scratch
if echo "$listeners" | cut -f4 | grep -qv '^/data/logs/'; then
  echo "REFUSING: a listener writes outside /data/logs, so this script cannot tell that it is a scratch folder:"
  echo "$listeners" | cut -f1,4 | grep -v "	/data/logs/" | sed 's/^/  /'
  exit 2
fi

claude_dir="$(echo "$listeners" | awk -F'\t' '$1 == "claude" { print $4 }')"

pass=0
fail=0
check() { # description expected actual
  if [ "$2" = "$3" ]; then echo "  ok    $1"; pass=$((pass + 1)); else echo "  FAIL  $1 (expected $2, got $3)"; fail=$((fail + 1)); fi
}
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }
# how many records a log file holds (0 while it does not exist yet)
records() { docker exec "$name" sh -c "python3 /app/otel-logger.py cat '$1' 2>/dev/null | wc -l" | tr -d ' '; }
# a protobuf request, built inside the container with the logger's own libraries; prints the HTTP status and content type
proto_post() { # port, json
  docker exec -i "$name" python3 - "$1" "$2" <<'PY'
import importlib.util, json, sys, urllib.error, urllib.request

spec = importlib.util.spec_from_file_location("otel_logger", "/app/otel-logger.py")
L = importlib.util.module_from_spec(spec)
spec.loader.exec_module(L)
request = urllib.request.Request(
    f"http://127.0.0.1:{sys.argv[1]}/v1/logs", data=L.json_to_proto("logs", json.loads(sys.argv[2])),
    headers={"Content-Type": "application/x-protobuf"},
)
try:
    with urllib.request.urlopen(request, timeout=10) as reply:
        print(reply.status, reply.headers.get("Content-Type") if reply.read() == b"" else "unexpected body")
except urllib.error.HTTPError as err:
    print(err.code, "-")
PY
}

LOGS='{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}],"droppedAttributesCount":0},"scopeLogs":[{"scope":{"name":"smoke-test"},"logRecords":[{"timeUnixNano":"1760000000000000000","observedTimeUnixNano":"1760000000000000000","body":{"stringValue":"smoke_test.event"},"attributes":[{"key":"note","value":{"stringValue":"synthetic record from scripts/smoke-test.sh"}}],"droppedAttributesCount":0}]}]}]}'
OTHER="${LOGS/\"claude-code\"/\"smoke-test\"}"   # the same payload, from a service that is not Claude Code

while IFS=$'\t' read -r tool port protocol dir; do
  base="http://127.0.0.1:$port"
  # Claude Code's own port gets a Claude Code payload; every other port gets one from another tool
  payload="$OTHER"; [ "$tool" = claude ] && payload="$LOGS"
  want_json=200; want_proto=200
  [ "$protocol" = protobuf ] && want_json=415
  [ "$protocol" = json ] && want_proto=415
  echo
  echo "$tool on port $port ($protocol) -> $dir"
  before="$(records "$dir/logs.pblog")"
  before_other="$(records /data/logs/other/logs.pblog)"

  check "GET  /healthz" 200 "$(status "$base/healthz")"
  check "POST /v1/logs as JSON" "$want_json" "$(status -X POST -H 'Content-Type: application/json' -d "$payload" "$base/v1/logs")"
  got="$(proto_post "$port" "$payload")"
  check "POST /v1/logs as protobuf" "$want_proto" "${got%% *}"
  [ "$want_proto" = 200 ] && check "  protobuf is answered in protobuf" "200 application/x-protobuf" "$got"
  check "POST /v1/nope (not a signal)" 404 "$(status -X POST -H 'Content-Type: application/json' -d "$payload" "$base/v1/nope")"
  check "POST /v1/logs with text that is not OTLP" 415 "$(status -X POST -H 'Content-Type: text/plain' -d 'hello' "$base/v1/logs")"
  if [ "$want_json" = 200 ]; then
    check "POST /v1/logs with JSON that is not OTLP" 400 "$(status -X POST -H 'Content-Type: application/json' -d '[]' "$base/v1/logs")"
  fi

  added=0
  [ "$want_json" = 200 ] && added=$((added + 1))
  [ "$want_proto" = 200 ] && added=$((added + 1))
  check "records added to $dir/logs.pblog" "$added" "$(($(records "$dir/logs.pblog") - before))"

  if [ "$tool" = claude ] && [ "$want_json" = 200 ]; then # the Claude Code port keeps other tools out of its files
    check "POST /v1/logs from another tool on this port" 200 "$(status -X POST -H 'Content-Type: application/json' -d "$OTHER" "$base/v1/logs")"
    check "  kept apart: it went to other/, not to $tool/" 1 "$(($(records /data/logs/other/logs.pblog) - before_other))"
    check "  and $dir/logs.pblog did not grow" "$added" "$(($(records "$dir/logs.pblog") - before))"
  fi

  if [ "$tool" != claude ] && [ -n "$claude_dir" ] && [ "$want_json" = 200 ]; then # a Claude Code session set to the wrong port
    before_claude="$(records "$claude_dir/logs.pblog")"
    before_own="$(records "$dir/logs.pblog")"
    check "POST /v1/logs from Claude Code on this port" 200 "$(status -X POST -H 'Content-Type: application/json' -d "$LOGS" "$base/v1/logs")"
    check "  goes to $claude_dir, not to $tool/" 1 "$(($(records "$claude_dir/logs.pblog") - before_claude))"
    check "  and $dir/logs.pblog did not grow" 0 "$(($(records "$dir/logs.pblog") - before_own))"
  fi
done <<< "$listeners"

echo
echo "$pass passed, $fail failed."
[ "$fail" -eq 0 ]
