#!/usr/bin/env python3
"""Collect Claude Code session states over HTTP and serve them to a wall board.

    board.py                              # listen on 127.0.0.1:7777, random token
    board.py --host 0.0.0.0 --token t     # reachable from the LAN
    board.py --record states.jsonl        # also append every state change

Sessions POST /api/sessions/<sessionId>; the board page reads GET /api/sessions.
The contract is docs/session-board-contract.md. Python 3.10+ standard library only.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, quote_plus, urlsplit

CONTRACT_VERSION = 1
STATES = ("working", "needs-approval", "your-turn", "ended")
STATE_ORDER = {"needs-approval": 0, "your-turn": 1, "working": 2}
LOST_ORDER = 3
ENDED_ORDER = 4
SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
SESSION_PATH = re.compile(r"^/api/sessions/([^/]+)$")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 7777
TOKEN_ENV = "SESSION_BOARD_TOKEN"
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
ALL_INTERFACES = ("", "0.0.0.0", "::")
LOOPBACK = "127.0.0.1"
PROBE_ADDRESS = ("10.255.255.255", 1)  # never contacted: connecting a UDP socket only picks a route
TIMESTAMP = "%Y-%m-%dT%H:%M:%S.%fZ"
TIMESTAMP_TEXT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
EARLIEST_TIME = datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp()
LATEST_TIME = datetime(2100, 1, 1, tzinfo=timezone.utc).timestamp()
MAX_BODY_BYTES = 64 * 1024
MAX_DRAIN_BYTES = 1024 * 1024  # read and drop a rejected body up to this size so the client sees the answer
REQUEST_TIMEOUT_S = 10
LOST_AFTER_S = 30
ENDED_RETAIN_S = 10 * 60
LOST_RETAIN_S = 60 * 60
LIMITS = {
    "host": 64,
    "cwd": 512,
    "project": 128,
    "detail": 200,
    "prompt": 2000,
    "tail_lines": 10,
    "tail_line": 500,
    "title": 200,
    "phase": 32,
    "milestone": 16,
    "milestones": 64,
}


class ReportError(ValueError):
    """A report that does not follow the contract; the HTTP layer answers 400."""


def parse_time(text: object) -> float:
    """Epoch seconds for a contract time; only years 2000-2099 so later arithmetic stays in range."""
    if not isinstance(text, str) or not TIMESTAMP_TEXT.match(text):
        raise ReportError(f"time must look like 2026-11-03T08:00:00.000Z, got {text!r}")
    try:
        epoch = datetime.strptime(text, TIMESTAMP).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        raise ReportError(f"time is not a real date: {text!r}") from None
    if not EARLIEST_TIME <= epoch < LATEST_TIME:
        raise ReportError(f"time must be between 2000 and 2099, got {text!r}")
    return epoch


def format_time(epoch: float) -> str:
    moment = datetime.fromtimestamp(round(epoch, 3), tz=timezone.utc)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


# ---- report validation ------------------------------------------------------


def _text(obj: dict, key: str, limit: int, *, name: str | None = None, optional: bool = False):
    label = name or key
    value = obj.get(key)
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise ReportError(f"{label} must be a string")
    if len(value) > limit:
        raise ReportError(f"{label} is longer than {limit} characters")
    return value


def _count(obj: dict, key: str, label: str) -> int:
    value = obj.get(key)
    if type(value) is not int or value < 0:
        raise ReportError(f"{label} must be a non-negative integer")
    return value


def _flag(obj: dict, key: str, label: str) -> bool:
    value = obj.get(key)
    if not isinstance(value, bool):
        raise ReportError(f"{label} must be true or false")
    return value


def _object(obj: dict, key: str) -> dict | None:
    value = obj.get(key)
    if value is not None and not isinstance(value, dict):
        raise ReportError(f"{key} must be an object or null")
    return value


def _last_prompt(raw: dict | None) -> dict | None:
    if raw is None:
        return None
    text = raw.get("text")
    if not isinstance(text, str):
        raise ReportError("lastPrompt.text must be a string")
    parse_time(raw.get("at"))
    return {"text": text[: LIMITS["prompt"]], "at": raw["at"]}


def _last_answer(raw: dict | None) -> dict | None:
    if raw is None:
        return None
    tail = raw.get("tail")
    if not isinstance(tail, list) or not all(isinstance(line, str) for line in tail):
        raise ReportError("lastAnswer.tail must be an array of strings")
    parse_time(raw.get("at"))
    kept = [line[: LIMITS["tail_line"]] for line in tail[-LIMITS["tail_lines"]:]]
    return {"tail": kept, "at": raw["at"]}


def _ecc_prd(raw: dict | None) -> dict | None:
    if raw is None:
        return None
    milestones = raw.get("inProgress")
    if (
        not isinstance(milestones, list)
        or len(milestones) > LIMITS["milestones"]
        or not all(isinstance(m, str) and 0 < len(m) <= LIMITS["milestone"] for m in milestones)
    ):
        raise ReportError("ecc.prd.inProgress must be an array of short phase numbers as strings")
    return {
        "title": _text(raw, "title", LIMITS["title"], name="ecc.prd.title"),
        "done": _count(raw, "done", "ecc.prd.done"),
        "total": _count(raw, "total", "ecc.prd.total"),
        "inProgress": list(milestones),
    }


def _ecc_plan(raw: dict | None) -> dict | None:
    if raw is None:
        return None
    return {
        "name": _text(raw, "name", LIMITS["title"], name="ecc.plan.name"),
        "done": _count(raw, "done", "ecc.plan.done"),
        "total": _count(raw, "total", "ecc.plan.total"),
        "isArchived": _flag(raw, "isArchived", "ecc.plan.isArchived"),
    }


def _ecc(raw: dict | None) -> dict | None:
    if raw is None:
        return None
    for key in ("prd", "plan"):
        if raw.get(key) is not None and not isinstance(raw[key], dict):
            raise ReportError(f"ecc.{key} must be an object or null")
    return {
        "prd": _ecc_prd(raw.get("prd")),
        "plan": _ecc_plan(raw.get("plan")),
        "phase": _text(raw, "phase", LIMITS["phase"], name="ecc.phase", optional=True),
        "isActive": _flag(raw, "isActive", "ecc.isActive"),
    }


def parse_report(body: bytes) -> dict:
    """Validate a POSTed report and return a new, normalized dict."""
    try:
        raw = json.loads(body)
    except (ValueError, RecursionError) as error:  # bad JSON or UTF-8, huge numbers, deep nesting
        raise ReportError(f"body is not JSON ({type(error).__name__})") from None
    if not isinstance(raw, dict):
        raise ReportError("body must be a JSON object")
    version = raw.get("v")
    if type(version) is not int or version != CONTRACT_VERSION:
        raise ReportError(f"v must be {CONTRACT_VERSION}, got {version!r}")
    if raw.get("state") not in STATES:
        raise ReportError(f"state must be one of {', '.join(STATES)}, got {raw.get('state')!r}")
    parse_time(raw.get("since"))
    parse_time(raw.get("sentAt"))
    report = {
        "v": CONTRACT_VERSION,
        "host": _text(raw, "host", LIMITS["host"]),
        "cwd": _text(raw, "cwd", LIMITS["cwd"]),
        "project": _text(raw, "project", LIMITS["project"]),
        "state": raw["state"],
        "since": raw["since"],
        "sentAt": raw["sentAt"],
        "detail": _text(raw, "detail", LIMITS["detail"], optional=True),
        "lastPrompt": _last_prompt(_object(raw, "lastPrompt")),
        "lastAnswer": _last_answer(_object(raw, "lastAnswer")),
        "ecc": _ecc(_object(raw, "ecc")),
    }
    try:  # JSON allows lone surrogates (\ud800), which cannot be written back out as UTF-8
        json.dumps(report, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        raise ReportError("strings must be valid Unicode (no lone surrogates)") from None
    return report


# ---- board state ------------------------------------------------------------


@dataclass(frozen=True)
class Entry:
    session_id: str
    report: dict
    received_at: float
    waiting_since: float  # `since` moved onto the server clock


def is_state_change(prev: Entry | None, entry: Entry) -> bool:
    if prev is None:
        return True
    return prev.report["state"] != entry.report["state"] or prev.report["since"] != entry.report["since"]


def record_line(prev: Entry | None, entry: Entry) -> dict:
    """One --record line; both durations use only the reporter's own clock."""
    report = entry.report
    since = parse_time(report["since"])
    line = {
        "ts": format_time(entry.received_at),
        "sessionId": entry.session_id,
        "host": report["host"],
        "project": report["project"],
        "from": prev.report["state"] if prev else None,
        "to": report["state"],
        "since": report["since"],
        "sentAt": report["sentAt"],
        "receivedAt": format_time(entry.received_at),
        "reportDelayS": round(parse_time(report["sentAt"]) - since, 1),
    }
    if prev is not None and prev.report["state"] == "needs-approval":
        line["waitS"] = round(since - parse_time(prev.report["since"]), 1)
    return line


