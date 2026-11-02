"""
Tests for otel-logger.py. Synthetic data only: no real prompts, no sockets (the request handling is a plain
function, so it is tested directly).

    python3 -m unittest discover -s tests -p "test_*.py"

Needs the protobuf libraries (pip install -r requirements.txt).
"""
import ast
import contextlib
import gzip
import hashlib
import importlib.util
import io
import itertools
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from unittest import mock
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The file name has a hyphen, so it cannot be imported by name: load it by path.
spec = importlib.util.spec_from_file_location("otel_logger", ROOT / "otel-logger.py")
L = importlib.util.module_from_spec(spec)
sys.modules["otel_logger"] = L
spec.loader.exec_module(L)

PROTO = {"Content-Type": "application/x-protobuf"}
JSON = {"Content-Type": "application/json"}

TRACE = "0af7651916cd43dd8448eb211c80319c"
SPAN1, SPAN2 = "b7ad6b7169203331", "00f067aa0ba902b7"
SENTINEL = "SENTINEL-PROMPT-7f3a"


def attr(key, **value):
    return {"key": key, "value": value}


RESOURCE = {
    "attributes": [attr("service.name", stringValue="claude-code"), attr("service.version", stringValue="2.1.0")],
    "droppedAttributesCount": 0,
}
SCOPE = {"name": "com.anthropic.claude_code", "version": "2.1.0"}

# The shape Claude Code's own JSON exporter writes.
METRICS = {"resourceMetrics": [{"resource": RESOURCE, "scopeMetrics": [{"scope": SCOPE, "metrics": [
    {"name": "claude_code.token.usage", "description": "Number of tokens used", "unit": "tokens", "sum": {
        "dataPoints": [{"attributes": [
            attr("type", stringValue="input"), attr("count", intValue=3), attr("big", intValue=9007199254740993),
            attr("ok", boolValue=True), attr("ratio", doubleValue=0.5), attr("empty", arrayValue={"values": []}),
            attr("tags", arrayValue={"values": [{"stringValue": "a"}]}),
        ], "startTimeUnixNano": "1760000000000000000", "timeUnixNano": "1760000060000000000", "asDouble": 12.0}],
        "aggregationTemporality": 1, "isMonotonic": True}},
    {"name": "claude_code.session.count", "description": "Sessions started", "unit": "", "sum": {
        "dataPoints": [{"attributes": [], "startTimeUnixNano": "1760000000000000000",
                        "timeUnixNano": "1760000060000000000", "asDouble": 1.0}],
        "aggregationTemporality": 1, "isMonotonic": True}},
]}]}]}

LOGS = {"resourceLogs": [{"resource": RESOURCE, "scopeLogs": [{"scope": SCOPE, "logRecords": [
    {"timeUnixNano": "1760000001000000000", "observedTimeUnixNano": "1760000001000000000",
     "body": {"stringValue": "claude_code.user_prompt"},
     "attributes": [attr("prompt", stringValue="héllo ✓"), attr("session.id", stringValue="s-1")],
     "droppedAttributesCount": 0},
    {"timeUnixNano": "1760000002000000000", "observedTimeUnixNano": "1760000002000000000",
     "body": {"stringValue": "claude_code.api_request"}, "attributes": [attr("duration_ms", stringValue="12")],
     "droppedAttributesCount": 0, "traceId": TRACE, "spanId": SPAN1},
]}]}]}

TRACES = {"resourceSpans": [{"resource": RESOURCE, "scopeSpans": [{"scope": SCOPE, "spans": [
    {"traceId": TRACE, "spanId": SPAN1, "name": "claude_code.interaction", "kind": 1,
     "startTimeUnixNano": "1760000000000000000", "endTimeUnixNano": "1760000005000000000",
     "attributes": [attr("session.id", stringValue="s-1")], "droppedAttributesCount": 0,
     "events": [{"timeUnixNano": "1760000001000000000", "name": "tool.output",
                 "attributes": [attr("content", stringValue="out")], "droppedAttributesCount": 0}],
     "droppedEventsCount": 0, "links": [], "droppedLinksCount": 0, "status": {"code": 0}, "flags": 257},
    {"traceId": TRACE, "spanId": SPAN2, "parentSpanId": SPAN1, "name": "claude_code.tool", "kind": 3,
     "startTimeUnixNano": "1760000001000000000", "endTimeUnixNano": "1760000002000000000",
     "attributes": [], "droppedAttributesCount": 0, "events": [], "droppedEventsCount": 0,
     "links": [{"traceId": TRACE, "spanId": SPAN1, "attributes": [], "droppedAttributesCount": 0}],
     "droppedLinksCount": 0, "status": {"code": 2, "message": "boom"}, "flags": 257},
]}]}]}

FIXTURES = {"metrics": METRICS, "logs": LOGS, "traces": TRACES}
START_NS = 1_760_000_000_123_456_000  # the fake clock starts here and ticks 1 ms per record


def stored(path):
    """What `cat` would print for a .pblog file: [(received_at text, data)]."""
    kind = Path(path).stem
    return [(L.to_text(ns), L.proto_to_json(kind, payload)) for ns, payload in L.read_records(path)]


def datas(path):
    return [data for _, data in stored(path)]


def payloads(path):
    return [payload for _, payload in L.read_records(path)]


def as_service(fixture, name):
    return json.loads(json.dumps(fixture).replace('"stringValue": "claude-code"', f'"stringValue": {json.dumps(name)}'))


class LoggerCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.ticks = itertools.count(START_NS, 1_000_000)
        self.log = self.tool("claude")

    def tool(self, name, **options):
        """The listener of one tool, writing into the shared log folder."""
        return L.Logger(self.dir, name, clock=lambda: next(self.ticks), **options)

    def post_json(self, path, data, headers=None):
        return self.log.handle_post(path, {**JSON, **(headers or {})}, json.dumps(data).encode())

    def post_proto(self, path, signal, data, headers=None):
        return self.log.handle_post(path, {**PROTO, **(headers or {})}, L.json_to_proto(signal, data))

    def file(self, tool, signal):
        return self.dir / tool / f"{signal}.pblog"


class RoutingTests(LoggerCase):
    """The port decides the tool, so a listener only has to find the signal in the path."""

    def test_a_listener_writes_into_the_folder_of_its_tool(self):
        for signal in L.SIGNALS:
            self.assertEqual(self.log.route(f"/v1/{signal}")[1], self.file("claude", signal))
            self.assertEqual(self.tool("vscode").route(f"/v1/{signal}")[1], self.file("vscode", signal))
        self.assertEqual(self.log.route("/v1/logs/?x=1")[1], self.file("claude", "logs"))  # trailing slash and query are fine

    def test_a_path_prefix_is_ignored_so_older_settings_keep_working(self):
        self.assertEqual(self.tool("vscode").route("/vscode/v1/traces")[1], self.file("vscode", "traces"))
        self.assertEqual(self.tool("vscode").route("/codex/v1/traces")[1], self.file("vscode", "traces"))  # the port decides, not the path

    def test_anything_else_is_not_routed(self):
        for path in ("/", "/v1", "/v1/other", "/v2/logs", "/codex/v1", "/v1/logs/extra", "/logs"):
            self.assertIsNone(self.log.route(path), path)

    def test_a_folder_of_its_own_can_be_chosen(self):
        elsewhere = self.dir / "elsewhere" / "deep"
        log = L.Logger(self.dir, "vscode", directory=elsewhere)
        self.assertEqual(log.route("/v1/logs")[1], elsewhere / "logs.pblog")
        self.assertEqual(log.handle_post("/v1/logs", JSON, json.dumps(LOGS).encode()).status, 200)
        self.assertEqual(datas(elsewhere / "logs.pblog"), [LOGS])
        self.assertFalse((self.dir / "vscode").exists())

    def test_two_listeners_keep_their_data_apart(self):
        self.tool("vscode").handle_post("/v1/logs", JSON, json.dumps(as_service(LOGS, "copilot-chat")).encode())
        self.log.handle_post("/v1/logs", JSON, json.dumps(LOGS).encode())
        self.assertEqual(len(payloads(self.file("vscode", "logs"))), 1)
        self.assertEqual(len(payloads(self.file("claude", "logs"))), 1)

    def test_unknown_route_answers_404_and_writes_nothing(self):
        self.assertEqual(self.post_json("/v1/nope", LOGS).status, 404)
        self.assertEqual(list(self.dir.iterdir()), [])


