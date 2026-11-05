#!/usr/bin/env python3
"""Push ten made-up sessions to a running board, for developing and checking the wall page.

    board.py --token t &
    demo.py --token t                          # http://127.0.0.1:7777, heartbeat every 5 s
    demo.py --url http://192.168.0.226:7777 --token t --once

The mix matches the design: 2 waiting for approval, 2 your turn, 4 working, 1 lost
(reported once, so the board marks it lost after 30 s) and 1 ended.
Python 3.10+ standard library only. Ctrl-C to stop.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_URL = "http://127.0.0.1:7777"
TOKEN_ENV = "SESSION_BOARD_TOKEN"
HEARTBEAT_S = 5
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # ignore http_proxy


def ecc(prd: tuple[int, int, list[str]] | None, plan: tuple[int, int] | None, phase: str | None = None) -> dict:
    return {
        "prd": {"title": "Demo PRD", "done": prd[0], "total": prd[1], "inProgress": prd[2]} if prd else None,
        "plan": {"name": "Demo plan", "done": plan[0], "total": plan[1], "isArchived": False} if plan else None,
        "phase": phase,
        "isActive": phase is not None,
    }


# (sessionId, host, cwd, state, seconds in state, detail, prompt, answer tail, ecc, keeps heartbeating)
SESSIONS = [
    ("demo-ai-video", "mac-mini", "/Users/demo/Development/ai/ai-video-platform", "needs-approval", 401,
     "Bash: pnpm test --filter storyboard", "实现分镜导出：每段 H3 提示词加分镜图清单，跑完测试再提交", None,
     ecc((3, 8, ["4"]), (7, 14), "VALIDATE"), True),
    ("demo-lancekit", "mac-mini", "/Users/demo/Development/git/lancekit", "needs-approval", 78,
     "Write: plugins/session-board/hooks/register.tsx", "按计划执行 phase 2：会话上报 mod，状态变化即时上报加心跳", None,
     ecc((1, 4, ["2", "3"]), (2, 6), "EXECUTE"), True),
    ("demo-novel-skills", "macbook", "/Users/demo/work/novel-skills", "your-turn", 725,
     None, "给分镜加 H3 投产包导出",
     ["跑了 18 道质量门。", "", "18 道质量门全部通过。", "报告已写到 out/storyboard/report.html。", "要我接着导出 H3 投产包吗？"],
     None, True),
    ("demo-homelab", "macbook", "/Users/demo/homelab", "your-turn", 232,
     None, "检查 Pi-hole 的上游 DNS 配置",
     ["上游已切到 1.1.1.1 和 9.9.9.9。", "DNSSEC 已打开。", "要不要顺便把 VLAN 30 的 DHCP 也指过来？"],
     ecc((2, 5, ["3"]), (4, 4)), True),
    ("demo-chatlog", "mac-mini", "/Users/demo/Development/git/chatlog", "working", 492,
     None, "给 HTML 导出加按日期筛选", None, ecc((2, 5, ["3"]), (4, 9), "EXECUTE"), True),
    ("demo-pen-plugins", "mac-mini", "/Users/demo/Development/git/pen-plugins", "working", 330,
     None, "修复 Generate 失败后的重试逻辑", None, None, True),
    ("demo-ai-video-mb", "macbook", "/Users/demo/Development/ai/ai-video-platform", "working", 167,
     None, "把角色参考图改成按需分档出图", None, ecc((3, 8, ["4"]), (2, 11), "EXECUTE"), True),
    ("demo-dotfiles", "macbook", "/Users/demo/dotfiles", "working", 40,
     None, "整理 fish 的 abbr，删掉不用的", None, None, True),
    ("demo-scratch", "macbook", "/Users/demo/scratch", "working", 900,
     None, "试一下 ThreadingHTTPServer 的超时", None, None, False),
    ("demo-notes", "mac-mini", "/Users/demo/notes", "ended", 420,
     None, "总结本周的会话记录", None, None, False),
]

# Names given with /session-board name: two sessions in the same project, told apart.
NAMES = {"demo-ai-video": "分镜导出", "demo-ai-video-mb": "角色参考图"}


def iso(seconds: float) -> str:
    stamp = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{stamp.microsecond // 1000:03d}Z"


def build_reports(now: float) -> list[tuple[str, dict, bool]]:
    """(sessionId, report body, keeps heartbeating) for every demo session."""
    reports = []
    for sid, host, cwd, state, age, detail, prompt, tail, progress, heartbeat in SESSIONS:
        since = now - age
        body = {
            "v": 1, "host": host, "cwd": cwd, "project": cwd.rstrip("/").rsplit("/", 1)[-1],
            "name": NAMES.get(sid),
            "state": state, "since": iso(since), "sentAt": iso(now), "detail": detail,
            "lastPrompt": {"text": prompt, "at": iso(since - 30)} if prompt else None,
            "lastAnswer": {"tail": tail, "at": iso(since)} if tail else None,
            "ecc": progress,
        }
        reports.append((sid, body, heartbeat))
    return reports


def post(base: str, token: str, sid: str, body: dict) -> int:
    request = urllib.request.Request(
        f"{base}/api/sessions/{sid}",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with DIRECT.open(request, timeout=5) as response:
        return response.status


def send_all(base: str, token: str, reports: list[tuple[str, dict, bool]], now: float) -> None:
    for sid, body, _ in reports:
        status = post(base, token, sid, {**body, "sentAt": iso(now)})
        if status != 204:
            raise RuntimeError(f"{sid}: HTTP {status}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=DEFAULT_URL, help=f"board address (default: {DEFAULT_URL})")
    parser.add_argument("--token", default=os.environ.get(TOKEN_ENV), help=f"board token (default: ${TOKEN_ENV})")
    parser.add_argument("--once", action="store_true", help="report once and exit instead of heartbeating")
    args = parser.parse_args(argv)
    if not args.token:
        parser.error(f"--token or ${TOKEN_ENV} is required")
    base = args.url.rstrip("/")

    reports = build_reports(time.time())
    try:
        send_all(base, args.token, reports, time.time())
        print(f"sent {len(reports)} sessions to {base}" + ("" if args.once else f"; heartbeat every {HEARTBEAT_S} s, Ctrl-C to stop"))
        if args.once:
            return 0
        alive = [r for r in reports if r[2]]
        while True:
            time.sleep(HEARTBEAT_S)
            send_all(base, args.token, alive, time.time())
    except KeyboardInterrupt:
        return 0
    except (urllib.error.URLError, OSError, RuntimeError) as error:
        print(f"error: cannot report to {base}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
