import io
import json
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import board  # noqa: E402

TS = "2026-11-03T08:00:00.000Z"
T0 = board.parse_time(TS)
TOKEN = "test-token"
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # ignore http_proxy


def at(seconds: float) -> str:
    return board.format_time(T0 + seconds)


def report(state="working", since=TS, sent=TS, **extra) -> dict:
    return {"v": 1, "host": "mac", "cwd": "/w/app", "project": "app",
            "state": state, "since": since, "sentAt": sent, **extra}


def encode(payload) -> bytes:
    return json.dumps(payload).encode("utf-8")


class FakeClock:
    def __init__(self, now: float = T0):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class ParseTest(unittest.TestCase):
    def test_accepts_a_valid_report_and_fills_missing_optionals(self):
        parsed = board.parse_report(encode(report(detail="Bash: pnpm test")))
        self.assertEqual(parsed["state"], "working")
        self.assertEqual(parsed["detail"], "Bash: pnpm test")
        self.assertIsNone(parsed["ecc"])

    def test_rejects_reports_that_break_the_contract(self):
        bad = {
            "missing state": {k: v for k, v in report().items() if k != "state"},
            "version 2": report(v=2),
            "version true": report(v=True),
            "unknown state": report(state="sleeping"),
            "bad time": report(since="2026-11-03 08:00:00"),
            "long host": report(host="h" * 65),
            "numeric cwd": report(cwd=3),
            "string ecc": report(ecc="x"),
            "negative done": report(ecc={"prd": {"title": "t", "done": -1, "total": 2, "inProgress": []},
                                         "plan": None, "phase": None, "isActive": False}),
        }
        for name, payload in bad.items():
            with self.subTest(name), self.assertRaises(board.ReportError):
                board.parse_report(encode(payload))
        for body in (b"[1, 2]", b"not json", b"\xff\xfe"):
            with self.subTest(body), self.assertRaises(board.ReportError):
                board.parse_report(body)

    def test_truncates_long_prompt_and_answer(self):
        tail = [f"line {i} " + "x" * 600 for i in range(20)]
        parsed = board.parse_report(encode(report(
            lastPrompt={"text": "p" * 3000, "at": TS},
            lastAnswer={"tail": tail, "at": TS},
        )))
        self.assertEqual(len(parsed["lastPrompt"]["text"]), 2000)
        self.assertEqual(len(parsed["lastAnswer"]["tail"]), 10)
        self.assertTrue(parsed["lastAnswer"]["tail"][0].startswith("line 10 "))
        self.assertTrue(all(len(line) == 500 for line in parsed["lastAnswer"]["tail"]))

    def test_drops_unknown_keys_at_every_level(self):
        ecc = {"prd": {"title": "PRD", "done": 3, "total": 8, "inProgress": ["4"], "extra": 1},
               "plan": {"name": "Plan", "done": 1, "total": 5, "isArchived": False, "extra": 1},
               "phase": "EXECUTE", "isActive": True, "extra": 1}
        parsed = board.parse_report(encode(report(ecc=ecc, extra=1)))
        self.assertNotIn("extra", parsed)
        self.assertNotIn("extra", parsed["ecc"])
        self.assertNotIn("extra", parsed["ecc"]["prd"])
        self.assertNotIn("extra", parsed["ecc"]["plan"])
        self.assertEqual(parsed["ecc"]["prd"]["inProgress"], ["4"])

    def test_returns_a_new_dict_without_touching_the_input(self):
        raw = report(lastPrompt={"text": "p" * 3000, "at": TS})
        before = json.dumps(raw, sort_keys=True)
        parsed = board.parse_report(encode(raw))
        self.assertEqual(json.dumps(raw, sort_keys=True), before)
        self.assertIsNot(parsed, raw)

    def test_time_round_trips_with_milliseconds(self):
        self.assertEqual(board.format_time(board.parse_time("2026-11-03T08:00:01.250Z")),
                         "2026-11-03T08:00:01.250Z")


class BoardTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.lines = []
        self.board = board.Board(clock=self.clock, record=self.lines.append)

    def order(self) -> list[str]:
        return [s["sessionId"] for s in self.board.snapshot()["sessions"]]

    def test_orders_waiting_sessions_first_and_longest_wait_first(self):
        self.board.accept("work", report("working", since=at(-50)))
        self.board.accept("ended", report("ended", since=at(-60)))
        self.board.accept("turn", report("your-turn", since=at(-10)))
        self.board.accept("approve-new", report("needs-approval", since=at(-5)))
        self.board.accept("approve-old", report("needs-approval", since=at(-40)))
        self.assertEqual(self.order(), ["approve-old", "approve-new", "turn", "work", "ended"])

    def test_moves_since_onto_the_server_clock(self):
        # The reporter's clock runs 60 s fast: it says it entered the state at +50 and sent at +60.
        self.board.accept("fast", report("needs-approval", since=at(50), sent=at(60)))
        self.board.accept("true", report("needs-approval", since=at(-5)))
        session = self.board.snapshot()["sessions"][0]
        self.assertEqual(session["sessionId"], "fast")
        self.assertEqual(session["waitingSince"], at(-10))

    def test_marks_silent_sessions_lost_and_sorts_them_before_ended(self):
        self.board.accept("ended", report("ended"))
        self.board.accept("quiet", report("needs-approval"))
        self.clock.advance(20)
        self.board.accept("alive", report("working", since=at(20), sent=at(20)))
        self.clock.advance(11)
        sessions = self.board.snapshot()["sessions"]
        self.assertEqual([s["sessionId"] for s in sessions], ["alive", "quiet", "ended"])
        self.assertEqual([s["isLost"] for s in sessions], [False, True, False])

    def test_forgets_ended_after_ten_minutes_and_lost_after_an_hour(self):
        self.board.accept("ended", report("ended"))
        self.board.accept("lost", report("working"))
        self.clock.advance(board.ENDED_RETAIN_S + 1)
        self.assertEqual(self.order(), ["lost"])
        self.clock.advance(board.LOST_RETAIN_S)
        self.assertEqual(self.order(), [])

    def test_records_state_changes_but_not_heartbeats(self):
        self.board.accept("s1", report("needs-approval", since=TS, sent=at(0.4)))
        self.clock.advance(5)
        self.board.accept("s1", report("needs-approval", since=TS, sent=at(5)))
        self.clock.advance(90)
        self.board.accept("s1", report("working", since=at(95.2), sent=at(95.5)))
        self.assertEqual([(l["from"], l["to"]) for l in self.lines],
                         [(None, "needs-approval"), ("needs-approval", "working")])
        self.assertEqual(self.lines[0]["reportDelayS"], 0.4)
        self.assertNotIn("waitS", self.lines[0])
        self.assertEqual(self.lines[1]["waitS"], 95.2)
        self.assertEqual(self.lines[1]["reportDelayS"], 0.3)


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.board = board.Board(clock=self.clock)
        self.web = tempfile.TemporaryDirectory()
        Path(self.web.name, "index.html").write_text("<p>board</p>", encoding="utf-8")
        handler = board.make_handler(self.board, TOKEN, Path(self.web.name))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.web.cleanup()

    def call(self, method, path, body=None, token=TOKEN, headers=None):
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        if token is not None:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with DIRECT.open(request, timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def post(self, session_id, payload, **kwargs):
        return self.call("POST", f"/api/sessions/{session_id}", encode(payload), **kwargs)

    def test_requires_the_token(self):
        self.assertEqual(self.post("s1", report(), token=None)[0], 401)
        self.assertEqual(self.post("s1", report(), token="wrong")[0], 401)
        self.assertEqual(self.call("GET", "/api/sessions", token=None)[0], 401)
        self.assertEqual(self.call("GET", "/", token=None)[0], 401)

    def test_health_check_needs_no_token(self):
        self.assertEqual(self.call("GET", "/healthz", token=None), (200, b"ok"))

    def test_page_opens_with_the_token_in_the_query(self):
        self.assertEqual(self.call("GET", f"/?token={TOKEN}", token=None), (200, b"<p>board</p>"))

    def test_ten_sessions_come_back_in_waiting_order(self):
        states = ["working", "your-turn", "needs-approval", "ended", "working"] * 2
        for i, state in enumerate(states):
            status, _ = self.post(f"s{i}", report(state, since=at(-i)))
            self.assertEqual(status, 204)
        status, body = self.call("GET", "/api/sessions")
        sessions = json.loads(body)["sessions"]
        self.assertEqual(status, 200)
        self.assertEqual(len(sessions), 10)
        self.assertEqual([s["sessionId"] for s in sessions],
                         ["s7", "s2", "s6", "s1", "s9", "s5", "s4", "s0", "s8", "s3"])
        self.clock.advance(board.LOST_AFTER_S + 1)
        sessions = json.loads(self.call("GET", "/api/sessions")[1])["sessions"]
        self.assertEqual([s["isLost"] for s in sessions], [True] * 8 + [False] * 2)

    def test_rejects_bad_bodies_and_ids(self):
        self.assertEqual(self.call("POST", "/api/sessions/s1", b"{not json")[0], 400)
        self.assertEqual(self.post("s1", report(state="sleeping"))[0], 400)
        self.assertEqual(self.post("bad%20id", report())[0], 404)
        self.assertEqual(self.post("a/b", report())[0], 404)
        self.assertEqual(self.call("GET", "/nope")[0], 404)

    def test_rejects_oversized_bodies(self):
        payload = report(detail=None, lastPrompt={"text": "p" * (board.MAX_BODY_BYTES + 1024), "at": TS})
        self.assertEqual(self.post("s1", payload)[0], 413)


class HardeningTest(unittest.TestCase):
    """Inputs that once broke the board for everyone, found in review."""

    def test_rejects_lone_surrogates_anywhere(self):
        for payload in (report(host="\ud800"), report(lastAnswer={"tail": ["ok", "\udfff"], "at": TS})):
            with self.subTest(payload), self.assertRaises(board.ReportError):
                board.parse_report(encode(payload))

    def test_rejects_times_outside_the_contract(self):
        for text in ("9999-12-31T23:59:59.999Z", "0001-01-01T00:00:00.000Z",
                     "2026-11-03T08:00:00.1Z", "2026-11-3T8:0:0.000Z", "2026-02-30T08:00:00.000Z"):
            with self.subTest(text), self.assertRaises(board.ReportError):
                board.parse_report(encode(report(since=text)))

    def test_rejects_deep_nesting_and_huge_numbers_as_bad_json(self):
        for body in (b"[" * 60000, b'{"v":' + b"9" * 5000 + b"}"):
            with self.assertRaises(board.ReportError):
                board.parse_report(body)

    def test_rejects_other_contract_violations(self):
        bad = {
            "long detail": report(detail="d" * 201),
            "prompt without time": report(lastPrompt={"text": "hi"}),
            "tail of numbers": report(lastAnswer={"tail": [1], "at": TS}),
            "too many phases": report(ecc={"prd": {"title": "t", "done": 0, "total": 1, "inProgress": ["1"] * 65},
                                           "plan": None, "phase": None, "isActive": False}),
        }
        for name, payload in bad.items():
            with self.subTest(name), self.assertRaises(board.ReportError):
                board.parse_report(encode(payload))

    def test_keeps_sessions_up_to_the_retention_limit(self):
        clock = FakeClock()
        b = board.Board(clock=clock)
        b.accept("ended", report("ended"))
        b.accept("lost", report("working"))
        clock.advance(board.ENDED_RETAIN_S)
        self.assertEqual(len(b.snapshot()["sessions"]), 2)
        clock.advance(board.LOST_RETAIN_S - board.ENDED_RETAIN_S)
        self.assertEqual([s["sessionId"] for s in b.snapshot()["sessions"]], ["lost"])

    def test_record_file_appends_lines_and_survives_a_failed_write(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, "states.jsonl")
            record = board.RecordFile(path)
            b = board.Board(clock=FakeClock(), record=record)
            b.accept("s1", report("needs-approval"))
            b.accept("s1", report("working", since=at(1)))
            record.close()
            lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([line["to"] for line in lines], ["needs-approval", "working"])
            errors = io.StringIO()
            with redirect_stderr(errors):
                record(lines[0])  # writing to a closed file must not raise
                record(lines[0])
            self.assertEqual(errors.getvalue().count("error: cannot write the record file"), 1)
            self.assertEqual(len(path.read_text(encoding="utf-8").splitlines()), 2)


class RawServerTest(unittest.TestCase):
    def setUp(self):
        self.board = board.Board(clock=FakeClock())
        handler = board.make_handler(self.board, TOKEN, board.WEB_DIR, timeout_s=0.5)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def raw(self, request: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as conn:
            conn.sendall(request)
            chunks = []
            while chunk := conn.recv(4096):
                chunks.append(chunk)
        return b"".join(chunks)

    def post_raw(self, headers: str, body: bytes = b"") -> bytes:
        head = f"POST /api/sessions/s1 HTTP/1.0\r\nAuthorization: Bearer {TOKEN}\r\n{headers}\r\n"
        return self.raw(head.encode() + body)

    def test_answers_413_without_a_usable_length(self):
        for headers in ("", "Content-Length: 0\r\n", "Content-Length: 1_0\r\n", "Content-Length: x\r\n"):
            with self.subTest(headers):
                self.assertTrue(self.post_raw(headers, b"{}").startswith(b"HTTP/1.0 413"))

    def test_a_short_body_times_out_without_storing_anything(self):
        self.assertEqual(self.post_raw("Content-Length: 500\r\n", b"{}"), b"")
        self.assertEqual(self.board.snapshot()["sessions"], [])

    def test_token_in_the_query_reads_sessions(self):
        response = self.raw(f"GET /api/sessions?token={TOKEN} HTTP/1.0\r\n\r\n".encode())
        self.assertTrue(response.startswith(b"HTTP/1.0 200"))

    def test_a_poisoned_report_cannot_break_the_summary(self):
        body = b'{"v":1,"host":"\\ud800","cwd":"/w","project":"p","state":"working",' \
               b'"since":"2026-11-03T08:00:00.000Z","sentAt":"2026-11-03T08:00:00.000Z"}'
        self.assertTrue(self.post_raw(f"Content-Length: {len(body)}\r\n", body).startswith(b"HTTP/1.0 400"))
        response = self.raw(f"GET /api/sessions HTTP/1.0\r\nAuthorization: Bearer {TOKEN}\r\n\r\n".encode())
        self.assertTrue(response.startswith(b"HTTP/1.0 200"))


class UrlTest(unittest.TestCase):
    def test_one_url_for_a_specific_host(self):
        self.assertEqual(board.board_urls("127.0.0.1", 7777, "t"), ["http://127.0.0.1:7777/?token=t"])

    def test_all_local_addresses_when_listening_everywhere(self):
        urls = board.board_urls("0.0.0.0", 7777, "t")
        self.assertEqual(urls[0], "http://127.0.0.1:7777/?token=t")
        self.assertEqual(len(urls), len(set(urls)))
        self.assertFalse(any("0.0.0.0" in url for url in urls))


class DemoTest(unittest.TestCase):
    def test_every_demo_report_passes_validation(self):
        import demo

        reports = demo.build_reports(T0)
        self.assertEqual(len(reports), 10)
        states = []
        for _, body, _ in reports:
            parsed = board.parse_report(encode(body))
            states.append(parsed["state"])
        self.assertEqual(states.count("needs-approval"), 2)
        self.assertEqual(states.count("your-turn"), 2)
        self.assertEqual(states.count("ended"), 1)
        self.assertEqual(sum(1 for _, _, alive in reports if not alive), 2, "lost and ended stop heartbeating")

    def test_demo_sessions_sort_like_the_design(self):
        import demo

        clock = FakeClock()
        b = board.Board(clock=clock)
        for sid, body, _ in demo.build_reports(T0):
            b.accept(sid, board.parse_report(encode(body)))
        order = [s["sessionId"] for s in b.snapshot()["sessions"]]
        self.assertEqual(order[:4], ["demo-ai-video", "demo-lancekit", "demo-novel-skills", "demo-homelab"])
        self.assertEqual(order[-1], "demo-notes")


if __name__ == "__main__":
    unittest.main()