class ClaudeOnAnotherPortTests(LoggerCase):
    """A Claude Code session still set to another tool's port must not leave its data among that tool's files."""

    def other_port(self, claude_directory):
        return self.tool("vscode", claude_directory=claude_directory)

    def test_claude_code_data_goes_to_the_claude_folder_not_the_tools(self):
        log = self.other_port(self.dir / "claude")
        for name in ("claude-code", "claude-code-desktop"):
            self.assertEqual(log.handle_post("/v1/logs", JSON, json.dumps(as_service(LOGS, name)).encode()).status, 200)
        self.assertEqual(log.handle_post("/v1/logs", PROTO, L.json_to_proto("logs", LOGS)).status, 200)
        self.assertEqual(len(payloads(self.file("claude", "logs"))), 3)
        self.assertFalse(self.file("vscode", "logs").exists())

    def test_the_claude_folder_can_be_somewhere_else(self):
        elsewhere = self.dir / "elsewhere"
        self.other_port(elsewhere).handle_post("/v1/logs", JSON, json.dumps(LOGS).encode())
        self.assertEqual(len(payloads(elsewhere / "logs.pblog")), 1)
        self.assertFalse((self.dir / "claude").exists())

    def test_the_tools_own_data_stays_and_so_does_a_mixed_request(self):
        log = self.other_port(self.dir / "claude")
        log.handle_post("/v1/logs", JSON, json.dumps(as_service(LOGS, "copilot-chat")).encode())
        mixed = json.loads(json.dumps(LOGS))
        mixed["resourceLogs"].append(as_service(LOGS, "copilot-chat")["resourceLogs"][0])
        log.handle_post("/v1/logs", JSON, json.dumps(mixed).encode())  # one non-Claude resource: not wholly Claude's
        self.assertEqual(len(payloads(self.file("vscode", "logs"))), 2)
        self.assertFalse(self.file("claude", "logs").exists())

    def test_without_a_claude_listener_nothing_is_moved(self):
        self.tool("vscode").handle_post("/v1/logs", JSON, json.dumps(LOGS).encode())
        self.assertEqual(len(payloads(self.file("vscode", "logs"))), 1)


class ListenerSettingTests(unittest.TestCase):
    def parse(self, text):
        return L.parse_listeners(text, "/root")

    def test_name_port_protocol_and_folder(self):
        got = self.parse("claude:4318, vscode:5080:protobuf ,codex:4320:json:/data/codex\n gem:4321::sub/dir")
        self.assertEqual([(g.name, g.port, g.protocol, str(g.directory)) for g in got], [
            ("claude", 4318, "any", "/root/claude"),
            ("vscode", 5080, "protobuf", "/root/vscode"),
            ("codex", 4320, "json", "/data/codex"),  # an absolute folder is used as it is
            ("gem", 4321, "any", "/root/sub/dir"),  # a relative one is under the log folder; an empty protocol means any
        ])

    def test_otel_protocol_names_work_too(self):
        got = self.parse("a:1:http/protobuf,b:2:HTTP/JSON,c:3:Any")
        self.assertEqual([g.protocol for g in got], ["protobuf", "json", "any"])

    def test_mistakes_are_refused_with_a_reason(self):
        for text, why in (("", "no listeners"), ("claude", "NAME:PORT"), ("claude:x", "not a port"), ("claude:0", "not a port"),
                          ("claude:70000", "not a port"), ("Bad Name:1", "usable name"), ("../x:1", "usable name"),
                          ("other:1", "reserved"), ("a:1:grpc", "protocol"), ("a:1,b:1", "port 1 is listed twice"),
                          ("a:1,a:2", "name 'a' is listed twice"),  # a pasted entry whose name was not changed
                          ("a:1,b:2::x,c:3::x", "used by two listeners"), ("a:1,b:2::a", "used by two listeners"),
                          ("a:1:any:, b:2:any: c:3:any:", "comma missing")):
            with self.assertRaisesRegex(ValueError, why, msg=text):
                self.parse(text)


class ServeTests(LoggerCase):
    """serve() with the sockets replaced, so only the wiring is under test: one server per listener, each with its own logger."""

    class FakeServer:
        made, started, refuse = [], [], set()

        def __init__(self, address, handler):
            if address[1] in self.refuse:
                raise OSError(98, "Address already in use")
            self.address, self.handler = address, handler
            self.made.append(self)

        def serve_forever(self):
            self.started.append(self)

    class Interrupted:
        def wait(self):
            raise KeyboardInterrupt

    class InlineThread:  # runs the target at start(), so serve_forever is recorded without a thread
        def __init__(self, target, daemon=None):
            self.target = target

        def start(self):
            self.target()

    def serve(self, listen, refuse=()):
        fake = self.FakeServer
        fake.made, fake.started, fake.refuse = [], [], set(refuse)
        env = {"OTEL_LOGGER_LISTEN": listen, "OTEL_LOGGER_DIR": str(self.dir), "OTEL_LOGGER_HOST": "0.0.0.0"}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), mock.patch.object(L, "ThreadingHTTPServer", fake), \
                mock.patch.object(L.threading, "Event", self.Interrupted), mock.patch.object(L.threading, "Thread", self.InlineThread), contextlib.redirect_stdout(out):
            L.serve()
        return fake.made, out.getvalue()

    def test_every_listener_gets_its_own_port_tool_protocol_and_folder(self):
        made, out = self.serve("claude:4318, vscode:5080:protobuf, codex:4320:json:/elsewhere")
        self.assertEqual([m.address for m in made], [("0.0.0.0", 4318), ("0.0.0.0", 5080), ("0.0.0.0", 4320)])
        got = [(m.handler.logger.source, m.handler.logger.protocol, m.handler.logger.directory) for m in made]
        self.assertEqual(got, [("claude", "any", self.dir / "claude"), ("vscode", "protobuf", self.dir / "vscode"),
                               ("codex", "json", Path("/elsewhere"))])
        self.assertEqual(len({id(m.handler.logger._lock) for m in made}), 1)  # one lock for all
        self.assertIn("vscode: http://0.0.0.0:5080 (protobuf)", out)

    def test_serve_hands_every_other_listener_the_claude_folder(self):
        made, _ = self.serve( "claude:4318:any:/c, vscode:5080")
        self.assertEqual([m.handler.logger.claude_directory for m in made], [Path("/c"), Path("/c")])
        made, _ = self.serve( "vscode:5080")
        self.assertIsNone(made[0].handler.logger.claude_directory)

    def test_a_port_that_is_taken_stops_the_start_before_anything_listens(self):
        fake = self.FakeServer
        with self.assertRaises(SystemExit) as stop:
            self.serve("claude:4318,vscode:5080", refuse={5080})
        self.assertIn("5080", str(stop.exception))
        self.assertEqual(fake.started, [])

    def test_forwarding_to_one_of_its_own_ports_is_refused_before_anything_listens(self):
        fake = self.FakeServer
        for url in ("http://host.docker.internal:5080", "http://127.0.0.1:5080/v1", "http://localhost:4318/"):
            with mock.patch.dict(os.environ, {"OTEL_LOGGER_FORWARD_URL": url}), mock.patch.object(L, "Forwarder"), \
                    self.assertRaisesRegex(SystemExit, "OTEL_LOGGER_FORWARD_URL: .*own ports", msg=url):
                self.serve("claude:4318,vscode:5080")
            self.assertEqual(fake.made, [], url)

    def test_forwarding_to_the_same_port_number_on_another_machine_or_to_a_free_port_is_fine(self):
        for url in ("http://collector.example.com:4318", "http://host.docker.internal:5080", "http://collector.example.com"):
            with mock.patch.dict(os.environ, {"OTEL_LOGGER_FORWARD_URL": url}), mock.patch.object(L, "Forwarder") as forwarder:
                made, out = self.serve("claude:4318,vscode:4316")
            self.assertEqual(len(made), 2, url)
            forwarder.assert_called_once()
            self.assertIn("also forwarding to http://" + url.split("//")[1].split("/")[0], out)

    def test_a_bad_setting_is_refused_by_name(self):
        with self.assertRaisesRegex(SystemExit, "OTEL_LOGGER_LISTEN: .*not a port"):
            self.serve("claude:http")

    def test_the_listeners_command_prints_what_serve_would_use(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"OTEL_LOGGER_LISTEN": "claude:4318,vscode:5080:json", "OTEL_LOGGER_DIR": "/d"}), \
                contextlib.redirect_stdout(out):
            self.assertEqual(L.main(["listeners"]), 0)
        self.assertEqual(out.getvalue(), "claude\t4318\tany\t/d/claude\nvscode\t5080\tjson\t/d/vscode\n")

    def test_without_a_setting_it_listens_for_claude_on_4318(self):
        env = {k: v for k, v in os.environ.items() if k != "OTEL_LOGGER_LISTEN"}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(out):
            os.environ["OTEL_LOGGER_DIR"] = "/d"
            L.main(["listeners"])
        self.assertEqual(out.getvalue(), "claude\t4318\tany\t/d/claude\n")


