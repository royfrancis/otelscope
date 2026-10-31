#!/usr/bin/env python3
"""
Local logger for OpenTelemetry data from AI coding tools.

Receives OTLP over HTTP (protobuf, or JSON) and appends every request to a protobuf log. It listens on as many
ports as OTEL_LOGGER_LISTEN lists, and the PORT decides which tool a request belongs to:

    <log dir>/claude/{metrics,logs,traces}.pblog      POST /v1/<signal> on Claude Code's port
    <log dir>/vscode/...                              POST /v1/<signal> on VS Code's port
    <log dir>/other/...      a request on the "claude" port that does not come from Claude Code

Each entry is NAME:PORT[:PROTOCOL[:DIR]]:
    NAME      the tool, and by default the folder under the log dir (letters, digits, - and _; "other" is reserved)
    PORT      the port to listen on
    PROTOCOL  any (the default), protobuf or json: what that port accepts. Anything else is answered 415
    DIR       where that port's files go, instead of <log dir>/<NAME> (a relative DIR is under the log dir)

A listener named "claude" only keeps requests whose service.name is Claude Code's: anything else sent to that
port goes to other/, so a tool pointed at the wrong port can never mix into the Claude Code files. The other way
round too: Claude Code data that arrives on another tool's port (a session still set to an old port) is moved
over to the claude folder, so it never ends up among that tool's files.

FILE FORMAT. A .pblog file is a series of records, each appended in a single write:

    4 bytes  marker "OTLP"          lets a reader find the next record again after a crash or damage
    4 bytes  body length            big-endian
    4 bytes  CRC32 of the body      big-endian
    n bytes  body                   a protobuf Record (see otel-record.proto): received_at, payload

The payload is the OTLP request exactly as the tool sent it (a tool that sends JSON is converted to protobuf
once, on arrival). There is no file header, so two files can simply be concatenated. Log files are only ever
opened for appending; nothing here deletes, truncates or rewrites them.

COMMANDS
    otel-logger.py [serve]                       receive and log (the default)
    otel-logger.py cat FILE...                   print the records as JSON lines, {"received_at", "data"}, for jq
    otel-logger.py listeners                     print the listeners OTEL_LOGGER_LISTEN describes: name, port, protocol, dir
    otel-logger.py convert SRC DST [--dry-run]   turn old metrics/logs/traces .jsonl files into .pblog files

Needs `protobuf` and `opentelemetry-proto` (see requirements.txt; Python 3.10+).

Environment variables for serve (all optional):
    OTEL_LOGGER_LISTEN         the listeners, comma separated, as above (default claude:4318)
    OTEL_LOGGER_DIR            the log dir: where the folders go (default ~/otelscope)
    OTEL_LOGGER_HOST           address to listen on, for every port (default 127.0.0.1)
    OTEL_LOGGER_MAX_BODY_MB    largest request accepted, after decompression (default 64)
    OTEL_LOGGER_CLAUDE_SERVICES    service.name values that count as Claude Code (default claude-code,claude-code-desktop)
    OTEL_LOGGER_FORWARD_URL    also send every request on, as OTLP protobuf, to <url>/v1/<signal> (refused if it is one of
                               this logger's own ports on this machine: the copy would be logged and sent on again, forever)
    OTEL_LOGGER_FORWARD_HEADERS    extra headers for that, as name=value,name=value
    OTEL_LOGGER_FORWARD_QUEUE_MB   memory kept for requests waiting to be forwarded (default 64)
"""
import argparse
import base64
import json
import mmap
import os
import re
import signal as posix_signal
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

