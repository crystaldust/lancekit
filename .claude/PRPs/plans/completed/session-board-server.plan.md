# Plan: 会话状态契约与看板服务（session-board Phase 1）

## Summary
定下 session-board 上报端和看板之间唯一的数据契约，并实现一个零依赖的 Python 看板服务 `board.py`。

服务负责：
- 接收各会话用 HTTP 推送的状态，校验令牌和格式。
- 按服务器时钟判定失联，按"谁在等我"排序后，通过 `GET /api/sessions` 提供给大屏页面。
- 把每次状态变化追加到一个可选的 JSONL 记录文件，供 Phase 4 统计成功指标。

这个阶段只放一个占位页面，正式的大屏页面在 Phase 3 做。

## User Story
作为同时开约 10 个 Claude Code 会话的开发者，我想要一个能汇总局域网内所有会话状态的本地服务，这样大屏页面和每个会话的上报插件都有一个稳定的对接点。

## Problem → Solution
各会话的状态只能在各自的终端里看到 → 一个服务按统一契约收集所有会话的状态，并按等待优先排好序提供出去。

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/session-board.prd.md`
- **PRD Phase**: 1 状态契约与看板服务
- **Estimated Files**: 4（契约文档、服务脚本、测试、占位页面）

---

## UX Design

### Before
```
┌────────────┐ ┌────────────┐ ┌────────────┐
│ Ghostty #1 │ │ Ghostty #2 │ │  … #10     │   逐个切 tab 看状态
└────────────┘ └────────────┘ └────────────┘
```

### After（本阶段）
```
$ python3 plugins/session-board/scripts/board.py --host 0.0.0.0
session-board on http://192.168.1.20:7777/?token=Xy…  (Ctrl-C to stop)

curl -H 'Authorization: Bearer Xy…' http://192.168.1.20:7777/api/sessions
→ {"v":1,"now":"…","sessions":[{等批准的会话}, {轮到你的会话}, {工作中}, …]}
```
大屏页面在 Phase 3，本阶段的占位页面只把 `GET /api/sessions` 的结果列成表格，用于验证服务。

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 启动看板 | 无 | `board.py [--host] [--port] [--token] [--record]` | 默认只监听 127.0.0.1 |
| 打开看板 | 无 | 浏览器打开启动时打印的 `/?token=…` 地址 | 没有令牌返回 401 |
| 会话上报 | 无 | `POST /api/sessions/<sessionId>` | 上报端在 Phase 2 实现 |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `.claude/PRPs/prds/session-board.prd.md` | all | 需求、指标、决策 |
| P0 | `plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py` | 1-40, 200-230 | 脚本结构：模块文档字符串、常量、`dataclass(frozen=True)`、`main(argv)` 返回退出码 |
| P0 | `plugins/chatlog/scripts/test_chatlog_replay.py` | 1-40 | 测试和脚本放在同一目录的写法、`sys.path.insert`、模块常量做样例数据 |
| P1 | `plugins/chatlog/scripts/chatlog_replay.py` | 1-50 | `from __future__ import annotations`、带用法示例的文档字符串、`Path` 常量 |
| P1 | `plugins/ecc-progress/types/index.d.ts` | all | ECC 进度的来源结构，契约里的 `ecc` 字段由它压缩而来 |
| P2 | `docs/ecc-doc-formats.md` | all | 仓库里契约文档的写法和语气 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `http.server` | https://docs.python.org/3/library/http.server.html | 用 `ThreadingHTTPServer` 加 `BaseHTTPRequestHandler`；覆盖 `log_message` 关闭逐条访问日志 |
| 常量时间比较 | https://docs.python.org/3/library/hmac.html#hmac.compare_digest | 用 `hmac.compare_digest` 比较令牌 |
| 随机令牌 | https://docs.python.org/3/library/secrets.html | `secrets.token_urlsafe(16)` |

KEY_INSIGHT: Python 3.10 的 `datetime.fromisoformat` 不认识结尾的 `Z`。
APPLIES_TO: 时间字段的解析。
GOTCHA: README 写的是 Python 3.10+，所以用 `datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ")` 解析，不要用 `fromisoformat`。

KEY_INSIGHT: `ThreadingHTTPServer(("127.0.0.1", 0), …)` 由系统分配空闲端口，`server.server_address[1]` 读出实际端口。
APPLIES_TO: 集成测试。
GOTCHA: 测试结束要调用 `shutdown()` 和 `server_close()`，否则端口和线程会泄漏。

