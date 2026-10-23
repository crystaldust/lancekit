#!/usr/bin/env python3
"""Replay a chatlog JSONL in a terminal the way Claude Code drew the session.

    chatlog_replay.py                       # the most recent log under ./.claude/chatlog
    chatlog_replay.py 2                     # the second most recent
    chatlog_replay.py path/to/log.jsonl     # a given log (.md / .txt beside it work too)
    chatlog_replay.py --list                # list logs
    chatlog_replay.py --play [--speed 4]    # replay with the original pacing, sped up
    chatlog_replay.py --follow              # keep printing as the live session writes

Pipe through `less -R` to page with colors.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import textwrap
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DIR = Path(".claude/chatlog")
GUTTER = "  "
MAX_PLAY_GAP_S = 3.0
FOLLOW_POLL_S = 0.5

TURN_NOTES = {
    "aborted": "Interrupted by user",
    "error": "Turn ended with an error",
    "refusal": "Claude declined to answer",
}
ACTION_LABELS = {
    "start": "started",
    "resume": "resumed",
    "clear": "started after /clear",
    "compact": "compacted",
    "fork": "forked",
}


@dataclass(frozen=True)
class Style:
    """ANSI styles; every field is empty when color is off."""

    reset: str = ""
    bold: str = ""
    dim: str = ""
    green: str = ""
    red: str = ""
    cyan: str = ""
    prompt_bg: str = ""

    @staticmethod
    def make(enabled: bool) -> "Style":
        if not enabled:
            return Style()
        return Style(
            reset="\033[0m",
            bold="\033[1m",
            dim="\033[2m",
            green="\033[32m",
            red="\033[31m",
            cyan="\033[36m",
            prompt_bg="\033[48;5;236m",
        )


def local_time(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()


def parse_events(text: str) -> list[dict]:
    events = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and isinstance(event.get("kind"), str):
            events.append(event)
    return events


def inline_markdown(line: str, style: Style) -> str:
    line = re.sub(r"\*\*(.+?)\*\*", lambda m: f"{style.bold}{m.group(1)}{style.reset}", line)
    return re.sub(r"`([^`]+)`", lambda m: f"{style.cyan}{m.group(1)}{style.reset}", line)


def wrap(text: str, width: int, first: str, rest: str) -> list[str]:
    """Wraps each source line to the width, the first line after `first`, the others after `rest`."""
    out: list[str] = []
    for index, source in enumerate(text.split("\n")):
        lead = first if index == 0 else rest
        pieces = textwrap.wrap(source, width=max(10, width - len(rest)), replace_whitespace=False) or [""]
        out.extend(f"{lead if i == 0 else rest}{piece}" for i, piece in enumerate(pieces))
    return out


def render_markdown(text: str, width: int, style: Style) -> list[str]:
    """A light terminal rendering of the model's Markdown: headings bold, code dim, inline marks styled."""
    lines: list[str] = []
    in_code = False
    for index, raw in enumerate(text.split("\n")):
        lead = "⏺ " if index == 0 else GUTTER
        if raw.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            lines.append(f"{lead}{style.dim}{raw}{style.reset}")
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", raw)
        if heading:
            lines.append(f"{lead}{style.bold}{heading.group(2)}{style.reset}")
            continue
        for i, piece in enumerate(wrap(raw, width, "", "") or [""]):
            lines.append(f"{lead if i == 0 else GUTTER}{inline_markdown(piece, style)}")
    return lines


def result_lines(event: dict) -> list[str]:
    preview = event.get("preview") or ["(no output)"]
    lines = [
        f"⎿  {'Error: ' if event.get('isError') else ''}{line}" if i == 0 else f"   {line}"
        for i, line in enumerate(preview)
    ]
    more = int(event.get("totalLines", 0)) - len(event.get("preview") or [])
    return lines + ([f"   … +{more} lines"] if more > 0 else [])