SIGNALS = ("metrics", "logs", "traces")
EXT = ".pblog"  # what the logger writes
LEGACY_EXT = ".jsonl"  # what the previous logger wrote, and what `convert` reads
DEFAULT_LISTEN = "claude:4318"
PROTOCOLS = {"any": "any", "protobuf": "protobuf", "http/protobuf": "protobuf", "json": "json", "http/json": "json"}
DEFAULT_CLAUDE_SERVICES = "claude-code,claude-code-desktop"
UNMATCHED = "other"  # where a request to the Claude Code path goes when it does not come from Claude Code
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"}  # names that lead back to this logger's ports
PROTOBUF_TYPES = ("application/x-protobuf", "application/protobuf")
ID_KEYS = ("traceId", "spanId", "parentSpanId")
INT_KEYS = ("intValue", "asInt")
RESOURCES = {"metrics": "resource_metrics", "logs": "resource_logs", "traces": "resource_spans"}
MB = 1024 * 1024
MAGIC = b"OTLP"
HEADER = struct.Struct(">4sII")  # marker, body length, CRC32 of the body
MAX_RECORD = 512 * MB  # a length above this is damage, not a record
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

MESSAGES = {
    400: "the body is not valid OTLP",
    404: "not found",
    413: "the request is too large",
    415: "send OTLP as application/x-protobuf or application/json (no other encodings)",
    500: "internal error",
}


class HttpError(Exception):
    def __init__(self, status):
        super().__init__(status)
        self.status = status


# ---- protobuf <-> JSON ----------------------------------------------------------------------------
# JSON is only used to read: `cat` shows records as the JSON Claude Code's own JSON exporter wrote (numbers,
# hex ids, integer enums, and a few fields spelled out as zero or empty, which protobuf cannot say).
# `convert` and requests that arrive as JSON go the other way.
_proto = None


def _load_proto():
    global _proto
    if _proto is None:
        from google.protobuf import json_format
        from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
        from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

        _proto = (
            json_format,
            {"metrics": ExportMetricsServiceRequest, "logs": ExportLogsServiceRequest, "traces": ExportTraceServiceRequest},
        )
    return _proto


def protobuf_available():
    try:
        _load_proto()
    except ImportError:
        return False
    return True


def parse_message(signal, payload):
    """OTLP protobuf bytes -> message. Raises ValueError if they are not valid."""
    message = _load_proto()[1][signal]()
    try:
        message.ParseFromString(payload)
    except Exception as err:  # google.protobuf.message.DecodeError
        raise ValueError("invalid protobuf") from err
    return message