---

## Patterns to Mirror

### NAMING_CONVENTION
```python
# SOURCE: plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py:18-34
VALID_STATUSES = ("pending", "in-progress", "complete")
PRD_GLOBS = (".claude/prds/**/*.prd.md", ".claude/PRPs/prds/**/*.prd.md")


@dataclass(frozen=True)
class Finding:
    level: str  # ERROR | WARN | INFO
    code: str
    location: str
    message: str
```
模块级常量用大写元组，数据用 `@dataclass(frozen=True)`，函数用 snake_case。

### SCRIPT_ENTRY / ERROR_HANDLING
```python
# SOURCE: plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py:212-230
def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=".", help="repository root (default: cwd)")
    ...
    if not (root / ".claude").is_dir():
        print(f"error: {root} has no .claude/ directory", file=sys.stderr)
        return 2
    ...


if __name__ == "__main__":
    sys.exit(main())
```
参数错误或启动失败时，向 stderr 打印 `error: …`，并返回非零退出码，不抛出 traceback。

### MODULE_HEADER
```python
# SOURCE: plugins/chatlog/scripts/chatlog_replay.py:1-27
#!/usr/bin/env python3
"""Replay a chatlog JSONL in a terminal the way Claude Code drew the session.

    chatlog_replay.py                       # the most recent log under ./.claude/chatlog
    chatlog_replay.py --list                # list logs
...
"""

from __future__ import annotations

import argparse
...
DEFAULT_DIR = Path(".claude/chatlog")
FOLLOW_POLL_S = 0.5
```
时长常量以 `_S` 结尾，表示单位是秒。

### TIMESTAMP_FORMAT
```python
# SOURCE: plugins/chatlog/scripts/test_chatlog_replay.py:14
TS = "2026-10-23T07:30:12.000Z"
```
时间一律是 UTC 的 ISO 8601，精确到毫秒，以 `Z` 结尾，和 chatlog 的 JSONL 一致。

### TEST_STRUCTURE
```python
# SOURCE: plugins/chatlog/scripts/test_chatlog_replay.py:1-12,30-40
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chatlog_replay as replay  # noqa: E402


class RenderTest(unittest.TestCase):
    def test_draws_each_event_like_the_terminal(self):
        self.assertIn("session resumed · abcdef12", rendered(EVENTS[0]))
```
用 `unittest`，测试文件和脚本放在同一目录，方法名写成描述行为的句子。

### LOGGING_PATTERN
仓库里的脚本不用 `logging`：正常输出写 stdout，错误写 stderr，见 `audit.py:225`。服务沿用这个做法：启动时打印一行地址，出错写 stderr；访问日志默认关闭，加 `--verbose` 才打印。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `docs/session-board-contract.md` | CREATE | 上报端和看板之间唯一的契约，Phase 2、3 都依据它 |
| `plugins/session-board/scripts/board.py` | CREATE | 看板服务：校验、汇总、排序、失联判定、记录、HTTP |
| `plugins/session-board/scripts/test_board.py` | CREATE | 单元测试和启动真实服务的集成测试 |
| `plugins/session-board/web/index.html` | CREATE | 占位页面，Phase 3 替换 |

`plugin.json` 和 `marketplace.json` 的条目在 Phase 2 加：到那时插件里才有 mod。只有脚本、没有组件的插件，放进插件市场也没有可安装的内容。

## NOT Building

- 会话上报 mod、`userConfig`、`/session-board` 命令（Phase 2）。
- 正式的大屏页面和设计（Phase 3）。
- 持久化：状态只放在内存里，服务重启后靠各会话下一次心跳（约 5 秒内）重新上报。这一条回答了 PRD 中关于重启后是否保留状态的待解决问题。
- HTTPS、多个令牌、按用户的权限。
- 统计报表：`--record` 只负责写原始记录，统计在 Phase 4 做。

---

## Step-by-Step Tasks