# The logger's entry point: next to this file in the repository, installed as entrypoint.sh in the logger image. In the
# site image that name is the site's own entry point, which has no is_mounted(), so only a script that defines it counts.
ENTRYPOINT = next((p for p in (ROOT / "docker" / "logger-entrypoint.sh", Path("/usr/local/bin/entrypoint.sh"))
                   if p.is_file() and "is_mounted()" in p.read_text()), None)


@unittest.skipUnless(ENTRYPOINT and shutil.which("bash") and shutil.which("python3"), "the entry point script, bash or python3 is not here")
class MountCheckTests(unittest.TestCase):
    """The entry point's is_mounted(), run against a fake /proc/self/mountinfo that has just one mount."""

    def test_only_what_is_really_inside_the_mount_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()  # as the check sees it: tmp may itself be behind a symlink
            mounted, elsewhere = root / "mounted", root / "elsewhere"
            mounted.mkdir()
            elsewhere.mkdir()
            (mounted / "link").symlink_to(elsewhere)
            info = root / "mountinfo"
            info.write_text(f"1 0 0:1 / {mounted} rw - ext4 /dev/x rw\n")

            def is_mounted(folder):
                script = 'eval "$(sed -n "/^is_mounted()/,/^}/p" "$0")"; is_mounted "$1"'
                return subprocess.run(["bash", "-c", script, str(ENTRYPOINT), str(folder)], env={**os.environ, "MOUNTINFO": str(info)}).returncode == 0

            for folder in (mounted, mounted / "claude", mounted / "a" / "b", mounted / "sub" / ".." / "claude"):
                self.assertTrue(is_mounted(folder), folder)
            for folder in (elsewhere, mounted / ".." / "elsewhere", mounted / ".." / ".." / "x", mounted / "link", mounted / "link" / "claude"):
                self.assertFalse(is_mounted(folder), folder)  # outside it, however it is written


class ProtocolTests(LoggerCase):
    def test_a_protobuf_port_refuses_json_and_the_other_way_round(self):
        for protocol, refused, accepted in (("protobuf", JSON, PROTO), ("json", PROTO, JSON)):
            log = self.tool(protocol, protocol=protocol)
            body = {JSON["Content-Type"]: json.dumps(LOGS).encode(), PROTO["Content-Type"]: L.json_to_proto("logs", LOGS)}
            self.assertEqual(log.handle_post("/v1/logs", refused, body[refused["Content-Type"]]).status, 415, protocol)
            self.assertFalse((self.dir / protocol).exists())  # refused means not logged
            self.assertEqual(log.handle_post("/v1/logs", accepted, body[accepted["Content-Type"]]).status, 200, protocol)
            self.assertEqual(len(payloads(self.dir / protocol / "logs.pblog")), 1)

    def test_any_takes_both(self):
        self.assertEqual(self.post_json("/v1/logs", LOGS).status, 200)
        self.assertEqual(self.post_proto("/v1/logs", "logs", LOGS).status, 200)


class JsonRequestTests(LoggerCase):
    """A tool that sends JSON is converted to protobuf once, on arrival."""

    def test_json_is_converted_and_stored_as_protobuf(self):
        reply = self.post_json("/v1/metrics", METRICS)
        self.assertEqual((reply.status, reply.body, reply.content_type), (200, b"{}", "application/json"))
        (received, data), = stored(self.file("claude", "metrics"))
        self.assertEqual(data, METRICS)
        self.assertEqual(received, L.to_text(START_NS))
        self.assertEqual(datetime.fromisoformat(received).utcoffset().total_seconds(), 0)

    def test_non_ascii_text_survives(self):
        self.post_json("/v1/logs", LOGS)
        self.assertIn("héllo ✓", json.dumps(datas(self.file("claude", "logs")), ensure_ascii=False))

    def test_a_body_that_is_neither_format_is_415_and_not_logged(self):
        for headers, body in (({}, b"not json"), ({}, b""), (JSON, b"not json"), ({"Content-Type": "text/plain"}, b"\xff\x00 not either")):
            self.assertEqual(self.log.handle_post("/v1/logs", headers, body).status, 415, repr(body))
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_json_that_is_not_otlp_is_400_and_not_logged(self):
        for body in ([], "text", 7, {"resourceLogs": 5}, {"resourceLogs": [{"resource": 3}]}, {"resourceLogs": [{"scopeLogs": "x"}]}):
            self.assertEqual(self.post_json("/v1/logs", body).status, 400, repr(body))
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_gzip_is_unpacked(self):
        reply = self.log.handle_post("/v1/logs", {**JSON, "Content-Encoding": "gzip"}, gzip.compress(json.dumps(LOGS).encode()))
        self.assertEqual(reply.status, 200)
        self.assertEqual(datas(self.file("claude", "logs")), [LOGS])

    def test_unsupported_or_broken_or_oversized_encodings(self):
        small = L.Logger(self.dir, max_body=1024)
        self.assertEqual(small.handle_post("/v1/logs", {**JSON, "Content-Encoding": "br"}, b"{}").status, 415)
        for encoding, pack in (("gzip", gzip.compress), ("deflate", zlib.compress)):
            headers = {**JSON, "Content-Encoding": encoding}
            self.assertEqual(small.handle_post("/v1/logs", headers, b"not packed").status, 400, encoding)
            bomb = pack(b"0" * 1_000_000)  # tiny on the wire, huge once unpacked
            self.assertEqual(small.handle_post("/v1/logs", headers, bomb).status, 413, encoding)
        self.assertEqual(list(self.dir.iterdir()), [])