def _as_json_style(node):
    """Ids as hex (protobuf JSON gives base64), 64-bit attribute values as numbers (it gives strings),
    and an empty arrayValue still carries its (empty) values list."""
    if isinstance(node, list):
        return [_as_json_style(x) for x in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for key, value in node.items():
        if key in ID_KEYS and isinstance(value, str):
            out[key] = base64.b64decode(value).hex()
        elif key in INT_KEYS and isinstance(value, str):
            out[key] = int(value)
        else:
            out[key] = _as_json_style(value)
    if isinstance(out.get("arrayValue"), dict):
        out["arrayValue"].setdefault("values", [])
    return out


def _resource_defaults(parent):
    resource = parent.get("resource")
    if isinstance(resource, dict):
        resource.setdefault("attributes", [])
        resource.setdefault("droppedAttributesCount", 0)


def _add_defaults(signal, data):
    if signal == "metrics":
        for rm in data.get("resourceMetrics", []):
            _resource_defaults(rm)
            for sm in rm.get("scopeMetrics", []):
                for metric in sm.get("metrics", []):
                    metric.setdefault("unit", "")
                    for kind in ("sum", "gauge", "histogram", "exponentialHistogram", "summary"):
                        if isinstance(metric.get(kind), dict):
                            for point in metric[kind].setdefault("dataPoints", []):
                                point.setdefault("attributes", [])
    elif signal == "logs":
        for rl in data.get("resourceLogs", []):
            _resource_defaults(rl)
            for sl in rl.get("scopeLogs", []):
                for record in sl.get("logRecords", []):
                    record.setdefault("attributes", [])
                    record.setdefault("droppedAttributesCount", 0)
    else:
        for rs in data.get("resourceSpans", []):
            _resource_defaults(rs)
            for ss in rs.get("scopeSpans", []):
                for span in ss.get("spans", []):
                    for key in ("droppedAttributesCount", "droppedEventsCount", "droppedLinksCount"):
                        span.setdefault(key, 0)
                    for key in ("attributes", "events", "links"):
                        span.setdefault(key, [])
                    if isinstance(span.get("status"), dict):
                        span["status"].setdefault("code", 0)
                    for item in span["events"] + span["links"]:
                        item.setdefault("attributes", [])
                        item.setdefault("droppedAttributesCount", 0)


def proto_to_json(signal, payload):
    """OTLP protobuf bytes -> the JSON dict `cat` prints. Raises ValueError if the bytes are not valid."""
    message = parse_message(signal, payload)
    data = _as_json_style(_load_proto()[0].MessageToDict(message, use_integers_for_enums=True))
    _add_defaults(signal, data)
    return data


def _hex_ids_to_b64(node):
    if isinstance(node, list):
        return [_hex_ids_to_b64(x) for x in node]
    if not isinstance(node, dict):
        return node
    return {
        k: (base64.urlsafe_b64encode(bytes.fromhex(v)).decode() if k in ID_KEYS and isinstance(v, str) else _hex_ids_to_b64(v))
        for k, v in node.items()
    }


def message_from_json(signal, data):
    """An OTLP JSON dict -> message. Raises ValueError if it is not valid OTLP."""
    json_format, classes = _load_proto()
    if not isinstance(data, dict):
        raise ValueError("invalid OTLP JSON")
    try:
        return json_format.ParseDict(_hex_ids_to_b64(data), classes[signal](), ignore_unknown_fields=True)
    except (json_format.ParseError, ValueError, TypeError, AttributeError) as err:
        raise ValueError("invalid OTLP JSON") from err


def json_to_proto(signal, data):
    """The inverse of proto_to_json: an OTLP JSON dict -> protobuf bytes."""
    return message_from_json(signal, data).SerializeToString()


def service_names(signal, message):
    """The service.name of every resource in a message, None for a resource without one."""
    names = []
    for item in getattr(message, RESOURCES[signal]):
        names.append(next((a.value.string_value for a in item.resource.attributes if a.key == "service.name"), None))
    return names


# ---- the file format --------------------------------------------------------------------------------
def to_text(ns):
    """Nanoseconds since the epoch -> the ISO text the JSON logs used (microsecond precision, UTC)."""
    seconds, rest = divmod(ns, 10**9)
    return (EPOCH + timedelta(seconds=seconds, microseconds=rest // 1000)).isoformat()


def to_ns(text):
    delta = datetime.fromisoformat(text) - EPOCH
    return (delta.days * 86400 + delta.seconds) * 10**9 + delta.microseconds * 1000


def _varint(number):
    out = bytearray()
    while True:
        byte = number & 0x7F
        number >>= 7
        out.append(byte | (0x80 if number else 0))
        if not number:
            return bytes(out)


def _read_varint(buf, pos):
    shift = result = 0
    while True:
        if pos >= len(buf):
            raise ValueError("truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def frame(received_ns, payload):
    """One record, ready to append: marker, length, CRC32 and a protobuf Record { fixed64 received_at = 1; bytes payload = 2 }."""
    body = b"\x09" + struct.pack("<Q", received_ns) + b"\x12" + _varint(len(payload)) + payload
    return HEADER.pack(MAGIC, len(body), zlib.crc32(body)) + body


def _unframe(body):
    """The Record inside a body -> (received_ns, payload). Raises ValueError if it is not one."""
    received = payload = None
    pos = 0
    while pos < len(body):
        tag, pos = _read_varint(body, pos)
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            value, pos = _read_varint(body, pos)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            if pos + size > len(body):
                raise ValueError("truncated field")
            value, pos = body[pos : pos + size], pos + size
        elif wire == 2:
            size, pos = _read_varint(body, pos)
            if pos + size > len(body):
                raise ValueError("truncated field")
            value, pos = body[pos : pos + size], pos + size
        else:
            raise ValueError("unsupported wire type")
        if field == 1 and wire == 1:
            received = struct.unpack("<Q", value)[0]
        elif field == 2 and wire == 2:
            payload = bytes(value)
    if received is None or payload is None:
        raise ValueError("incomplete record")
    return received, payload


def _record_at(data, pos, size):
    """(end, body) if an intact record starts at pos, else None."""
    if pos + HEADER.size > size:
        return None
    marker, length, crc = HEADER.unpack_from(data, pos)
    end = pos + HEADER.size + length
    if marker != MAGIC or length > MAX_RECORD or end > size:
        return None
    body = data[pos + HEADER.size : end]
    return (end, body) if zlib.crc32(body) == crc else None


def read_records(path, stats=None):
    """Yield (received_ns, payload) for every intact record in a .pblog file. A damaged stretch (a record cut
    short by a crash, a bad CRC, stray bytes) is skipped by looking for the next marker, and counted in
    stats["skipped"]. The file is only read."""
    stats = stats if stats is not None else {}
    stats.setdefault("skipped", 0)
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        if size == 0:
            return
        with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as data:
            pos, damaged = 0, False
            while pos < size:
                found = _record_at(data, pos, size)
                if found:
                    try:
                        item = _unframe(found[1])
                    except ValueError:
                        item = None
                    if item:
                        yield item
                        pos, damaged = found[0], False
                        continue
                if not damaged:  # one count per damaged stretch, however long
                    stats["skipped"] += 1
                    damaged = True
                pos = data.find(MAGIC, pos + 1)
                if pos < 0:
                    break


def signal_of(path):
    name = Path(path).name
    for signal in SIGNALS:
        if name == f"{signal}{EXT}":
            return signal
    raise SystemExit(f"cannot tell the signal from the file name '{name}': use --signal metrics, logs or traces")


# ---- commands: cat and convert ---------------------------------------------------------------------
def cat(paths, out, signal=None):
    """Print each record as {"received_at", "data"}, one JSON line. Returns how many damaged records were skipped."""
    skipped = 0
    for path in paths:
        kind = signal or signal_of(path)
        stats = {}
        for ns, payload in read_records(path, stats):
            try:
                data = proto_to_json(kind, payload)
            except ValueError:
                stats["skipped"] += 1
                continue
            out.write(json.dumps({"received_at": to_text(ns), "data": data}, ensure_ascii=False) + "\n")
        skipped += stats["skipped"]
    return skipped


def convert(source, destination, dry_run=False, out=sys.stdout):
    """Turn the old metrics/logs/traces .jsonl files in `source` into .pblog files in `destination`.

    Every record is converted and decoded back, and must come out exactly as it went in (data and timestamp);
    if even one does not, nothing is written. The source is only read. The destination files are created
    exclusively, so existing files are never overwritten. Returns 0 on success."""
    source, destination = Path(source), Path(destination)
    plan = [(s, source / f"{s}{LEGACY_EXT}", destination / f"{s}{EXT}") for s in SIGNALS if (source / f"{s}{LEGACY_EXT}").exists()]
    if not plan:
        print(f"no metrics, logs or traces {LEGACY_EXT} files in {source}", file=sys.stderr)
        return 2
    clashes = [str(dst) for _, _, dst in plan if dst.exists()]
    if clashes and not dry_run:
        print("refusing to overwrite: " + ", ".join(clashes), file=sys.stderr)
        return 2

    converted, failed = [], False
    for kind, src, dst in plan:
        frames, unreadable, differing, first_bad = [], 0, 0, None
        with open(src, "rb") as f:
            for number, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                    data, text = record["data"], record["received_at"]
                    ns = to_ns(text)
                except (ValueError, KeyError, TypeError):
                    unreadable += 1
                    continue
                try:
                    payload = json_to_proto(kind, data)
                    same = proto_to_json(kind, payload) == data and to_text(ns) == text
                except ValueError:
                    same = False
                if same:
                    frames.append(frame(ns, payload))
                else:
                    differing += 1
                    first_bad = first_bad or number
        out.write(
            f"{src.name}: {len(frames)} records ok, {unreadable} unreadable line(s) left behind, {differing} would not survive"
            + (f" (first at line {first_bad})" if first_bad else "")
            + f"; {src.stat().st_size / MB:.1f} MB -> {sum(map(len, frames)) / MB:.1f} MB\n"
        )
        failed = failed or differing > 0
        converted.append((dst, frames))

    if failed:
        print("not converted: some records would change. Nothing was written.", file=sys.stderr)
        return 1
    if dry_run:
        out.write("dry run: every record converts exactly. Nothing was written.\n")
        return 0
    destination.mkdir(parents=True, exist_ok=True)
    for dst, frames in converted:
        with open(dst, "xb") as f:  # exclusive create: never overwrites
            for item in frames:
                f.write(item)
    out.write(f"written to {destination}. The source files were not touched.\n")
    return 0


# ---- forwarding (optional) ------------------------------------------------------------------------
class Forwarder:
    """Re-sends each request, as OTLP protobuf, to another OTLP/HTTP endpoint. It runs on its own thread and
    keeps a bounded queue, so a slow or absent receiver never delays or fails the logging."""

    def __init__(self, base_url, headers=None, max_bytes=64 * MB, send=None, sleep=time.sleep, attempts=6):
        self.base_url = base_url.rstrip("/")
        self.headers = {"Content-Type": "application/x-protobuf", **(headers or {})}
        self.max_bytes = max_bytes
        self.send = send or self._post
        self.sleep = sleep
        self.attempts = attempts
        self.dropped = 0
        self.sent = 0
        self._queue = deque()
        self._queued_bytes = 0
        self._wake = threading.Condition()
        self._last_note = {}

    def start(self):
        threading.Thread(target=self._run, daemon=True, name="forwarder").start()

    def submit(self, signal, payload):
        with self._wake:
            while self._queue and self._queued_bytes + len(payload) > self.max_bytes:
                _, old = self._queue.popleft()
                self._queued_bytes -= len(old)
                self.dropped += 1
                self._note("queue-full", "forward queue is full: dropping the oldest request")
            self._queue.append((signal, payload))
            self._queued_bytes += len(payload)
            self._wake.notify()

    def _post(self, url, payload):
        request = urllib.request.Request(url, data=payload, headers=self.headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status
        except urllib.error.HTTPError as err:
            return err.code

    def _note(self, kind, text):
        now = time.monotonic()
        if now - self._last_note.get(kind, -1e9) >= 60:  # at most one line a minute per kind: no log flood
            self._last_note[kind] = now
            print(f"forward: {text}", file=sys.stderr, flush=True)

    def deliver(self, signal, payload):
        """One request: retried on connection errors, 429 and 5xx; dropped on other errors. True if delivered."""
        url = f"{self.base_url}/v1/{signal}"
        for attempt in range(self.attempts):
            try:
                status = self.send(url, payload)
            except Exception as err:  # connection refused, timeout, DNS ...
                self._note("connect", f"cannot reach the receiver ({type(err).__name__}); will retry")
            else:
                if 200 <= status < 300:
                    self.sent += 1
                    return True
                if status != 429 and status < 500:
                    self.dropped += 1
                    self._note(f"http-{status}", f"the receiver answered {status} for /v1/{signal}; request dropped")
                    return False
                self._note(f"http-{status}", f"the receiver answered {status}; will retry")
            if attempt < self.attempts - 1:
                self.sleep(min(60, 2**attempt))
        self.dropped += 1
        return False

    def _run(self):
        while True:
            with self._wake:
                while not self._queue:
                    self._wake.wait()
                signal, payload = self._queue.popleft()
                self._queued_bytes -= len(payload)
            self.deliver(signal, payload)


def parse_headers(text):
    pairs = (item.split("=", 1) for item in (text or "").split(",") if "=" in item)
    return {name.strip(): value.strip() for name, value in pairs if name.strip()}


# ---- the logger -----------------------------------------------------------------------------------
def names_set(text):
    return {s for s in (x.strip() for x in text.split(",")) if s}


class Response:
    def __init__(self, status, body=b"{}", content_type="application/json"):
        self.status, self.body, self.content_type = status, body, content_type


def error_response(status):
    return Response(status, json.dumps({"error": MESSAGES.get(status, "error")}).encode())


class Listener(NamedTuple):
    name: str
    port: int
    protocol: str  # any | protobuf | json
    directory: Path


def parse_listeners(text, log_dir):
    """OTEL_LOGGER_LISTEN: NAME:PORT[:PROTOCOL[:DIR]], separated by commas or new lines. Raises ValueError."""
    listeners, ports = [], set()
    for entry in (e.strip() for e in re.split(r"[,\n]", text or "")):
        if not entry:
            continue
        name, port_text, protocol, directory = ([f.strip() for f in entry.split(":", 3)] + ["", "", ""])[:4]
        if not port_text:
            raise ValueError(f"'{entry}' is not NAME:PORT[:PROTOCOL[:DIR]]")
        if not re.fullmatch(r"[a-z0-9_-]+", name) or name == UNMATCHED:
            raise ValueError(f"'{name}' is not a usable name (letters, digits, - and _; '{UNMATCHED}' is reserved)")
        if not port_text.isdigit() or not 0 < int(port_text) < 65536:
            raise ValueError(f"'{port_text}' is not a port (1-65535) in '{name}'")
        if protocol.lower() not in PROTOCOLS and protocol:
            raise ValueError(f"'{protocol}' is not a protocol for '{name}' (any, protobuf or json)")
        if ":" in directory:  # NAME:PORT:PROTOCOL:DIR has no more fields, so this is two entries run together
            raise ValueError(f"'{directory}' in '{name}' is not a folder: is a comma missing between two listeners?")
        port = int(port_text)
        if port in ports:
            raise ValueError(f"port {port} is listed twice")
        ports.add(port)
        where = Path(directory) if directory else Path(name)
        listeners.append(Listener(name, port, PROTOCOLS.get(protocol.lower(), "any"), Path(log_dir) / where))
    if not listeners:
        raise ValueError("no listeners")
    return listeners


class Logger:
    """What one listener does with a request. Several share the log dir (and the lock, and the forwarder)."""

    def __init__(self, log_dir, source="claude", protocol="any", directory=None, max_body=64 * MB, forwarder=None,
                 claude_services=DEFAULT_CLAUDE_SERVICES, clock=time.time_ns, lock=None, claude_directory=None):
        self.log_dir = Path(log_dir)  # the root: where other/ goes
        self.source = source
        self.protocol = protocol
        self.directory = Path(directory) if directory else self.log_dir / source
        self.claude_directory = Path(claude_directory) if claude_directory else None  # where Claude Code data on another port goes
        self.max_body = max_body
        self.forwarder = forwarder
        self.claude_services = names_set(claude_services)
        self.clock = clock
        self._lock = lock or threading.Lock()

    def route(self, path):
        """.../v1/<signal> -> (signal, file). Any prefix before /v1 is ignored: the port says whose data this is."""
        parts = [p for p in path.split("?")[0].split("/") if p]
        if len(parts) < 2 or parts[-2] != "v1" or parts[-1] not in SIGNALS:
            return None
        return parts[-1], self.directory / f"{parts[-1]}{EXT}"

    def unpack(self, headers, body):
        """Undo gzip, refusing anything that would exceed the size limit once unpacked."""
        encoding = headers.get("content-encoding", "").strip().lower()
        if encoding in ("", "identity"):
            return body
        if encoding != "gzip":
            raise HttpError(415)
        unpacker = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            out = unpacker.decompress(body, self.max_body + 1)
        except zlib.error as err:
            raise HttpError(400) from err
        if len(out) > self.max_body or unpacker.unconsumed_tail:
            raise HttpError(413)
        return out

    def handle_post(self, path, headers, body):
        """Everything except the sockets: returns a Response. Kept separate so it can be tested directly."""
        target = self.route(path)
        if target is None:
            return error_response(404)
        signal, file = target
        headers = {k.lower(): v for k, v in headers.items()}
        try:
            body = self.unpack(headers, body)
            is_protobuf = headers.get("content-type", "").split(";")[0].strip().lower() in PROTOBUF_TYPES
            if self.protocol != "any" and is_protobuf != (self.protocol == "protobuf"):
                raise HttpError(415)  # this port takes the other format only
            if is_protobuf:
                payload = body  # kept exactly as the tool sent it
                message = parse_message(signal, payload)
                reply = Response(200, b"", "application/x-protobuf")  # an empty Export*Response
            else:
                try:
                    data = json.loads(body)
                except ValueError as err:  # not JSON: check the tool is set to protobuf or json
                    raise HttpError(415) from err
                message = message_from_json(signal, data)
                payload = message.SerializeToString()  # converted once, here
                reply = Response(200)
        except HttpError as err:
            return error_response(err.status)
        except ValueError:
            return error_response(400)

        if self.source == "claude":
            if not self.is_claude(signal, message):
                file = self.log_dir / UNMATCHED / f"{signal}{EXT}"  # still logged, just not among the Claude Code files
        elif self.claude_directory is not None and self.is_claude(signal, message):
            file = self.claude_directory / f"{signal}{EXT}"  # Claude Code on the wrong port: its data belongs with Claude Code's
        self.append(file, payload)
        if self.forwarder is not None:
            self.forwarder.submit(signal, payload)
        return reply

    def is_claude(self, signal, message):
        """True only if every resource in the request says it is Claude Code."""
        names = service_names(signal, message)
        return bool(names) and all(name in self.claude_services for name in names)

    def append(self, file, payload):
        record = frame(self.clock(), payload)
        with self._lock:
            file.parent.mkdir(parents=True, exist_ok=True)
            with open(file, "ab") as f:  # append only: the one way a log file is ever opened for writing
                f.write(record)


# ---- HTTP ------------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    logger = None  # set per listener in serve()
    timeout = 30  # a stalled client must not hold a thread for ever

    def do_POST(self):
        try:
            body = self._read_body(self.logger.max_body)
            response = self.logger.handle_post(self.path, self.headers, body)
        except HttpError as err:
            response = error_response(err.status)
        except Exception as err:  # never echo the request: say what kind of failure it was
            print(f"error: {type(err).__name__} while handling {self.path.split('?')[0]}", file=sys.stderr, flush=True)
            response = error_response(500)
        self._reply(response)

    def do_GET(self):
        if self.path.split("?")[0] == "/healthz":
            return self._reply(Response(200, b"ok", "text/plain"))
        self._reply(error_response(404))

    def _read_body(self, limit):
        """The request body. Raises HttpError(413) if it is bigger than the limit, 400 if the framing is broken."""
        try:
            if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
                chunks, total = [], 0
                while True:
                    size = int(self.rfile.readline().split(b";")[0].strip(), 16)
                    if size == 0:
                        while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                            pass  # skip trailers
                        return b"".join(chunks)
                    total += size
                    if total > limit:
                        raise HttpError(413)
                    chunks.append(self.rfile.read(size))
                    self.rfile.readline()  # CRLF after each chunk
            length = int(self.headers.get("Content-Length", 0))
        except ValueError as err:
            raise HttpError(400) from err
        if length > limit:
            raise HttpError(413)
        return self.rfile.read(length)

    def _reply(self, response):
        self.send_response(response.status)
        self.send_header("Content-Type", response.content_type)
        self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        self.wfile.write(response.body)

    def log_message(self, *args):
        pass  # stay quiet: request lines would only repeat what the files hold


def configured_listeners():
    log_dir = Path(os.environ.get("OTEL_LOGGER_DIR", str(Path.home() / "otelscope")))
    try:
        return log_dir, parse_listeners(os.environ.get("OTEL_LOGGER_LISTEN") or DEFAULT_LISTEN, log_dir)
    except ValueError as err:
        sys.exit(f"OTEL_LOGGER_LISTEN: {err}")


def serve():
    host = os.environ.get("OTEL_LOGGER_HOST", "127.0.0.1")
    log_dir, listeners = configured_listeners()
    max_body = int(float(os.environ.get("OTEL_LOGGER_MAX_BODY_MB", "64")) * MB)
    claude_services = os.environ.get("OTEL_LOGGER_CLAUDE_SERVICES", DEFAULT_CLAUDE_SERVICES)

    forwarder, forward_note = None, ""
    forward_url = os.environ.get("OTEL_LOGGER_FORWARD_URL")
    if forward_url:
        where = urlsplit(forward_url)
        if where.hostname in LOCAL_HOSTS and where.port in {item.port for item in listeners}:
            sys.exit(f"OTEL_LOGGER_FORWARD_URL: {where.hostname}:{where.port} is one of this logger's own ports, so every "
                     "copy would be logged and sent on again, forever. Forward to another port.")
        queue_mb = float(os.environ.get("OTEL_LOGGER_FORWARD_QUEUE_MB", "64"))
        forwarder = Forwarder(forward_url, parse_headers(os.environ.get("OTEL_LOGGER_FORWARD_HEADERS")), int(queue_mb * MB))
        forwarder.start()
        forward_note = f"; forwarding to {where.scheme}://{where.hostname}{':' + str(where.port) if where.port else ''}"

    log_dir.mkdir(parents=True, exist_ok=True)
    lock = threading.Lock()  # one lock for every port: two ports may share a folder
    claude_dir = next((item.directory for item in listeners if item.name == "claude"), None)
    servers = []
    for item in listeners:  # bind them all first, so a port that is taken stops the start instead of half of it
        logger = Logger(log_dir, item.name, item.protocol, item.directory, max_body, forwarder, claude_services, lock=lock,
                        claude_directory=claude_dir)
        handler = type(f"Handler_{item.name}", (Handler,), {"logger": logger})
        try:
            servers.append((item, ThreadingHTTPServer((host, item.port), handler)))
        except OSError as err:
            sys.exit(f"cannot listen on {host}:{item.port} for {item.name}: {err.strerror or err}")
    for item, server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"{item.name}: http://{host}:{item.port} ({item.protocol}) -> {item.directory}", flush=True)
    if forward_note:
        print(f"also {forward_note.lstrip('; ')}", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    return 0


def show_listeners():
    """One line per listener: name, port, protocol, folder. For scripts (the container's entry point) and for checking a setting."""
    for item in configured_listeners()[1]:
        print(item.name, item.port, item.protocol, item.directory, sep="\t")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="otel-logger.py", description="Log OpenTelemetry data from AI coding tools.")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("serve", help="receive OTLP and append it to the log folder (the default)")
    commands.add_parser("listeners", help="print the listeners OTEL_LOGGER_LISTEN describes")
    cat_parser = commands.add_parser("cat", help="print records as JSON lines, for jq")
    cat_parser.add_argument("files", nargs="+", metavar="FILE", help="a metrics/logs/traces .pblog file")
    cat_parser.add_argument("--signal", choices=SIGNALS, help="needed only if the file is not named metrics/logs/traces.pblog")
    convert_parser = commands.add_parser("convert", help="turn old .jsonl logs into .pblog files")
    convert_parser.add_argument("source", metavar="SRC", help="folder with metrics.jsonl, logs.jsonl, traces.jsonl (only read)")
    convert_parser.add_argument("destination", metavar="DST", help="folder for the .pblog files (existing files are never overwritten)")
    convert_parser.add_argument("--dry-run", action="store_true", help="check that every record converts exactly; write nothing")
    args = parser.parse_args(argv)

    if not protobuf_available():
        sys.exit("this needs the protobuf libraries: pip install -r requirements.txt")
    command = args.command or "serve"
    if command == "serve":
        return serve()
    if command == "listeners":
        return show_listeners()
    if command == "cat":
        if hasattr(posix_signal, "SIGPIPE"):
            posix_signal.signal(posix_signal.SIGPIPE, posix_signal.SIG_DFL)  # `| head` ends quietly, like cat
        sys.stdout.reconfigure(encoding="utf-8")
        skipped = cat(args.files, sys.stdout, args.signal)
        if skipped:
            print(f"skipped {skipped} damaged record(s)", file=sys.stderr)
        return 0
    return convert(args.source, args.destination, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