### Task 1: 写会话状态契约
- **ACTION**: 创建 `docs/session-board-contract.md`。
- **IMPLEMENT**: 用中文写，标题和字段名用英文。包含以下几节：
  1. **接口**：
     - `POST /api/sessions/<sessionId>`：上报，返回 `204`。
     - `GET /api/sessions`：汇总，返回 `200`。
     - `GET /`：页面。
     - `GET /healthz`：不要求令牌，返回 `ok`，给 Phase 2 的 `/session-board` 检查连通性用。
  2. **鉴权**：请求头 `Authorization: Bearer <token>`。页面也可以用查询参数 `?token=` 访问，因为浏览器打开链接时没法带请求头。
  3. **上报体**（`v: 1`）：

     | 字段 | 类型 | 必填 | 说明 |
     |---|---|---|---|
     | `v` | `1` | 是 | 契约版本，不是 1 时返回 400 |
     | `host` | string ≤ 64 | 是 | 机器名 |
     | `cwd` | string ≤ 512 | 是 | 会话工作目录 |
     | `project` | string ≤ 128 | 是 | 显示用的项目名，上报端取 `cwd` 的最后一段 |
     | `state` | `working` \| `needs-approval` \| `your-turn` \| `ended` | 是 | 失联不由上报端发，而是由服务判定 |
     | `since` | ISO 时间 | 是 | 进入当前状态的时间（上报端时钟） |
     | `sentAt` | ISO 时间 | 是 | 这次上报发出的时间（上报端时钟） |
     | `detail` | string ≤ 200 \| null | 否 | 例如等批准时的 `Bash: pnpm test` |
     | `lastPrompt` | `{text ≤ 2000, at}` \| null | 否 | 最后一次交代 |
     | `lastAnswer` | `{tail: string[] ≤ 10 行、每行 ≤ 500, at}` \| null | 否 | 最后一次回答的结尾几行 |
     | `ecc` | object \| null | 否 | ECC 进度，结构见下 |

  4. **`ecc` 结构**：
     ```json
     { "prd": { "title": "…", "done": 3, "total": 8, "inProgress": ["4"] } | null,
       "plan": { "name": "…", "done": 3, "total": 14, "isArchived": false } | null,
       "phase": "EXECUTE" | null,
       "isActive": true }
     ```
  5. **汇总响应**：`{v: 1, now, sessions: [...]}`。
     - 每条是上报体加上 `sessionId`、`receivedAt`、`waitingSince`、`isLost`。
     - `waitingSince` 是换算到服务器时钟的 `since`，换算方法为 `since + (receivedAt − sentAt)`，用来消除多台机器之间的时钟偏差。
  6. **排序规则**：
     - 先按组：`needs-approval` → `your-turn` → `working` → 失联 → `ended`。
     - 组内按 `waitingSince` 从早到晚，等得越久越靠前。
  7. **时效**：
     - 超过 30 秒没有收到上报的会话标为失联。上报端每 5 秒发一次心跳，Phase 2 实现。
     - `ended` 的会话 10 分钟后删除，失联的会话 1 小时后删除。
  8. **记录文件**（`--record`）：每次状态变化写一行 JSONL：
     ```json
     {"ts","sessionId","host","project","from","to","since","sentAt","receivedAt","reportDelayS","waitS"}
     ```
     - `reportDelayS = sentAt − since`，用来衡量状态延迟。
     - `waitS`：仅当 `from` 是 `needs-approval` 时有，等于新状态的 `since` 减去旧状态的 `since`，用来衡量等批准的响应时间。
     - 两项都按上报端时钟计算，不受机器之间时钟偏差影响。
  9. **会话 ID**：只接受 `[A-Za-z0-9._-]{1,128}`。`/clear` 或 resume 之后会话 ID 变不变，由 Phase 2 确认；服务只按会话 ID 区分卡片。
  10. **兼容性**：只能新增可选字段；删除字段或改变字段含义时，`v` 加 1。
- **MIRROR**: `docs/ecc-doc-formats.md` 的写法：开头一句说明用途和谁依赖它，然后分节、用表格。
- **IMPORTS**: N/A
- **GOTCHA**:
  - 上报体里的所有长度上限都要写进文档，Task 2 的校验和它一一对应。
  - `ecc.prd.inProgress` 是阶段编号字符串数组，和 ecc-progress 的 `Milestone.n` 一致，不是数字。
- **VALIDATE**: Task 2 的常量和这份文档的表格逐项对得上。