class WireFormatTests(LoggerCase):
    """OTLP/HTTP as the specification allows it: either format, packed or not, answered in the format it came in."""

    def test_every_encoding_in_both_formats(self):
        json_body, proto_body = json.dumps(LOGS).encode(), L.json_to_proto("logs", LOGS)
        for encoding, pack in (("gzip", gzip.compress), ("x-gzip", gzip.compress), ("deflate", zlib.compress),
                               ("identity", lambda body: body), ("GZIP", gzip.compress)):
            for headers, body in ((JSON, json_body), (PROTO, proto_body)):
                reply = self.log.handle_post("/v1/logs", {**headers, "Content-Encoding": encoding}, pack(body))
                self.assertEqual(reply.status, 200, (encoding, headers))
        self.assertEqual(len(payloads(self.file("claude", "logs"))), 10)
        self.assertEqual(set(payloads(self.file("claude", "logs"))), {L.json_to_proto("logs", LOGS)})  # packed or not, stored the same

    def test_the_body_decides_when_the_content_type_says_neither(self):
        json_body, proto_body = json.dumps(LOGS).encode(), L.json_to_proto("logs", LOGS)
        for headers in ({}, {"Content-Type": "application/x-www-form-urlencoded"}, {"Content-Type": "application/octet-stream"}):
            self.assertEqual(self.log.handle_post("/v1/logs", headers, json_body).status, 200, headers)
            self.assertEqual(self.log.handle_post("/v1/logs", headers, b"\n " + json_body).status, 200, headers)
            self.assertEqual(self.log.handle_post("/v1/logs", headers, proto_body).status, 200, headers)
        self.assertEqual(set(payloads(self.file("claude", "logs"))), {proto_body})  # always stored as protobuf

    def test_other_names_of_the_two_formats(self):
        for content_type, body in (("application/vnd.google.protobuf", L.json_to_proto("logs", LOGS)), ("application/protobuf", L.json_to_proto("logs", LOGS)),
                                   ("application/vnd.otel+json", json.dumps(LOGS).encode()), ("Application/JSON; charset=utf-8", json.dumps(LOGS).encode())):
            self.assertEqual(self.log.handle_post("/v1/logs", {"Content-Type": content_type}, body).status, 200, content_type)

    def test_a_port_takes_the_format_the_body_has_whatever_the_content_type(self):
        proto_only = self.tool("p", protocol="protobuf")
        self.assertEqual(proto_only.handle_post("/v1/logs", {}, json.dumps(LOGS).encode()).status, 415)
        self.assertEqual(proto_only.handle_post("/v1/logs", {}, L.json_to_proto("logs", LOGS)).status, 200)
        json_only = self.tool("j", protocol="json")
        self.assertEqual(json_only.handle_post("/v1/logs", {}, L.json_to_proto("logs", LOGS)).status, 415)
        self.assertEqual(json_only.handle_post("/v1/logs", {}, json.dumps(LOGS).encode()).status, 200)

    def test_a_protobuf_body_that_is_not_otlp_is_400_and_not_logged(self):
        self.assertEqual(self.log.handle_post("/v1/logs", {}, b"\x0a\xff\xff\xff\xff\x0f").status, 400)  # field 1 longer than the body
        self.assertEqual(self.log.handle_post("/v1/logs", PROTO, b"\x0a\xff\xff\xff\xff\x0f").status, 400)
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_success_replies_are_in_the_format_of_the_request(self):
        proto = self.log.handle_post("/v1/logs", PROTO, L.json_to_proto("logs", LOGS))
        self.assertEqual((proto.status, proto.body, proto.content_type), (200, b"", "application/x-protobuf"))
        reply = self.log.handle_post("/v1/logs", JSON, json.dumps(LOGS).encode())
        self.assertEqual((reply.status, reply.body, reply.content_type), (200, b"{}", "application/json"))

    def test_error_replies_are_a_status_in_the_format_of_the_request(self):
        for headers, path, body, status, code in ((PROTO, "/v1/logs", b"\x0a\xff\xff\xff\xff\x0f", 400, 3), (PROTO, "/nope", b"", 404, 5),
                                                  (PROTO, "/v1/logs", b"", 415, 3)):
            if status == 415:
                headers = {**headers, "Content-Encoding": "br"}
            reply = self.log.handle_post(path, headers, body)
            message = L.MESSAGES[status].encode()
            self.assertEqual((reply.status, reply.content_type), (status, "application/x-protobuf"))
            self.assertEqual(reply.body, bytes([0x08, code, 0x12, len(message)]) + message)  # google.rpc.Status: code (1), message (2)
        for headers, path, body, status, code in ((JSON, "/v1/logs", b"[]", 400, 3), (JSON, "/nope", b"{}", 404, 5), ({}, "/v1/logs", b"nope", 415, 3)):
            reply = self.log.handle_post(path, headers, body)
            self.assertEqual((reply.status, reply.content_type), (status, "application/json"))
            self.assertEqual(json.loads(reply.body), {"code": code, "message": L.MESSAGES[status]})
        self.assertEqual(list(self.dir.iterdir()), [])


class RequestReadingTests(unittest.TestCase):
    def reader(self, raw, **headers):
        handler = L.Handler.__new__(L.Handler)  # no socket: only the body parsing is under test
        handler.rfile, handler.headers = io.BytesIO(raw), headers
        return handler

    def test_content_length(self):
        self.assertEqual(self.reader(b"hello", **{"Content-Length": "5"})._read_body(100), b"hello")

    def test_chunked(self):
        raw = b"3\r\nabc\r\n4;ext=1\r\ndefg\r\n0\r\nTrailer: x\r\n\r\n"
        self.assertEqual(self.reader(raw, **{"Transfer-Encoding": "chunked"})._read_body(100), b"abcdefg")

    def test_limits_and_broken_framing(self):
        with self.assertRaises(L.HttpError) as big:
            self.reader(b"x" * 10, **{"Content-Length": "10"})._read_body(5)
        self.assertEqual(big.exception.status, 413)
        with self.assertRaises(L.HttpError) as chunked_big:
            self.reader(b"a\r\n0123456789\r\n0\r\n\r\n", **{"Transfer-Encoding": "chunked"})._read_body(5)
        self.assertEqual(chunked_big.exception.status, 413)
        for raw, headers in ((b"", {"Content-Length": "abc"}), (b"zz\r\n", {"Transfer-Encoding": "chunked"})):
            with self.assertRaises(L.HttpError) as bad:
                self.reader(raw, **headers)._read_body(100)
            self.assertEqual(bad.exception.status, 400)

    def test_a_length_is_digits_only_so_a_negative_one_cannot_get_past_the_limit(self):
        # int() takes a sign, and read(-1) goes on to the end of the stream: -1 would skip the size limit altogether
        chunked = {"Transfer-Encoding": "chunked"}
        cases = [(b"x" * 10, {"Content-Length": value}) for value in ("-1", "-5", "+5", " -1", "0x5", "5_0", "")]
        cases += [(b"%s\r\nabc\r\n0\r\n\r\n" % size, chunked) for size in (b"-1", b"-3", b"+3", b"0x3", b"1_0", b"")]
        for raw, headers in cases:
            with self.assertRaises(L.HttpError, msg=(raw, headers)) as bad:
                self.reader(raw, **headers)._read_body(100)
            self.assertEqual(bad.exception.status, 400, (raw, headers))

    def test_a_chunk_is_exactly_as_long_as_it_says_and_ends_the_line(self):
        chunked = {"Transfer-Encoding": "chunked"}
        for raw in (b"3\r\nabcde\r\n0\r\n\r\n",  # longer than it says: the rest used to be thrown away
                    b"5\r\nab",  # the stream ends inside the chunk
                    b"3\r\nabc",  # ... or right after it, with no line end
                    b"3\r\nabcX\r\n0\r\n\r\n"):  # something other than the line end after the data
            with self.assertRaises(L.HttpError, msg=raw) as bad:
                self.reader(raw, **chunked)._read_body(100)
            self.assertEqual(bad.exception.status, 400, raw)
        self.assertEqual(self.reader(b"3\nabc\n0\n\n", **chunked)._read_body(100), b"abc")  # a bare line feed is still a line end


class FakeSocket:
    """Just enough of a socket for the real request handler: it reads raw HTTP bytes and keeps what is sent back."""

    def __init__(self, raw):
        self.raw, self.sent = raw, io.BytesIO()

    def makefile(self, mode, *args, **kwargs):
        return io.BytesIO(self.raw)

    def settimeout(self, seconds):
        pass

    def sendall(self, data):
        self.sent.write(data)