class Board:
    """Latest report per session, ordered so the sessions waiting on you come first."""

    def __init__(self, clock=time.time, record=None):
        self._clock = clock
        self._record = record
        self._lock = threading.Lock()
        self._entries: dict[str, Entry] = {}

    def accept(self, session_id: str, report: dict) -> None:
        with self._lock:
            now = self._clock()
            skew = now - parse_time(report["sentAt"])
            entry = Entry(session_id, report, now, parse_time(report["since"]) + skew)
            prev = self._entries.get(session_id)
            self._entries = {**self._entries, session_id: entry}
            if self._record is not None and is_state_change(prev, entry):
                self._record(record_line(prev, entry))

    def snapshot(self) -> dict:
        with self._lock:
            now = self._clock()
            self._entries = {sid: e for sid, e in self._entries.items() if not _expired(e, now)}
            entries = list(self._entries.values())
        rows = sorted((_row(e, now) for e in entries), key=lambda row: row[0])
        return {"v": CONTRACT_VERSION, "now": format_time(now), "sessions": [s for _, s in rows]}


def _expired(entry: Entry, now: float) -> bool:
    age = now - entry.received_at
    if entry.report["state"] == "ended":
        return age > ENDED_RETAIN_S
    return age > LOST_RETAIN_S


def _row(entry: Entry, now: float) -> tuple[tuple[int, float], dict]:
    state = entry.report["state"]
    is_lost = state != "ended" and now - entry.received_at > LOST_AFTER_S
    if state == "ended":
        group = ENDED_ORDER
    elif is_lost:
        group = LOST_ORDER
    else:
        group = STATE_ORDER[state]
    session = {
        **entry.report,
        "sessionId": entry.session_id,
        "receivedAt": format_time(entry.received_at),
        "waitingSince": format_time(entry.waiting_since),
        "isLost": is_lost,
    }
    return (group, entry.waiting_since), session


