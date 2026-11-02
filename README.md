# otelscope <span><img src="docs/public/logo.svg" style="height:30px;vertical-align:middle;"></span>

![otelscope preview](preview-1.webp)

![otelscope logs preview](preview-2.webp)

Records the OpenTelemetry (OTEL) output of AI coding tools such as Claude Code, VS Code Copilot Chat, OpenCode and Positron on your own machine, and lets you explore it in a small website. It is two Docker containers that can run together or on their own: a **logger** that appends everything it receives to protobuf log files in `~/otelscope`, one folder per tool, and a **site** that only reads those files and has a tab for each tool.

```
Claude Code ──▶─┐   OTLP/HTTP, protobuf
VS Code     ──▶─┼──▶ logger container ──▶ ~/otelscope/<tool>/{metrics,logs,traces}.pblog
OpenCode    ──▶─┤
Positron    ──▶─┘

~/otelscope ──▶ site (a second container, read-only) ──▶ 127.0.0.1:5174
```

## Quick start

Needs Docker with Compose.

1. Create the log folder. It must exist before the first start: a missing folder is an error, not a new empty one.

   ```bash
   mkdir -p ~/otelscope
   ```

2. Build and start the logger and the site.

   ```bash
   docker compose up -d --build
   ```

   The logger listens on `127.0.0.1`, one port per tool: the endpoints under [Tool settings](#tool-settings) (`curl http://127.0.0.1:4318/healthz` answers `ok`). The site is at <http://127.0.0.1:5174/>.

3. Point your tool at its port: see [Tool settings](#tool-settings).

4. Use the tool, then press **Refresh** in the site to load the new activity.

The ports are published on `127.0.0.1` only. Inside the containers the servers listen on every interface, and the logger receives your prompts and responses, so never publish the ports more widely.

> **A copy of every request is also forwarded** to `http://host.docker.internal:5080` by default (nothing has to listen there). Turn it off with `OTEL_LOGGER_FORWARD_URL=` (empty) in a git-ignored `.env` next to `docker-compose.yml`. See [Forwarding](#forwarding-to-another-receiver).

Day to day:

```bash
docker compose stop    # stop, and start again with: docker compose start
docker compose down    # remove the containers
docker compose -f docker-compose.logger.yml up -d --build   # build and run only the logger
docker compose -f docker-compose.site.yml up -d --build     # build and run only the site
```

## Tool settings

Each tool sends OTLP over HTTP to its own port on the logger, and the port decides which tool the data belongs to. Anything in front of `/v1/<signal>` in the path is ignored. Set every tool to **protobuf**: JSON is accepted too, but is converted to protobuf on arrival. Either can be sent uncompressed, or with gzip or deflate. The `Content-Type` says which format it is; if it says neither (or something wrong, such as curl's default) the body is looked at instead. The reply is in the format of the request; an error reply (a `google.rpc.Status`) is protobuf if the `Content-Type` says protobuf, and JSON otherwise. gRPC is not supported.

### Claude Code

The documentation is at [Claude Code monitoring guide](https://code.claude.com/docs/en/monitoring-usage). Update `~/.claude/settings.json` and restart Claude Code.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORTER": "otlp",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "OTEL_LOG_USER_PROMPTS": "1",
    "OTEL_LOG_ASSISTANT_RESPONSES": "1",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
    "OTEL_METRICS_INCLUDE_VERSION": "true",
    "OTEL_METRICS_INCLUDE_ENTRYPOINT": "true",
    "OTEL_METRICS_INCLUDE_REPOSITORY": "true"
  }
}
```

### VS Code Copilot Chat

The full list of settings and signals is in VS Code's [monitoring guide](https://code.visualstudio.com/docs/agents/guides/monitoring-agents). Update user settings in `settings.json` (`~/Library/Application\ Support/Code/User/settings.json`), then *Developer: Reload Window*:

```json
"github.copilot.chat.otel.enabled": true,
"github.copilot.chat.otel.exporterType": "otlp-http",
"github.copilot.chat.otel.protocol": "http/protobuf",
"github.copilot.chat.otel.otlpEndpoint": "http://127.0.0.1:4316",
"github.copilot.chat.otel.captureContent": true,
"github.copilot.chat.otel.captureIdentity": true
```

### OpenCode

OpenCode has no built-in exporter; the community plugin [`@devtheops/opencode-plugin-otel`](https://github.com/DEVtheOPS/opencode-plugin-otel) adds one. Add it to `~/.config/opencode/opencode.json` and restart OpenCode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@devtheops/opencode-plugin-otel",
      "options": {
        "enabled": true,
        "endpoint": "http://localhost:4317",
        "protocol": "http/protobuf"
      }
    }
  ]
}
```

### Positron

Positron has no OTEL documentation; its settings are defined in the [source](https://github.com/posit-dev/positron/blob/main/extensions/copilot/src/platform/otel/common/otelConfig.ts) and are those of VS Code Copilot Chat, except `captureIdentity`, which Positron does not have. Update user settings in `settings.json` (`~/Library/Application\ Support/Positron/User/settings.json`) and restart Positron:

```json
"github.copilot.chat.otel.enabled": true,
"github.copilot.chat.otel.exporterType": "otlp-http",
"github.copilot.chat.otel.protocol": "http/protobuf",
"github.copilot.chat.otel.otlpEndpoint": "http://127.0.0.1:4320",
"github.copilot.chat.otel.captureContent": true,
"github.copilot.chat.otel.serviceName": "positron-copilot-chat"
```

The `COPILOT_OTEL_*`, `OTEL_EXPORTER_OTLP_*` and `OTEL_SERVICE_NAME` environment variables override these settings when they are set in the shell that starts Positron.

## The website

**otelscope** is a [VitePress](https://vitepress.dev) site at <http://127.0.0.1:5174/> with a tab for each log folder. Every tool gets the same two views, populated from its data without tool-specific configuration:

- **Usage**: a zoomable stacked bar chart, initially covering the last 24 hours, with time-range and calendar controls, metric and color options, and a table and total. Session search and model breakdowns appear when the data has them.
- **Logs**: a searchable, paged table of events and spans, with event and column selectors. It opens on a prompt event or the most frequent log event.

The navbar switches between **Usage** and **Logs** and has **Refresh**, which adds tabs for new folders and updates the view.

## Configuration

Ports, protocols and folders are set in `docker-compose.yml`. Override them without rebuilding, from a git-ignored `.env` next to it or from the shell; `docker compose up -d` is enough to apply a change.

| Variable | Default | |
|---|---|---|
| `<TOOL>_PORT` (`CLAUDE_PORT`, `VSCODE_PORT`, …) | in `docker-compose.yml` | Each tool's port, the same on your system and in the container, so a tool's setting is what the logger listens on. |
| `<TOOL>_PROTOCOL` | `any` | What the port accepts: `any`, `protobuf` or `json` (`http/…` forms work too). The other format gets a `415` and is not logged, so a tool set to the wrong format shows up as an error. gRPC is not supported. |
| `<TOOL>_DIR` | empty: `<logs>/<tool>` | A folder of its own, as a path **inside the container** (a relative one is under `/data/logs`). If it is outside `/data/logs`, mount it too (add a `volumes` entry) or the logger refuses to start. The site only reads folders under the log folder. |
| `SITE_PORT` | `5174` | The site's port. |
| `OTEL_LOGS_DIR` | `~/otelscope` | The log folder on your system (must already exist). |
| `OTEL_LOGGER_FORWARD_URL`, `OTEL_LOGGER_FORWARD_HEADERS` | `http://host.docker.internal:5080`, empty | The copy sent on to another receiver: see [Forwarding](#forwarding-to-another-receiver). |

`docker compose exec logger entrypoint.sh listeners` shows what the logger is using. The raw `OTEL_LOGGER_LISTEN` syntax, `NAME:PORT[:PROTOCOL[:DIR]]`, and all the logger's own settings are described at the top of `otel-logger.py`.

**Adding a tool** (say `mytool` on 4321): in the `logger` service of `docker-compose.yml`, add a `ports` entry, `"127.0.0.1:${MYTOOL_PORT:-4321}:${MYTOOL_PORT:-4321}"`, and an `OTEL_LOGGER_LISTEN` entry, `mytool:${MYTOOL_PORT:-4321}:${MYTOOL_PROTOCOL:-any}:${MYTOOL_DIR:-}` (with a comma after the entry before it). Both are needed because Docker only publishes the ports a compose file lists. Then point the tool at it, as in [Tool settings](#tool-settings), and add a section for it there. Its folder, `~/otelscope/mytool/`, appears with the first request, and its tab on the site after **Refresh**, called after its folder (`Mytool`). A name is letters, digits, `-` and `_` (`other` is reserved). A missing comma, or a repeated name, port or folder, stops the logger with a message. The [smoke test](#smoke-test) needs a port of its own for the new tool too (`MYTOOL_PORT=14321`).

**Removing a tool**: delete its two lines from `docker-compose.yml` and its section under Tool settings. The logs in `~/otelscope/<tool>/` are never deleted, so its tab stays on the site until you move that folder away yourself.

## Forwarding to another receiver

Besides writing the log files, the logger sends every request on to another OTLP/HTTP receiver, as protobuf. `docker-compose.yml` sets `OTEL_LOGGER_FORWARD_URL` to `http://host.docker.internal:5080` (inside the container `127.0.0.1` is the container itself, so your system is `host.docker.internal`; the logger adds `/v1/<signal>`). `OTEL_LOGGER_FORWARD_HEADERS` (`name=value,name=value`) adds headers for a receiver that needs a login. Set `OTEL_LOGGER_FORWARD_URL=` (empty) in the git-ignored `.env` to turn the copy off.

The copy runs in the background with a bounded queue and retries, so it never slows the logging. If nothing answers, the logger prints `forward: cannot reach the receiver …` (at most once a minute, see `docker compose logs logger`) and drops that copy. It refuses to start if the URL is one of its own ports on this machine, because every copy would be logged and forwarded again, forever; that is also why no tool listens on 5080.

An example receiver, otelview:

```
# website on 4319
# listening to otel on 4318 (http) or optionally 4317 (gRPC)
# data is stored in ~/otelview

docker run -d \
  --name otelview \
  --restart unless-stopped \
  -p 127.0.0.1:5080:4318 \
  -p 127.0.0.1:4319:4319 \
  -v ~/otelview:/data \
  ghcr.io/tsirysndr/otelview \
  --listen 0.0.0.0:4319 \
  --storage duckdb
```

## Reading the logs

`.pblog` files are binary, so `grep` and `jq` can't read them directly. `cat` (with `-T`, so Compose doesn't add a terminal to piped output) prints each record as a JSON line (`{"received_at": …, "data": …}`):

```bash
docker compose run --rm -T tools cat /data/logs/claude/logs.pblog | jq -r '.data.resourceLogs[].scopeLogs[].logRecords[].body.stringValue' | sort | uniq -c | sort -rn
```

Without Docker: `python3 otel-logger.py cat FILE | jq …` (after `pip install -r requirements.txt`). `cat` skips damaged records and says how many.

## Smoke test

`scripts/smoke-test.sh` sends a few clearly synthetic requests to every port of a running logger and checks the answers. Log files are append-only, so a synthetic record in your real logs could never be removed. The script therefore only runs against a logger whose log folder is **marked as scratch** (a file called `.otelscope-scratch` in it) and that forwards no copy. Start a throwaway logger beside your own, with another project name and other ports so that it doesn't replace the real one:

```bash
mkdir -p ~/otelscope-scratch && touch ~/otelscope-scratch/.otelscope-scratch
OTEL_LOGS_DIR="$HOME/otelscope-scratch" OTEL_LOGGER_FORWARD_URL= CLAUDE_PORT=14318 VSCODE_PORT=14316 OPENCODE_PORT=14317 POSITRON_PORT=14320 \
  docker compose -p otelscope-test up -d --build logger
scripts/smoke-test.sh otelscope-test-logger-1
docker compose -p otelscope-test down
```

## How it works

- **One port per tool.** `otel-logger.py` listens on several ports at once, and the port decides which tool a request belongs to. Every port takes `POST /v1/<signal>` (`metrics`, `logs` or `traces`) and `GET /healthz`.
- **The Claude Code guard.** The `claude` port keeps a request only if its `service.name` is `claude-code` or `claude-code-desktop`; anything else sent there goes to `~/otelscope/other/`. Claude Code data that arrives on another tool's port is moved to `~/otelscope/claude/`. So neither mixes into the other's files, which can't be cleaned afterward.
- **The files.** Each request is appended to `~/otelscope/<tool>/{metrics,logs,traces}.pblog` as one record: the receive time and **the OTLP request exactly as the tool sent it** (format in `otel-record.proto`). Files are only opened for appending: nothing deletes, truncates or rewrites them, and a test enforces that. The logger never prints request content.
- **Two images.** `Dockerfile.logger` (Python and the protobuf libraries) **writes** the logs; `Dockerfile.site` (Node and VitePress, plus Python only to read the `.pblog` files) serves the website and **reads** them. Neither holds a port: `docker-compose.yml` sets them at start. Your log folder is mounted into both (read-only for the site), so the files stay on your system, and the logger refuses to start if its folder isn't a mount. The site can be down without the logger noticing.

---

2026 • Roy Francis