### Task 2: 实现上报校验和看板状态
- **ACTION**: 创建 `plugins/session-board/scripts/board.py`，先写不涉及 HTTP 的部分。
- **IMPLEMENT**:
  - **模块头**：`#!/usr/bin/env python3`，文档字符串写用法，`from __future__ import annotations`。
  - **常量**：
    ```python
    CONTRACT_VERSION = 1
    STATES = ("working", "needs-approval", "your-turn", "ended")
    STATE_ORDER = {"needs-approval": 0, "your-turn": 1, "working": 2}  # 失联 3，ended 4
    SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
    TIMESTAMP = "%Y-%m-%dT%H:%M:%S.%fZ"
    MAX_BODY_BYTES = 64 * 1024
    LOST_AFTER_S = 30
    ENDED_RETAIN_S = 10 * 60
    LOST_RETAIN_S = 60 * 60
    LIMITS = {"host": 64, "cwd": 512, "project": 128, "detail": 200, "prompt": 2000, "tail_lines": 10, "tail_line": 500}
    ```
  - **`class ReportError(ValueError)`**：校验失败时抛出，消息说明哪个字段出了什么问题，HTTP 层把它转成 400。
  - **`parse_time(text) -> float`**：把 ISO 时间字符串转成 epoch 秒。用 `datetime.strptime(text, TIMESTAMP).replace(tzinfo=timezone.utc).timestamp()`，失败时抛 `ReportError`。
  - **`format_time(epoch) -> str`**：反向转换，毫秒三位，以 `Z` 结尾，例如 `2026-10-23T07:30:12.000Z`。
  - **`parse_report(body: bytes) -> dict`**：
    - 校验：`json.loads`；顶层必须是 object；`v == 1`；必填字段齐全且是字符串；`state` 在 `STATES` 里；`since`、`sentAt` 能解析；可选字段是 `None` 或类型正确；`ecc` 只保留契约列出的键，未知键丢掉。
    - 超长的文本直接截断，不报错：`lastPrompt.text` 超过 2000 字只保留前 2000 字；`tail` 只保留最后 10 行，每行截到 500 字。
    - 返回一个新的 dict，不修改输入。
  - **`@dataclass(frozen=True) class Entry`**：字段为 `session_id: str`、`report: dict`、`received_at: float`、`waiting_since: float`。
  - **`class Board`**：
    - `__init__(self, clock=time.time, record=None)`：`record` 是一个可选的回调，参数是一个 dict，每次状态变化调用一次。内部用 `threading.Lock` 保护 `self._entries: dict[str, Entry]`。
    - `accept(self, session_id, report) -> None`：
      - 取当前时间 `now = clock()`。
      - 计算 `waiting_since = parse_time(since) + (now - parse_time(sentAt))`。
      - 和旧条目比较：会话第一次出现，或 `state` 变了，或 `since` 变了，都算一次状态变化，调用 `record`。
      - 用新的 `Entry` 替换旧条目，不原地修改。
    - `snapshot(self) -> dict`：
      - 先清理过期条目：`ended` 且距 `received_at` 超过 `ENDED_RETAIN_S` 的删除；非 `ended` 且超过 `LOST_RETAIN_S` 的删除。
      - 其余条目算出 `isLost`：非 `ended` 且 `now - received_at > LOST_AFTER_S`。
      - 排序键为 `(组号, waiting_since)`，组号取 `STATE_ORDER[state]`；失联的组号是 3，`ended` 是 4。
      - 返回 `{"v": 1, "now": format_time(now), "sessions": [...]}`。每条 session 是 `{**report, "sessionId", "receivedAt", "waitingSince", "isLost"}`，后三个时间字段用 `format_time` 格式化。
  - **`record_line(prev: Entry | None, entry: Entry) -> dict`**：生成契约第 8 节定义的那一行记录。
    - `reportDelayS = sentAt − since`。
    - 只有 `prev` 的状态是 `needs-approval` 时才有 `waitS`，等于 `entry.since − prev.since`，两者都按上报端时钟。
    - 秒数保留一位小数。
- **MIRROR**: NAMING_CONVENTION、TIMESTAMP_FORMAT。
- **IMPORTS**: `json, re, threading, time`、`from dataclasses import dataclass`、`from datetime import datetime, timezone`。
- **GOTCHA**:
  - **加锁**：`snapshot` 和 `accept` 都要在锁内执行，`ThreadingHTTPServer` 每个请求一个线程。
  - **记录写盘**：`record` 回调里会写文件，锁内调用也可以，10 个会话的量很小。但写盘失败只能向 stderr 报一次，不能让上报失败。
  - **时钟偏差**：等待时长用 `waiting_since` 排序，不要用上报端的原始 `since`。不同机器的时钟可能差几十秒。
  - **心跳不算状态变化**：心跳里 `since` 不变，不能写记录。