# ---- HTTP -------------------------------------------------------------------


def make_handler(
    board: Board, token: str, web_dir: Path = WEB_DIR, verbose: bool = False,
    timeout_s: float = REQUEST_TIMEOUT_S,
):
    """A request handler class bound to one board and one token."""
    expected = token.encode("utf-8")
    token_forms = {token, quote(token, safe=""), quote_plus(token)}

    class Handler(BaseHTTPRequestHandler):
        server_version = "session-board/1"
        timeout = timeout_s  # a client that stops sending mid-body cannot hold a thread forever

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/healthz":
                self._send(200, b"ok", "text/plain; charset=utf-8")
            elif not self._authorized():
                self._send_text(401, "unauthorized")
            elif path == "/api/sessions":
                self._send_json(200, board.snapshot())
            elif path in ("/", "/index.html"):
                self._send_page()
            else:
                self._send_text(404, "not found")

        def do_POST(self) -> None:
            match = SESSION_PATH.match(urlsplit(self.path).path)
            if not match or not SESSION_ID.match(match[1]):
                self._send_text(404, "not found")
                return
            if not self._authorized():
                self._discard_body()
                self._send_text(401, "unauthorized")
                return
            length = self._content_length()
            if length is None:
                self._discard_body()
                self._send_text(413, f"body must be 1 to {MAX_BODY_BYTES} bytes with a Content-Length")
                return
            body = self._read(length)
            if body is None:
                return
            try:
                report = parse_report(body)
            except ReportError as error:
                self._send_text(400, str(error))
                return
            board.accept(match[1], report)
            self.send_response(204)
            self.end_headers()

        def log_message(self, format: str, *args) -> None:
            if verbose:
                line = format % args
                for form in token_forms:
                    line = line.replace(form, "***")
                sys.stderr.write(f"{self.address_string()} {line}\n")

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            if header.startswith("Bearer "):
                given = header[len("Bearer "):].strip()
            else:
                given = (parse_qs(urlsplit(self.path).query).get("token") or [""])[0]
            return hmac.compare_digest(given.encode("utf-8"), expected)

        def _declared_length(self) -> int | None:
            text = self.headers.get("Content-Length", "")
            return int(text) if text.isascii() and text.isdigit() else None

        def _content_length(self) -> int | None:
            length = self._declared_length()
            return length if length is not None and 0 < length <= MAX_BODY_BYTES else None

        def _discard_body(self) -> None:
            length = self._declared_length()
            if length is not None and 0 < length <= MAX_DRAIN_BYTES:
                self._read(length)

        def _read(self, length: int) -> bytes | None:
            """The body, or None after a timeout or a short body; the connection is then dropped."""
            try:
                body = self.rfile.read(length)
            except OSError:  # includes TimeoutError
                body = b""
            if len(body) == length:
                return body
            self.close_connection = True
            return None

        def _send_page(self) -> None:
            try:
                page = (web_dir / "index.html").read_bytes()
            except OSError:
                self._send_text(404, "board page is missing")
                return
            self._send(200, page, "text/html; charset=utf-8")

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send(status, body, "application/json; charset=utf-8")

        def _send_text(self, status: int, text: str) -> None:
            self._send(status, text.encode("utf-8"), "text/plain; charset=utf-8")

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    return Handler


