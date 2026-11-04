#!/usr/bin/env python3
"""Check a board's --record file against the session-board success metrics.

    board.py --host 0.0.0.0 --record states.jsonl     # run for a day
    metrics.py states.jsonl
    metrics.py states.jsonl --json

Waits and report delays use only each reporter's own clock (see the contract's
Record file section), so they compare across machines. Python 3.10+ standard library only.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

APPROVAL_MEDIAN_TARGET_S = 60
REPORT_DELAY_TARGET_S = 1.0  # plus the page's 2 s poll keeps the wall within 3 s
PEAK_SESSIONS_TARGET = 10
PEAK_HOSTS_TARGET = 2
MINUTES_FROM_S = 120


def parse_time(text: str) -> float:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp()


def load(path: Path) -> tuple[list[dict], int]:
    """The record lines that parse, and how many did not."""
    lines, bad = [], 0
    with path.open(encoding="utf-8") as file:
        for raw in file:
            if not raw.strip():
                continue
            try:
                line = json.loads(raw)
                parse_time(line["ts"])
                if not isinstance(line.get("sessionId"), str):
                    raise ValueError("no sessionId")
            except (ValueError, KeyError, TypeError, AttributeError):
                bad += 1
                continue
            lines.append(line)
    return lines, bad


def percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile; None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[rank - 1]


def stats(values: list[float], p: int) -> dict:
    return {
        "count": len(values),
        "median": percentile(values, 50),
        f"p{p}": percentile(values, p),
        "max": max(values) if values else None,
    }


def numbers(lines: list[dict], key: str) -> list[float]:
    return [float(line[key]) for line in lines if isinstance(line.get(key), (int, float))]


def transitions(lines: list[dict]) -> list[dict]:
    """Lines for a real state change. A session's first line (from is null) is left out: its
    since can predate the board, for example after a board restart, so its delay is not latency."""
    return [line for line in lines if line.get("from") is not None]


def peak_concurrency(lines: list[dict]) -> dict:
    """Most sessions online at once, counting each from its first to its last record line.

    Heartbeats and going lost write no lines, so this is a lower bound.
    """
    spans: dict[str, tuple[float, float, str | None]] = {}
    for line in lines:
        ts = parse_time(line["ts"])
        start, end, host = spans.get(line["sessionId"], (ts, ts, line.get("host")))
        spans[line["sessionId"]] = (min(start, ts), max(end, ts), host)
    # At equal times starts (0) sort before ends (1), so touching spans count as overlapping.
    events = sorted([(start, 0, sid) for sid, (start, _, _) in spans.items()]
                    + [(end, 1, sid) for sid, (_, end, _) in spans.items()])
    online: set[str] = set()
    best = {"sessions": 0, "hosts": 0, "at": None}
    for ts, kind, sid in events:
        if kind == 1:
            online.discard(sid)
            continue
        online.add(sid)
        if len(online) > best["sessions"]:
            best = {"sessions": len(online), "hosts": len({spans[s][2] for s in online}), "at": ts}
    return best


def verdict(value: float | None, ok: bool) -> str | None:
    return None if value is None else ("pass" if ok else "fail")


def summarize(lines: list[dict], bad: int = 0) -> dict:
    times = [parse_time(line["ts"]) for line in lines]
    approval = stats(numbers(lines, "waitS"), 90)
    delays = numbers(transitions(lines), "reportDelayS")
    delay = {**stats(delays, 95), "overTarget": sum(1 for d in delays if d > REPORT_DELAY_TARGET_S)}
    peak = peak_concurrency(lines)
    peak_ok = peak["sessions"] >= PEAK_SESSIONS_TARGET and peak["hosts"] >= PEAK_HOSTS_TARGET
    # A lower bound below the target proves nothing, so it reads as "check by eye", never "fail".
    peak_result = "pass" if peak_ok else None
    return {
        "from": min(times) if times else None,
        "to": max(times) if times else None,
        "hosts": len({line.get("host") for line in lines}),
        "sessions": len({line["sessionId"] for line in lines}),
        "changes": len(lines),
        "badLines": bad,
        "approval": {**approval, "result": verdict(approval["median"], (approval["median"] or 0) <= APPROVAL_MEDIAN_TARGET_S)},
        "reportDelay": {**delay, "result": verdict(delay["p95"], (delay["p95"] or 0) <= REPORT_DELAY_TARGET_S)},
        "peak": {**peak, "result": peak_result},
    }


# ---- text output -------------------------------------------------------------

MARKS = {"pass": "✓", "fail": "✗", None: "没有数据"}


def seconds(value: float | None) -> str:
    if value is None:
        return "-"
    if value >= MINUTES_FROM_S:
        return f"{value / 60:.1f} 分钟"
    return f"{value:.1f} 秒"


def local(ts: float | None, fmt: str = "%Y-%m-%d %H:%M") -> str:
    return "-" if ts is None else datetime.fromtimestamp(ts).strftime(fmt)


def heading(title: str, mark: str) -> str:
    return f"{title}   {mark}"


def render(summary: dict) -> str:
    hours = (summary["to"] - summary["from"]) / 3600 if summary["from"] is not None else 0
    a, d, p = summary["approval"], summary["reportDelay"], summary["peak"]
    out = [
        f"记录  {local(summary['from'])} → {local(summary['to'], '%H:%M')}（{hours:.1f} 小时），"
        f"{summary['hosts']} 台机器，{summary['sessions']} 个会话，{summary['changes']} 次状态变化",
    ]
    if summary["badLines"]:
        out.append(f"跳过 {summary['badLines']} 行无法解析的记录")
    out += [
        "",
        heading(f"等批准时长（目标：中位数 ≤ {APPROVAL_MEDIAN_TARGET_S} 秒）", MARKS[a["result"]]),
        f"  次数 {a['count']}   中位数 {seconds(a['median'])}   P90 {seconds(a['p90'])}   最长 {seconds(a['max'])}",
        "",
        heading(f"上报延迟（目标：上报 ≤ {REPORT_DELAY_TARGET_S:g} 秒，加页面轮询 2 秒，大屏 ≤ 3 秒）", MARKS[d["result"]]),
        f"  次数 {d['count']}   中位数 {seconds(d['median'])}   P95 {seconds(d['p95'])}   最长 {seconds(d['max'])}"
        f"   超过 {REPORT_DELAY_TARGET_S:g} 秒 {d['overTarget']} 次",
        "",
        heading(f"规模（目标：{PEAK_HOSTS_TARGET} 台机器、{PEAK_SESSIONS_TARGET} 个会话同时在线）",
                MARKS["pass"] if p["result"] == "pass" else "目测核对"),
        f"  同时在线至少 {p['sessions']} 个会话（{p['hosts']} 台机器），在 {local(p['at'], '%H:%M')}"
        "（心跳不写记录，这是下限）",
        "",
        heading("失联（目标：异常退出后 ≤ 30 秒标为失联）", "手动核对"),
        "  关掉一个终端窗口，看大屏上的卡片多久变成失联",
    ]
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("record", type=Path, help="the JSONL file written by board.py --record")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    args = parser.parse_args(argv)
    try:
        lines, bad = load(args.record)
    except (OSError, UnicodeDecodeError) as error:
        print(f"error: cannot read {args.record}: {error}", file=sys.stderr)
        return 2
    summary = summarize(lines, bad)
    print(json.dumps(summary, ensure_ascii=False, indent=2) if args.json else render(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