- **VALIDATE**: Task 5 的单元测试。

### Task 3: 实现 HTTP 服务和命令行入口
- **ACTION**: 在 `board.py` 里加上 HTTP 处理和 `main`。
- **IMPLEMENT**:
  - **`make_handler(board: Board, token: str, web_dir: Path, verbose: bool)`**：返回一个 `BaseHTTPRequestHandler` 的子类，用闭包持有这些参数。
    - `authorized(self) -> bool`：读 `Authorization: Bearer x` 请求头，或 `?token=x` 查询参数（用 `urllib.parse`），用 `hmac.compare_digest` 和令牌比较。
    - `do_GET`：
      - `/healthz` → `200 ok`，不要求令牌。
      - 其余路径先鉴权，失败返回 `401`，响应体 `unauthorized`。
      - `/api/sessions` → `200`，JSON 是 `board.snapshot()`，带 `Cache-Control: no-store`。
      - `/` 或 `/index.html` → 返回 `web_dir / "index.html"`，`text/html; charset=utf-8`。
      - 其他 → `404`。
    - `do_POST`：
      - 路径必须匹配 `/api/sessions/<id>`，否则 `404`。
      - 先鉴权，失败 `401`。
      - `Content-Length` 缺失或超过 `MAX_BODY_BYTES` 返回 `413`。
      - `parse_report` 抛出 `ReportError` 时返回 `400`，响应体是错误消息。
      - 成功调用 `board.accept`，返回 `204`。
    - `log_message`：`verbose` 为 `False` 时什么都不做。
    - 所有 JSON 响应都用 `json.dumps(..., ensure_ascii=False)` 编码成 UTF-8。
  - **`main(argv=None) -> int`**：
    - 参数：`--host`（默认 `127.0.0.1`）、`--port`（默认 `7777`）、`--token`（默认读环境变量 `SESSION_BOARD_TOKEN`，都没有就用 `secrets.token_urlsafe(16)` 生成）、`--record PATH`（可选）、`--verbose`。
    - `--record` 打开文件，以追加和行缓冲模式，每次状态变化写一行 JSON。
    - 端口被占用（`OSError`）时，打印 `error: cannot listen on host:port (…)` 到 stderr，返回 `2`。
    - 启动后打印一行：`session-board on http://<显示地址>:<port>/?token=<token>  (Ctrl-C to stop)`。监听 `0.0.0.0` 时，显示地址用 `socket.gethostname()`。
    - `KeyboardInterrupt` 时调用 `server_close()`，返回 `0`。
  - 文件末尾：`if __name__ == "__main__": sys.exit(main())`。
- **MIRROR**: SCRIPT_ENTRY / ERROR_HANDLING、LOGGING_PATTERN。
- **IMPORTS**: `argparse, hmac, secrets, socket, sys`、`from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer`、`from pathlib import Path`、`from urllib.parse import urlsplit, parse_qs`。
- **GOTCHA**:
  - **令牌泄漏**：`?token=` 会出现在访问日志里。`verbose` 模式打印日志时，把令牌替换成 `***`。
  - **页面目录**：`web_dir` 取 `Path(__file__).resolve().parent.parent / "web"`，不能依赖当前工作目录。
  - **路径穿越**：静态文件只提供 `index.html` 这一个文件，不按请求路径去读磁盘。
  - **HTTP 版本**：`do_POST` 读请求体必须按 `Content-Length` 读，否则 keep-alive 连接会卡住。`BaseHTTPRequestHandler` 默认是 HTTP/1.0，保持默认即可。
- **VALIDATE**: Task 5 的集成测试；再按下面 Manual Validation 用 curl 试一遍。

### Task 4: 写占位页面
- **ACTION**: 创建 `plugins/session-board/web/index.html`。
- **IMPLEMENT**:
  - 一个最小页面：从 `location.search` 取 `token`，每 2 秒请求一次 `/api/sessions`，请求带上 `Authorization: Bearer` 头。
  - 用 `textContent` 把结果填进一张表，列为：项目、机器、状态（失联显示 `lost`）、等待自、最后交代前 80 字。
  - 请求失败时，在页面顶部显示状态码。
  - 页面注明"Phase 3 将替换此页面"。