# ---- command line -----------------------------------------------------------


def local_addresses() -> list[str]:
    """IPv4 addresses of this machine, loopback first, found with the standard library only."""
    found = [LOOPBACK]
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        found += [info[4][0] for info in infos]
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(PROBE_ADDRESS)
            found.append(probe.getsockname()[0])
    except OSError:
        pass
    return list(dict.fromkeys(a for a in found if a != "0.0.0.0"))


def board_urls(host: str, port: int, token: str) -> list[str]:
    """Every URL the board can be opened at: all local addresses when listening on all interfaces."""
    hosts = local_addresses() if host in ALL_INTERFACES else [host]
    return [f"http://{h}:{port}/?token={token}" for h in hosts]


class RecordFile:
    """Appends --record lines; a write failure is reported once and never fails a report."""

    def __init__(self, path: Path):
        self._file = path.open("a", encoding="utf-8", buffering=1)
        self._has_failed = False

    def __call__(self, line: dict) -> None:
        try:
            self._file.write(json.dumps(line, ensure_ascii=False) + "\n")
        except (OSError, ValueError) as error:
            if not self._has_failed:
                print(f"error: cannot write the record file ({error})", file=sys.stderr)
                self._has_failed = True

    def close(self) -> None:
        self._file.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"address to listen on (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port (default: {DEFAULT_PORT})")
    parser.add_argument("--token", help=f"access token (default: ${TOKEN_ENV}, else a random one)")
    parser.add_argument("--record", type=Path, help="append every state change to this JSONL file")
    parser.add_argument("--verbose", action="store_true", help="log each request to stderr")
    args = parser.parse_args(argv)
    token = args.token or os.environ.get(TOKEN_ENV) or secrets.token_urlsafe(16)

    try:
        record = RecordFile(args.record) if args.record else None
    except OSError as error:
        print(f"error: cannot open the record file {args.record} ({error})", file=sys.stderr)
        return 2
    board = Board(record=record)
    try:
        server = ThreadingHTTPServer((args.host, args.port), make_handler(board, token, WEB_DIR, args.verbose))
    except OSError as error:
        print(f"error: cannot listen on {args.host}:{args.port} ({error})", file=sys.stderr)
        return 2

    print(f"session-board listening on {args.host}:{server.server_address[1]}  (Ctrl-C to stop)")
    for url in board_urls(args.host, server.server_address[1], token):
        print(f"  {url}")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if record is not None:
            record.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