def render_event(event: dict, width: int, style: Style) -> list[str]:
    kind = event["kind"]
    when = local_time(event["ts"])
    stamp = when.strftime("%H:%M:%S")
    if kind == "session":
        label = ACTION_LABELS.get(event.get("action", ""), event.get("action", ""))
        session = str(event.get("sessionId", ""))[:8]
        return ["", f"{style.dim}── {when:%Y-%m-%d %H:%M:%S %z} · session {label} · {session} ──{style.reset}"]
    if kind == "end":
        return ["", f"{style.dim}── {stamp} · session ended ({event.get('reason', '')}) ──{style.reset}", ""]
    if kind == "user":
        via = f" · {event['via']}" if event.get("via") else ""
        body = [f"{style.prompt_bg}{line}{style.reset}" for line in wrap(event["text"], width, "> ", "  ")]
        return ["", *body, f"{style.dim}{GUTTER}{stamp}{via}{style.reset}"]
    if kind == "assistant":
        return ["", *render_markdown(event["text"], width, style)]
    if kind == "tool":
        return ["", f"{style.green}⏺{style.reset} {style.bold}{event['name']}{style.reset}({event.get('summary', '')})"]
    if kind == "result":
        color = style.red if event.get("isError") else style.dim
        return [f"{color}{GUTTER}{line}{style.reset}" for line in result_lines(event)]
    if kind == "turn":
        note = TURN_NOTES.get(event.get("reason", ""))
        return [f"{style.red}{GUTTER}⎿  {note}{style.reset}"] if note else []
    if kind == "note":
        return ["", f"{style.dim}· {event.get('text', '')} · {stamp}{style.reset}"]
    return []


def list_logs(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(folder.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)


def resolve(target: str | None, folder: Path) -> Path:
    if target and not target.isdigit():
        path = Path(target)
        if path.suffix in (".md", ".txt"):
            path = path.with_suffix(".jsonl")
        if path.exists():
            return path
        matches = [log for log in list_logs(folder) if target in log.name]
        if matches:
            return matches[0]
        raise SystemExit(f"chatlog: no log matches {target!r}")
    logs = list_logs(folder)
    index = int(target) - 1 if target else 0
    if not 0 <= index < len(logs):
        raise SystemExit(f"chatlog: no log #{index + 1} under {folder} ({len(logs)} found)")
    return logs[index]


def emit(lines: list[str]) -> None:
    for line in lines:
        print(line)
    sys.stdout.flush()


def replay(events: list[dict], width: int, style: Style, speed: float | None) -> None:
    previous: datetime | None = None
    for event in events:
        if speed and previous is not None:
            gap = (local_time(event["ts"]) - previous).total_seconds() / speed
            time.sleep(min(max(gap, 0.0), MAX_PLAY_GAP_S))
        previous = local_time(event["ts"])
        emit(render_event(event, width, style))


def follow(path: Path, width: int, style: Style) -> None:
    seen = 0
    while True:
        lines = path.read_text(encoding="utf-8").splitlines()
        emit([line for event in parse_events("\n".join(lines[seen:])) for line in render_event(event, width, style)])
        seen = len(lines)
        time.sleep(FOLLOW_POLL_S)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay a Claude Code chatlog in terminal style.")
    parser.add_argument("target", nargs="?", help="log number from --list, a name fragment, or a path")
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="chatlog folder (default: .claude/chatlog)")
    parser.add_argument("--list", action="store_true", help="list logs, most recent first")
    parser.add_argument("--play", action="store_true", help="replay with the session's own pacing")
    parser.add_argument("--speed", type=float, default=4.0, help="speed-up for --play (default 4x)")
    parser.add_argument("--follow", action="store_true", help="keep printing new events as they are written")
    parser.add_argument("--no-color", action="store_true", help="plain text, no ANSI colors")
    args = parser.parse_args(argv)

    if args.list:
        logs = list_logs(args.dir)
        if not logs:
            print(f"No chatlogs under {args.dir}")
        for number, log in enumerate(logs, start=1):
            modified = datetime.fromtimestamp(log.stat().st_mtime, tz=timezone.utc).astimezone()
            print(f"{number:>3}. {log.stem}   (last written {modified:%Y-%m-%d %H:%M})")
        return 0

    path = resolve(args.target, args.dir)
    color = not args.no_color and sys.stdout.isatty() and "NO_COLOR" not in os.environ
    style = Style.make(color)
    width = shutil.get_terminal_size((100, 24)).columns
    try:
        if args.follow:
            follow(path, width, style)
        else:
            replay(parse_events(path.read_text(encoding="utf-8")), width, style, args.speed if args.play else None)
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