class HttpHandlerTests(LoggerCase):
    """The real handler class, with real HTTP parsing, fed raw bytes instead of a connection."""

    def setUp(self):
        super().setUp()
        L.Handler.logger = self.log
        self.addCleanup(setattr, L.Handler, "logger", None)

    def exchange(self, raw):
        sock = FakeSocket(raw)
        L.Handler(sock, ("127.0.0.1", 0), None)
        head, _, body = sock.sent.getvalue().partition(b"\r\n\r\n")
        status = int(head.split(b" ", 2)[1])
        headers = {k.lower(): v for k, v in (line.decode().split(": ", 1) for line in head.split(b"\r\n")[1:])}
        return status, headers, body

    @staticmethod
    def post(path, body, content_type, extra=""):
        return (f"POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: {content_type}\r\n{extra}"
                f"Content-Length: {len(body)}\r\n\r\n").encode() + body

    def test_a_protobuf_post_is_stored_and_answered_in_protobuf(self):
        wire = L.json_to_proto("logs", LOGS)
        status, headers, body = self.exchange(self.post("/v1/logs", wire, "application/x-protobuf"))
        self.assertEqual((status, headers["content-type"], headers["content-length"], body), (200, "application/x-protobuf", "0", b""))
        self.assertEqual(payloads(self.file("claude", "logs")), [wire])

    def test_a_chunked_gzip_json_post_works(self):
        packed = gzip.compress(json.dumps(METRICS).encode())
        chunked = b"".join(b"%x\r\n%s\r\n" % (len(part), part) for part in (packed[:20], packed[20:])) + b"0\r\n\r\n"
        raw = (b"POST /v1/metrics HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
               b"Content-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n") + chunked
        status, headers, body = self.exchange(raw)
        self.assertEqual((status, headers["content-type"], body), (200, "application/json", b"{}"))
        self.assertEqual(datas(self.file("claude", "metrics")), [METRICS])

    def test_content_type_parameters_and_header_case_do_not_matter(self):
        wire = L.json_to_proto("logs", LOGS)
        raw = (f"POST /v1/logs HTTP/1.1\r\nhost: x\r\ncontent-type: Application/X-Protobuf; charset=binary\r\n"
               f"content-length: {len(wire)}\r\n\r\n").encode() + wire
        self.assertEqual(self.exchange(raw)[0], 200)
        self.assertEqual(payloads(self.file("claude", "logs")), [wire])

    def test_health_check_and_unknown_get(self):
        self.assertEqual(self.exchange(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")[::2], (200, b"ok"))
        self.assertEqual(self.exchange(b"GET /v1/logs HTTP/1.1\r\nHost: x\r\n\r\n")[0], 404)

    def test_an_oversized_request_is_refused_without_being_read_or_stored(self):
        self.log.max_body = 100
        status, _, body = self.exchange(self.post("/v1/logs", b"x" * 500, "application/x-protobuf"))
        self.assertEqual(status, 413)
        self.assertIn(b"too large", body)
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_errors_never_echo_the_request(self):
        for raw in (self.post("/v1/logs", SENTINEL.encode(), "application/x-protobuf"), self.post("/v1/logs", SENTINEL.encode(), "text/plain"),
                    self.post("/nope", SENTINEL.encode(), "application/json")):
            status, _, body = self.exchange(raw)
            self.assertIn(status, (400, 404, 415))
            self.assertNotIn(SENTINEL.encode(), body)


class ProtobufRequestTests(LoggerCase):
    def test_a_sum_that_is_not_monotonic_has_no_isMonotonic_in_what_cat_prints(self):
        """protobuf leaves a false out, so the site has to read a missing isMonotonic as false (scripts/data/metrics.mjs)."""
        shapes = {}
        for monotonic in (True, False):
            data = {"resourceMetrics": [{"resource": RESOURCE, "scopeMetrics": [{"scope": SCOPE, "metrics": [
                {"name": "x.queue", "unit": "", "sum": {"aggregationTemporality": 2, "isMonotonic": monotonic, "dataPoints": [
                    {"attributes": [], "startTimeUnixNano": "1760000000000000000", "timeUnixNano": "1760000060000000000", "asDouble": 1.0}]}}]}]}]}
            printed = L.proto_to_json("metrics", L.json_to_proto("metrics", data))
            shapes[monotonic] = printed["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["sum"]
        self.assertIs(shapes[True]["isMonotonic"], True)
        self.assertNotIn("isMonotonic", shapes[False])

    def test_the_payload_is_stored_exactly_as_sent(self):
        for signal, fixture in FIXTURES.items():
            with self.subTest(signal=signal):
                wire = L.json_to_proto(signal, fixture)
                reply = self.log.handle_post(f"/v1/{signal}", PROTO, wire)
                self.assertEqual((reply.status, reply.body, reply.content_type), (200, b"", "application/x-protobuf"))
                self.assertEqual(payloads(self.file("claude", signal)), [wire])  # byte for byte

    def test_fields_this_logger_does_not_know_are_kept(self):
        # An unknown field 999 (varint 42), as a newer tool might add, placed FIRST: re-encoding the message would move it
        # to the end, so only keeping the bytes as received passes.
        wire = b"\xc0\x3e\x2a" + L.json_to_proto("logs", LOGS)
        self.assertEqual(L.parse_message("logs", wire).SerializeToString(), L.json_to_proto("logs", LOGS) + b"\xc0\x3e\x2a")
        self.assertEqual(self.log.handle_post("/v1/logs", PROTO, wire).status, 200)
        self.assertEqual(payloads(self.file("claude", "logs")), [wire])

    def test_it_reads_back_as_the_json_claude_code_wrote(self):
        for signal, fixture in FIXTURES.items():
            self.post_proto(f"/v1/{signal}", signal, fixture)
            self.assertEqual(datas(self.file("claude", signal)), [fixture])

    def test_both_ways_in_store_the_same_payload(self):
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        via_json = L.Logger(Path(other.name))
        for signal, fixture in FIXTURES.items():
            self.post_proto(f"/v1/{signal}", signal, fixture)
            via_json.handle_post(f"/v1/{signal}", JSON, json.dumps(fixture).encode())
            self.assertEqual(payloads(self.file("claude", signal)), payloads(Path(other.name) / "claude" / f"{signal}.pblog"))

    def test_types_match_the_old_files(self):
        self.post_proto("/v1/traces", "traces", TRACES)
        self.post_proto("/v1/metrics", "metrics", METRICS)
        span = datas(self.file("claude", "traces"))[0]["resourceSpans"][0]["scopeSpans"][0]["spans"][1]
        self.assertEqual((span["traceId"], span["spanId"], span["parentSpanId"]), (TRACE, SPAN2, SPAN1))  # lower-case hex
        self.assertIs(type(span["kind"]), int)
        self.assertEqual(span["status"], {"code": 2, "message": "boom"})
        data = datas(self.file("claude", "metrics"))[0]
        attrs = data["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["sum"]["dataPoints"][0]["attributes"]
        values = {a["key"]: a["value"] for a in attrs}
        self.assertEqual(values["big"], {"intValue": 9007199254740993})  # a number, and exact
        self.assertIs(type(values["count"]["intValue"]), int)
        self.assertEqual(values["empty"], {"arrayValue": {"values": []}})  # an empty list is kept

    def test_gzip_protobuf_is_stored_unpacked(self):
        wire = L.json_to_proto("logs", LOGS)
        reply = self.log.handle_post("/v1/logs", {**PROTO, "Content-Encoding": "gzip"}, gzip.compress(wire))
        self.assertEqual(reply.status, 200)
        self.assertEqual(payloads(self.file("claude", "logs")), [wire])

    def test_garbage_protobuf_is_400_and_not_stored(self):
        for body in (b"\x0a\xff\xff\xff\xff\x0f", b"\xff\xff\xff"):
            self.assertEqual(self.log.handle_post("/v1/logs", PROTO, body).status, 400)
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_other_tools_are_stored_in_their_own_folder_only(self):
        self.tool("codex").handle_post("/v1/logs", PROTO, L.json_to_proto("logs", LOGS))
        self.assertEqual([p.name for p in self.dir.iterdir()], ["codex"])
        self.assertEqual(datas(self.file("codex", "logs")), [LOGS])

    def test_nothing_is_written_at_the_top_of_the_log_folder(self):
        for tool in ("claude", "codex", "vscode"):
            self.tool(tool).handle_post("/v1/logs", PROTO, L.json_to_proto("logs", LOGS))
        self.assertTrue(all(p.is_dir() for p in self.dir.iterdir()))

    def test_the_json_round_trip_is_lossless(self):
        for signal, fixture in FIXTURES.items():
            self.assertEqual(L.proto_to_json(signal, L.json_to_proto(signal, fixture)), fixture)


class FramingTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def write(self, name, *chunks):
        path = self.dir / name
        path.write_bytes(b"".join(chunks))
        return path

    def read(self, path):
        stats = {}
        return list(L.read_records(path, stats)), stats["skipped"]

    def test_a_record_round_trips(self):
        for payload in (b"", b"x", b"\x00\xff" * 70_000):
            path = self.write("a.pblog", L.frame(START_NS, payload))
            self.assertEqual(self.read(path), ([(START_NS, payload)], 0))

    def test_many_records_come_back_in_order(self):
        path = self.write("a.pblog", *(L.frame(n, bytes([n % 256]) * (n % 50)) for n in range(1000)))
        records, skipped = self.read(path)
        self.assertEqual((len(records), skipped), (1000, 0))
        self.assertEqual([ns for ns, _ in records], list(range(1000)))

    def test_concatenated_files_are_a_valid_file(self):
        a = self.write("a.pblog", L.frame(1, b"one"), L.frame(2, b"two"))
        b = self.write("b.pblog", L.frame(3, b"three"))
        both = self.write("c.pblog", a.read_bytes(), b.read_bytes())
        self.assertEqual(self.read(both), ([(1, b"one"), (2, b"two"), (3, b"three")], 0))

    def test_a_record_cut_short_by_a_crash_is_skipped_and_the_next_ones_still_read(self):
        torn = L.frame(2, b"x" * 100)[:40]
        path = self.write("a.pblog", L.frame(1, b"one"), torn, L.frame(3, b"three"), L.frame(4, b"four"))
        self.assertEqual(self.read(path), ([(1, b"one"), (3, b"three"), (4, b"four")], 1))

    def test_a_torn_tail_is_skipped(self):
        path = self.write("a.pblog", L.frame(1, b"one"), L.frame(2, b"two")[:-3])
        self.assertEqual(self.read(path), ([(1, b"one")], 1))
        path = self.write("b.pblog", L.frame(1, b"one"), L.frame(2, b"two")[:5])  # not even a whole header
        self.assertEqual(self.read(path), ([(1, b"one")], 1))

    def test_a_bad_crc_is_skipped_and_its_neighbors_survive(self):
        bad = bytearray(L.frame(2, b"important"))
        bad[-1] ^= 0xFF
        path = self.write("a.pblog", L.frame(1, b"one"), bytes(bad), L.frame(3, b"three"))
        self.assertEqual(self.read(path), ([(1, b"one"), (3, b"three")], 1))

    def test_stray_bytes_before_and_between_records_are_skipped(self):
        path = self.write("a.pblog", b"junk", L.frame(1, b"one"), b"\x00" * 50, L.frame(2, b"two"))
        self.assertEqual(self.read(path), ([(1, b"one"), (2, b"two")], 2))

    def test_a_damaged_length_does_not_hide_the_records_after_it(self):
        broken = bytearray(L.frame(2, b"y" * 20))
        broken[4:8] = struct.pack(">I", 0x7FFFFFFF)  # claims 2 GB
        path = self.write("a.pblog", L.frame(1, b"one"), bytes(broken), L.frame(3, b"three"))
        self.assertEqual(self.read(path), ([(1, b"one"), (3, b"three")], 1))

    def test_one_damaged_stretch_is_counted_once_even_if_it_holds_marker_like_bytes(self):
        bad = bytearray(L.frame(2, b"aa" + L.MAGIC + b"bbbbbbbbbbbbbbbb" + b"cc"))  # a payload that contains "OTLP"
        bad[-1] ^= 0xFF  # and a body that fails its CRC
        path = self.write("a.pblog", L.frame(1, b"one"), bytes(bad), L.frame(3, b"three"))
        self.assertEqual(self.read(path), ([(1, b"one"), (3, b"three")], 1))

    def test_an_empty_file_has_no_records(self):
        self.assertEqual(self.read(self.write("a.pblog")), ([], 0))

    def test_a_record_inside_another_record_is_not_read_as_a_second_one(self):
        outer = L.frame(1, L.frame(2, b"inner"))
        self.assertEqual(self.read(self.write("a.pblog", outer)), ([(1, L.frame(2, b"inner"))], 0))

    def test_received_at_is_printed_as_utc_text_with_microseconds(self):
        for ns, text in ((1_792_068_000_000_000_000, "2026-10-15T12:40:00+00:00"),
                         (1_792_068_000_123_456_000, "2026-10-15T12:40:00.123456+00:00"),
                         (1_793_404_799_000_001_000, "2026-10-30T23:59:59.000001+00:00"),
                         (1_792_068_000_123_456_789, "2026-10-15T12:40:00.123456+00:00")):  # anything below a microsecond is cut
            self.assertEqual(L.to_text(ns), text)


class CatTests(LoggerCase):
    def test_cat_prints_json_lines(self):
        for signal, fixture in FIXTURES.items():
            self.post_proto(f"/v1/{signal}", signal, fixture)
        for signal, fixture in FIXTURES.items():
            out = io.StringIO()
            self.assertEqual(L.cat([self.file("claude", signal)], out), 0)
            (line,) = out.getvalue().splitlines()
            record = json.loads(line)
            self.assertEqual(list(record), ["received_at", "data"])
            self.assertEqual(record["data"], fixture)
        self.assertEqual(json.loads(line)["received_at"], L.to_text(START_NS + 2_000_000))  # the third request

    def test_the_signal_comes_from_the_file_name_or_from_the_option(self):
        self.post_proto("/v1/logs", "logs", LOGS)
        odd = self.dir / "copy.pblog"
        shutil.copy(self.file("claude", "logs"), odd)
        with self.assertRaises(SystemExit):
            L.cat([odd], io.StringIO())
        out = io.StringIO()
        L.cat([odd], out, signal="logs")
        self.assertEqual(json.loads(out.getvalue())["data"], LOGS)

    def test_damaged_records_are_skipped_and_counted(self):
        self.post_proto("/v1/logs", "logs", LOGS)
        with open(self.file("claude", "logs"), "ab") as f:
            f.write(b"stray bytes")
        self.post_proto("/v1/logs", "logs", LOGS)
        out = io.StringIO()
        self.assertEqual(L.cat([self.file("claude", "logs")], out), 1)
        self.assertEqual(len(out.getvalue().splitlines()), 2)


class AppendOnlyTests(LoggerCase):
    def test_existing_records_are_never_touched(self):
        old = L.frame(1, L.json_to_proto("logs", LOGS)) + L.frame(2, L.json_to_proto("logs", LOGS))
        self.file("claude", "logs").parent.mkdir()
        self.file("claude", "logs").write_bytes(old)
        for _ in range(3):
            self.post_proto("/v1/logs", "logs", LOGS)
        content = self.file("claude", "logs").read_bytes()
        self.assertTrue(content.startswith(old))
        self.assertEqual(len(payloads(self.file("claude", "logs"))), 5)

    def test_a_torn_record_is_left_alone_and_the_next_one_still_reads(self):
        old = L.frame(1, b"first") + L.frame(2, b"x" * 100)[:30]  # a crash cut the second record short
        self.file("claude", "logs").parent.mkdir()
        self.file("claude", "logs").write_bytes(old)
        self.post_proto("/v1/logs", "logs", LOGS)
        content = self.file("claude", "logs").read_bytes()
        self.assertTrue(content.startswith(old))  # nothing repaired, truncated or moved
        stats = {}
        records = list(L.read_records(self.file("claude", "logs"), stats))
        self.assertEqual((len(records), stats["skipped"]), (2, 1))
        self.assertEqual(L.proto_to_json("logs", records[1][1]), LOGS)

    def test_the_source_never_deletes_truncates_or_rewrites(self):
        tree = ast.parse((ROOT / "otel-logger.py").read_text(encoding="utf-8"))
        forbidden = {"unlink", "remove", "rmtree", "rmdir", "truncate", "rename", "replace", "write_text", "write_bytes", "removedirs"}
        modes = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
            self.assertNotIn(name, forbidden, f"line {node.lineno}: {name}()")
            if name == "open":
                mode = node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == "mode"), None)
                self.assertIsInstance(mode, ast.Constant, f"line {node.lineno}: open() needs a literal mode")
                modes.add(mode.value)
        # append to the logs, and read them: nothing can overwrite
        self.assertEqual(modes, {"ab", "rb"})


class QuietTests(LoggerCase):
    def test_no_request_content_reaches_the_output(self):
        leaky = json.loads(json.dumps(LOGS).replace("héllo ✓", SENTINEL))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.post_json("/v1/logs", leaky)
            self.tool("codex").handle_post("/v1/logs", PROTO, L.json_to_proto("logs", leaky))
            self.log.handle_post("/v1/logs", PROTO, SENTINEL.encode())  # malformed
            self.log.handle_post("/v1/logs", JSON, SENTINEL.encode())  # malformed
            self.post_json("/v1/nope", leaky)
        self.assertEqual(out.getvalue() + err.getvalue(), "")


class ClaudeOnlyRootTests(LoggerCase):
    """The "claude" port belongs to Claude Code. Files are append-only, so a stray tool must never get into them."""

    def test_claude_code_and_the_desktop_app_stay_in_the_claude_files(self):
        for name in ("claude-code", "claude-code-desktop"):
            self.post_json("/v1/logs", as_service(LOGS, name))
        self.assertEqual(len(payloads(self.file("claude", "logs"))), 2)
        self.assertFalse((self.dir / "other").exists())

    def test_another_tool_on_the_claude_port_goes_to_other_and_the_claude_files_are_untouched(self):
        old = L.frame(1, L.json_to_proto("logs", LOGS))
        self.file("claude", "logs").parent.mkdir()
        self.file("claude", "logs").write_bytes(old)
        foreign = as_service(LOGS, "codex_cli_rs")
        self.assertEqual(self.post_json("/v1/logs", foreign).status, 200)  # the tool is not told off: its data is kept
        self.assertEqual(self.file("claude", "logs").read_bytes(), old)
        self.assertEqual(datas(self.file("other", "logs")), [foreign])

    def test_the_same_holds_for_protobuf(self):
        foreign = as_service(METRICS, "copilot-chat")
        self.assertEqual(self.post_proto("/v1/metrics", "metrics", foreign).status, 200)
        self.assertFalse(self.file("claude", "metrics").exists())
        self.assertEqual(datas(self.file("other", "metrics")), [foreign])

    def test_one_foreign_resource_is_enough_to_keep_the_whole_request_out(self):
        mixed = json.loads(json.dumps(LOGS))
        mixed["resourceLogs"].append(as_service(LOGS, "opencode")["resourceLogs"][0])
        self.post_json("/v1/logs", mixed)
        self.assertFalse(self.file("claude", "logs").exists())
        self.assertEqual(len(payloads(self.file("other", "logs"))), 1)

    def test_a_request_that_cannot_say_who_sent_it_goes_to_other(self):
        nameless = json.loads(json.dumps(LOGS))
        nameless["resourceLogs"][0]["resource"] = {"attributes": [], "droppedAttributesCount": 0}
        for body in (nameless, {}):
            self.assertEqual(self.post_json("/v1/logs", body).status, 200)
        self.assertEqual(self.log.handle_post("/v1/logs", PROTO, b"").status, 200)  # an empty protobuf request
        self.assertFalse(self.file("claude", "logs").exists())
        self.assertEqual(len(payloads(self.file("other", "logs"))), 3)

    def test_a_path_prefix_does_not_get_round_the_guard(self):
        self.post_json("/claude/v1/logs", as_service(LOGS, "someone-else"))
        self.assertFalse(self.file("claude", "logs").exists())
        self.assertTrue(self.file("other", "logs").exists())

    def test_the_other_tools_ports_decide_for_themselves(self):
        self.tool("codex").handle_post("/v1/logs", JSON, json.dumps(as_service(LOGS, "whatever")).encode())
        self.assertEqual(len(payloads(self.file("codex", "logs"))), 1)
        self.assertFalse((self.dir / "other").exists())

    def test_the_names_that_count_as_claude_are_configurable(self):
        log = L.Logger(self.dir, claude_services="my-claude, other-name")
        log.handle_post("/v1/logs", JSON, json.dumps(as_service(LOGS, "my-claude")).encode())
        log.handle_post("/v1/logs", JSON, json.dumps(LOGS).encode())  # claude-code is not on that list now
        self.assertEqual(len(payloads(self.file("claude", "logs"))), 1)
        self.assertEqual(len(payloads(self.file("other", "logs"))), 1)

    def test_other_goes_under_the_log_folder_even_when_claude_has_a_folder_of_its_own(self):
        log = L.Logger(self.dir, "claude", directory=self.dir / "elsewhere")
        log.handle_post("/v1/logs", JSON, json.dumps(as_service(LOGS, "stranger")).encode())
        self.assertEqual(len(payloads(self.file("other", "logs"))), 1)
        self.assertFalse((self.dir / "elsewhere").exists())

    def test_service_names_reads_every_resource(self):
        parse = L.parse_message
        self.assertEqual(L.service_names("logs", parse("logs", L.json_to_proto("logs", LOGS))), ["claude-code"])
        nameless = {"resourceSpans": [{"resource": {"attributes": []}}]}
        self.assertEqual(L.service_names("traces", parse("traces", L.json_to_proto("traces", nameless))), [None])
        self.assertEqual(L.service_names("logs", parse("logs", b"")), [])


class ForwarderTests(unittest.TestCase):
    def forwarder(self, statuses, **kw):
        calls, sleeps = [], []

        def send(url, payload):
            calls.append((url, payload))
            result = statuses[min(len(calls), len(statuses)) - 1]
            if isinstance(result, Exception):
                raise result
            return result

        return L.Forwarder("http://collector:4318/", send=send, sleep=sleeps.append, **kw), calls, sleeps

    def test_headers_parse(self):
        self.assertEqual(L.parse_headers("a=b, c = d=e,,=x,y"), {"a": "b", "c": "d=e"})
        self.assertEqual(L.parse_headers(None), {})

    def test_delivers_to_the_signal_path(self):
        fwd, calls, _ = self.forwarder([200])
        self.assertTrue(fwd.deliver("logs", b"payload"))
        self.assertEqual(calls, [("http://collector:4318/v1/logs", b"payload")])
        self.assertEqual((fwd.sent, fwd.dropped), (1, 0))

    def test_retries_server_errors_429_and_connection_errors_with_backoff(self):
        fwd, calls, sleeps = self.forwarder([503, 429, ConnectionRefusedError(), 200])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(fwd.deliver("metrics", b"x"))
        self.assertEqual((len(calls), sleeps), (4, [1, 2, 4]))

    def test_other_client_errors_are_dropped_without_retrying(self):
        fwd, calls, sleeps = self.forwarder([400])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(fwd.deliver("traces", b"x"))
        self.assertEqual((len(calls), sleeps, fwd.dropped), (1, [], 1))

    def test_gives_up_after_the_attempts(self):
        fwd, calls, sleeps = self.forwarder([503], attempts=3)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(fwd.deliver("logs", b"x"))
        self.assertEqual((len(calls), len(sleeps), fwd.dropped), (3, 2, 1))

    def test_the_queue_is_bounded_and_drops_the_oldest(self):
        fwd, _, _ = self.forwarder([200], max_bytes=100)
        with contextlib.redirect_stderr(io.StringIO()):
            for n in range(3):
                fwd.submit("logs", bytes([n]) * 60)
        self.assertEqual([p[0] for _, p in fwd._queue], [2])
        self.assertEqual(fwd.dropped, 2)

    def test_what_is_forwarded_is_what_is_stored(self):
        with tempfile.TemporaryDirectory() as tmp:
            fwd, _, _ = self.forwarder([200])
            log = L.Logger(Path(tmp), forwarder=fwd)
            wire = L.json_to_proto("logs", LOGS)
            log.handle_post("/v1/logs", PROTO, wire)  # protobuf in: passed on untouched
            log.handle_post("/v1/logs", JSON, json.dumps(LOGS).encode())  # JSON in: converted once, stored and forwarded alike
            log.handle_post("/v1/logs", JSON, b'{"resourceLogs": 5}')  # not OTLP: refused, so neither stored nor forwarded
            self.assertEqual([(s, p) for s, p in fwd._queue], [("logs", wire), ("logs", wire)])
            self.assertEqual(payloads(Path(tmp) / "claude" / "logs.pblog"), [wire, wire])


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class SiteContractTests(unittest.TestCase):
    """The site's data step must make the same datasets from .pblog files whether the tool sent JSON or protobuf."""

    def claude_like(self):
        def point(t, value, **attrs):
            return {"attributes": [attr(k, stringValue=v) for k, v in attrs.items()], "startTimeUnixNano": str(t), "timeUnixNano": str(t), "asDouble": value}

        common = dict(**{"session.id": "s-1"}, model="claude-sonnet-5-5", terminal="x")
        base = 1760000000
        metrics = {"resourceMetrics": [{"resource": RESOURCE, "scopeMetrics": [{"scope": SCOPE, "metrics": [
            {"name": "claude_code.token.usage", "description": "", "unit": "tokens", "sum": {"aggregationTemporality": 1, "isMonotonic": True, "dataPoints": [
                point(base * 10**9, 10, type="input", **common), point((base + 60) * 10**9, 90, type="output", **common)]}},
            {"name": "claude_code.cost.usage", "description": "", "unit": "USD", "sum": {"aggregationTemporality": 1, "isMonotonic": True, "dataPoints": [
                point((base + 30) * 10**9, 0.25, **common)]}},
        ]}]}]}
        logs = {"resourceLogs": [{"resource": RESOURCE, "scopeLogs": [{"scope": SCOPE, "logRecords": [
            {"timeUnixNano": str((base + 5) * 10**9), "observedTimeUnixNano": str((base + 5) * 10**9), "droppedAttributesCount": 0,
             "body": {"stringValue": "claude_code.user_prompt"},
             "attributes": [attr("session.id", stringValue="s-1"), attr("prompt", stringValue="synthetic prompt")]}]}]}]}
        return {"metrics": metrics, "logs": logs}

    def copilot_like(self):
        """What Copilot Chat sends: cumulative histograms for the tokens (every export repeats the running total), and spans."""
        def span(name, operation, spanid, t, **attrs):
            all_attrs = {"gen_ai.operation.name": operation, **attrs}
            return {"traceId": TRACE, "spanId": spanid, "name": name, "kind": 3, "startTimeUnixNano": str(t * 10**9), "endTimeUnixNano": str((t + 2) * 10**9),
                    "attributes": [attr(k, intValue=v) if isinstance(v, int) else attr(k, stringValue=v) for k, v in all_attrs.items()],
                    "droppedAttributesCount": 0, "events": [], "droppedEventsCount": 0, "links": [], "droppedLinksCount": 0, "status": {"code": 0}, "flags": 256}

        def sample(t, count, total, kind):
            return {"attributes": [attr("gen_ai.request.model", stringValue="gpt-a"), attr("gen_ai.token.type", stringValue=kind)],
                    "startTimeUnixNano": str(base * 10**9), "timeUnixNano": str(t * 10**9), "count": str(count), "sum": total}

        resource = {"attributes": [attr("service.name", stringValue="copilot-chat"), attr("service.version", stringValue="0.71.0")], "droppedAttributesCount": 0}
        base = 1760000000
        metrics = {"resourceMetrics": [{"resource": resource, "scopeMetrics": [{"scope": {"name": "copilot-chat"}, "metrics": [
            {"name": "gen_ai.client.token.usage", "description": "", "unit": "", "histogram": {"aggregationTemporality": 2, "dataPoints": [
                sample(base + 10, 1, 100.0, "input"), sample(base + 10, 1, 10.0, "output"),
                sample(base + 70, 1, 100.0, "input"), sample(base + 70, 1, 10.0, "output"),  # nothing new in this export
                sample(base + 130, 2, 140.0, "input"),  # one more call: the running total is now 140
            ]}},
        ]}]}]}
        spans = [
            span("chat gpt-a", "chat", "0000000000000001", base, **{"gen_ai.request.model": "gpt-a", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10}),
            span("invoke_agent GitHub Copilot Chat", "invoke_agent", "0000000000000003", base, **{"gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10}),
        ]
        return {"metrics": metrics, "traces": {"resourceSpans": [{"resource": resource, "scopeSpans": [{"scope": {"name": "copilot-chat"}, "spans": spans}]}]}}

    def run_data_step(self, root, out):
        env = {**os.environ, "OTEL_LOGGER_PYTHON": sys.executable, "OTEL_LOGGER_SCRIPT": str(ROOT / "otel-logger.py")}
        subprocess.run(["node", str(ROOT / "scripts" / "prepare-data.mjs"), "--dir", str(root), "--out", str(out)],
                       check=True, capture_output=True, cwd=ROOT, env=env)

    def read(self, out, name):
        data = json.loads((Path(out) / name).read_text(encoding="utf-8"))
        data.pop("generatedAt", None), data.pop("source", None)
        return data

    def everything(self, out, folder):
        """Every file the site would load for a folder: usage, the index of Logs, and each kind's rows."""
        folder = Path(out) / folder
        index = self.read(folder, "logs.json")
        return {"usage": self.read(folder, "usage.json"), "index": index, "events": {e["id"]: self.read(folder / "logs", f"{e['id']}.json") for e in index["events"]}}

    def test_the_site_makes_the_same_datasets_whichever_way_a_tool_sends(self):
        outputs = []
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("json", "proto"):
                root = Path(tmp) / name / "root"  # the log root: one folder per tool
                log = L.Logger(root)
                for signal, data in self.claude_like().items():
                    if name == "json":
                        reply = log.handle_post(f"/v1/{signal}", JSON, json.dumps(data).encode())
                    else:
                        reply = log.handle_post(f"/v1/{signal}", PROTO, L.json_to_proto(signal, data))
                    self.assertEqual(reply.status, 200)
                out = Path(tmp) / name / "out"
                self.run_data_step(root, out)  # reads the .pblog files through this logger's `cat`
                outputs.append(self.everything(out, "claude"))
        self.assertEqual(outputs[0], outputs[1])
        usage = outputs[0]["usage"]
        self.assertEqual([(m["key"], len(m["rows"])) for m in usage["measures"]], [("claude_code.token.usage", 2), ("claude_code.cost.usage", 1)])  # and it is not an empty comparison
        self.assertEqual([e["name"] for e in outputs[0]["index"]["events"]], ["claude_code.user_prompt"])
        self.assertEqual(len(next(iter(outputs[0]["events"].values()))["rows"]), 1)

    def test_a_tool_that_sends_running_totals_is_counted_once_whichever_way_it_sends(self):
        outputs = []
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("json", "proto"):
                root = Path(tmp) / name / "root"
                log = L.Logger(root, "vscode")
                self.assertEqual(self.post_claude(L.Logger(root), root).status, 200)
                for signal, data in self.copilot_like().items():
                    if name == "json":
                        reply = log.handle_post(f"/v1/{signal}", JSON, json.dumps(data).encode())
                    else:
                        reply = log.handle_post(f"/v1/{signal}", PROTO, L.json_to_proto(signal, data))
                    self.assertEqual(reply.status, 200)
                out = Path(tmp) / name / "out"
                self.run_data_step(root, out)
                self.assertEqual(self.read(out, "sources.json")["sources"], [{"id": "claude", "label": "Claude Code"}, {"id": "vscode", "label": "VS Code Copilot"}])
                got = self.everything(out, "vscode")
                tokens = next(m for m in got["usage"]["measures"] if m["key"] == "gen_ai.client.token.usage")
                # the running totals were 100, 100, 140 (input) and 10, 10 (output): 150 tokens in all, not 360
                self.assertEqual(sum(r[1] for r in tokens["rows"]), 100 + 40 + 10)
                calls = next(m for m in got["usage"]["measures"] if m["key"] == "gen_ai.client.token.usage#count")
                self.assertEqual(sum(r[1] for r in calls["rows"]), 3)  # 2 input calls + 1 output
                # and the spans are there to read, one kind per name
                self.assertEqual(sorted(e["name"] for e in got["index"]["events"]), ["chat gpt-a", "invoke_agent GitHub Copilot Chat"])
                outputs.append(got)
        self.assertEqual(outputs[0], outputs[1])  # the same whichever way the tool sent it

    def post_claude(self, log, root):
        return log.handle_post("/v1/logs", JSON, json.dumps(self.claude_like()["logs"]).encode())


if __name__ == "__main__":
    unittest.main()