- **MIRROR**: 无现有前端；纯 HTML 加原生 JS，不引入外部脚本。
- **IMPORTS**: N/A
- **GOTCHA**: 所有会话数据都用 `textContent` 写入，不要用 `innerHTML`。提问和回答的文本来自上报，可能包含 HTML。
- **VALIDATE**: 启动服务，用浏览器打开打印出的地址，curl 上报一条后，表格在 2 秒内出现这一行。

### Task 5: 写测试
- **ACTION**: 创建 `plugins/session-board/scripts/test_board.py`。
- **IMPLEMENT**:
  - **辅助**：
    - `report(state="working", since=TS, sent=TS, **extra) -> dict` 生成一份合法上报，`TS = "2026-11-03T08:00:00.000Z"`。
    - `FakeClock`：保存 `now`，提供 `advance(seconds)` 方法。
  - **`ParseTest`**：
    - 合法上报能通过。
    - 以下情况都抛 `ReportError`：缺 `state`，`v` 等于 2，未知 `state`，时间格式不对，顶层是数组。
    - 超长的 `lastPrompt.text` 和 `tail` 被截断。
    - `ecc` 里的未知键被丢掉。
    - 输入的 dict 没有被修改。
  - **`BoardTest`**：
    - 排序：等批准排在轮到你前面，轮到你排在工作中前面；同组内等得久的在前。
    - 时钟偏差：上报端时钟快 60 秒时，`waitingSince` 按服务器时钟换算，排序不受影响。
    - 失联：超过 30 秒没有心跳时 `isLost` 为真，并且排在 `working` 之后、`ended` 之前。
    - 清理：`ended` 的会话 10 分钟后删除，失联的会话 1 小时后删除。
    - 记录：心跳不产生记录；从 `needs-approval` 变成 `working` 时，记录里 `waitS` 正确。
  - **`ServerTest`**：
    - `setUp` 用 `ThreadingHTTPServer(("127.0.0.1", 0), make_handler(...))` 在线程里启动服务，`tearDown` 里 `shutdown()` 加 `server_close()`。
    - 用 `urllib.request` 验证：
      - 没有令牌：`POST` 返回 401，`GET /api/sessions` 返回 401。
      - `GET /healthz` 不带令牌返回 200。
      - 10 个会话上报后，`GET` 返回 10 条，顺序正确。
      - 坏 JSON 返回 400。
      - 请求体超过 64 KiB 返回 413。
      - `?token=` 能打开 `/`。
- **MIRROR**: TEST_STRUCTURE。
- **IMPORTS**: `json, sys, threading, unittest, urllib.request, urllib.error`、`from pathlib import Path`、`from http.server import ThreadingHTTPServer`、`import board  # noqa: E402`（放在 `sys.path.insert` 之后）。
- **GOTCHA**:
  - `urllib` 遇到 4xx 会抛 `HTTPError`，测试要捕获后读 `.code`。
  - 集成测试的服务不要用真实时钟判断失联，传入 `FakeClock`。
- **VALIDATE**: `cd plugins/session-board/scripts && python3 -m unittest test_board -v` 全部通过。

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| 合法上报 | 完整的 `report()` | 返回新的 dict，字段一致 | |
| 契约版本 | `v: 2` | `ReportError` | ✓ |
| 未知状态 | `state: "sleeping"` | `ReportError` | ✓ |
| 截断 | 3000 字的 prompt、20 行 tail | 2000 字、最后 10 行 | ✓ |
| 排序 | 4 种状态各一个 | 等批准 → 轮到你 → 工作中 → ended | |
| 时钟偏差 | `sentAt` 比服务器快 60 秒 | `waitingSince` 等于服务器时钟 | ✓ |
| 失联 | 31 秒没有上报 | `isLost = true`，排在工作中之后 | ✓ |
| 清理 | `ended` 过 601 秒 | 不再出现 | ✓ |
| 记录 | 心跳、等批准到工作中 | 心跳不写；`waitS` 正确 | |
| 鉴权 | 没有令牌、错误令牌 | 401 | ✓ |
| 超大请求体 | 65 KiB | 413 | ✓ |

### Edge Cases Checklist
- [x] 空请求体或缺 `Content-Length` → 413
- [x] 超大请求体 → 413
- [x] 类型错误（顶层是数组、字段不是字符串） → 400
- [x] 并发访问：`ThreadingHTTPServer` 加锁
- [x] 网络失败：上报端的处理在 Phase 2
- [x] 没有权限 → 401
- [x] 会话 ID 非法（含 `/` 或空格） → 404（路径不匹配）

---

## Validation Commands

### Static Analysis
```bash
python3 -m py_compile plugins/session-board/scripts/board.py plugins/session-board/scripts/test_board.py
```
EXPECT: 没有输出。仓库没有配置 Python 的 lint 或类型检查，和 ecc-doc-check、chatlog 一致。

### Unit Tests
```bash
cd plugins/session-board/scripts && python3 -m unittest test_board -v
```
EXPECT: 全部通过。

### Full Test Suite
```bash
claude plugin validate .
claude plugin test plugins/ecc-progress
claude plugin test plugins/chatlog
(cd plugins/ecc-doc-check/skills/prd-plan-audit && python3 -m unittest discover -s tests)
(cd plugins/chatlog/scripts && python3 -m unittest test_chatlog_replay)
```
EXPECT: 没有回归。本阶段不改动其他插件。

### Manual Validation
- [ ] 运行 `python3 plugins/session-board/scripts/board.py --token t --record /tmp/sb.jsonl`，打印出地址。
- [ ] 上报一个等批准的会话：
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Authorization: Bearer t' \
    -d '{"v":1,"host":"mac","cwd":"/w/app","project":"app","state":"needs-approval","since":"<现在>","sentAt":"<现在>","detail":"Bash: pnpm test"}' \
    http://127.0.0.1:7777/api/sessions/s1
  ```
  返回 `204`。
- [ ] 用循环上报 s1 到 s10 共 10 个会话，`curl -H 'Authorization: Bearer t' http://127.0.0.1:7777/api/sessions` 返回 10 条，等批准的会话排在第一位。
- [ ] 不带令牌访问 `/api/sessions`，返回 `401`。
- [ ] 停止上报 31 秒后，再请求一次，这些会话的 `isLost` 都是 `true`。
- [ ] 浏览器打开打印出的地址，占位表格每 2 秒刷新。
- [ ] `/tmp/sb.jsonl` 里每次状态变化有一行，心跳不产生记录。
- [ ] 加 `--host 0.0.0.0` 启动，从局域网里另一台设备打开打印出的地址。

---

## Acceptance Criteria
- [ ] All tasks completed
- [ ] 契约文档和 `board.py` 的常量、校验逐项一致
- [ ] All validation commands pass
- [ ] Tests written and passing
- [ ] PRD Phase 1 的成功信号满足：curl 模拟 10 个会话上报，`GET` 返回正确的汇总和失联标记；没有令牌返回 401

## Completion Checklist
- [ ] 代码遵循 audit.py 和 chatlog_replay.py 的写法（文档字符串、常量、`main(argv)` 返回退出码）
- [ ] 错误写 stderr，带 `error:` 前缀，不抛出 traceback
- [ ] 访问日志默认关闭，`--verbose` 时令牌被遮盖
- [ ] 测试和脚本放在同一目录，使用 `unittest`
- [ ] 没有硬编码的令牌；阈值都是有名字的常量
- [ ] 零依赖，只用 Python 3.10 标准库
- [ ] 没有超出范围的改动（没有 mod，没有正式页面）

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 契约在 Phase 2、3 里需要改 | M | M | 只新增可选字段；必须删除或改含义时 `v` 加 1，并在同一个提交里改服务和文档 |
| 多台机器时钟偏差导致排序错乱 | M | M | 用 `sentAt` 换算到服务器时钟（`waitingSince`），并有测试覆盖 |
| `?token=` 留在浏览器历史或日志里 | M | L | 局域网内个人使用，可以接受；`verbose` 日志遮盖令牌；令牌可随时换 |
| 端口 7777 被占用 | L | L | `--port` 可改；占用时给出明确错误并返回 2 |

## Notes
- 关于 PRD 的待解决问题：
  - 心跳间隔和失联阈值：本阶段定为 5 秒和 30 秒，写进契约。
  - 服务重启后的状态：本阶段决定不保留。
  - 会话 ID 是否变化、`AskUserQuestion` 的识别：留到 Phase 2。
- `waitingSince` 和记录里的 `waitS`、`reportDelayS` 刻意分开：前者用服务器时钟做排序和显示，后者只用同一台上报端的时钟做差，不受机器之间时钟偏差影响。
- 端口默认 7777，没有特别理由，只是好记；冲突时用 `--port` 换。
