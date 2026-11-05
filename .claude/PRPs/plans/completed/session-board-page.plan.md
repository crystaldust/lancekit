# Plan: 大屏页面（session-board Phase 3）

## Summary
按已确认的设计稿 `designs/session-board.pen` 把占位页 `plugins/session-board/web/index.html` 换成正式大屏页面：顶部计数和时钟，"等你处理"大卡片（等批准、轮到你），"其他会话"小卡片（工作中、失联、已退出），空看板和连接中断两种状态。纯 HTML 加原生 JS，单文件，数据来自 `GET /api/sessions`。另加一个模拟 10 个会话的脚本，用来开发和验收。

## User Story
作为同时开约 10 个会话的开发者，我希望站在 3 米外看一眼大屏就知道谁在等我、等了多久、下一步该去哪个会话。

## Problem → Solution
占位页只是一张表格 → 按设计稿的大屏页面，等你的会话用大卡片、高亮色和大号计时显示。

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/session-board.prd.md`
- **PRD Phase**: 3 大屏页面
- **Estimated Files**: 4

---

## UX Design

### Before
一张五列表格（Project / Host / State / Waiting since / Last prompt），浅色或深色跟随系统。

### After（设计稿 frame `Session Board / 1920`，1920×1080）
```
Session board  ●等批准 2 ●轮到你 2 ●工作中 4 ●失联 1 ●已退出 1        2 台机器 · 2 秒前更新   16:42
等你处理  等批准在前；同类里等得越久越靠左
┌[等批准]   06:41┐┌[等批准]   01:18┐┌[轮到你]   12:05┐┌[轮到你]   03:52┐
│ai-video-platform││lancekit         ││novel-skills     ││homelab          │
│host · cwd       ││host · cwd       ││host · cwd       ││host · cwd       │
│▌Bash: pnpm test ││▌Write: …        ││最后回答          ││最后回答          │
│最后交代          ││最后交代          ││ tail 行…         ││ tail 行…         │
│PRD M3/8 ▶4 · T7/14 VALIDATE ││ …   ││没有 ECC 进度     ││ …                │
│▓▓▓▓░░░░░░       ││                 ││                 ││                 │
└─────────────────┘└─────────────────┘└─────────────────┘└─────────────────┘
其他会话
┌●工作中 08:12┐┌●工作中 05:30┐┌…┐┌…┐┌●失联 2 分钟┐(75%)┌●已退出 7 分钟前┐(50%)
```
状态 frame `Session Board / States`：空看板（图标、"还没有会话上报"、配置提示、看板地址）；连接中断（顶部红色横幅"连不上看板服务（原因）· 下面是 HH:MM:SS 的数据"，卡片保留并整体变暗，计时继续走，恢复后横幅消失）。

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 打开 `/?token=…` | 表格 | 大屏页面 | 只读，无交互 |
| 计时 | 无 | 每秒走一次 | 用服务器时钟换算，消除大屏和服务器的时差 |
| 拉取失败 | 一行红字 | 横幅 + 卡片变暗，保留上次数据 | |
| 浏览器窗口大小 | — | 以 1920 宽为基准等比缩放 | 尺寸全部用 rem，根字号随视口变化 |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `docs/session-board-contract.md` | 82-102 | 汇总响应字段、排序、`isLost` |
| P0 | `designs/session-board.pen`（用 pencil MCP 读） | frames `lbTMT`、`NYEGD` | 尺寸、颜色、字体、文案 |
| P0 | `plugins/session-board/web/index.html` | all | 现有拉取、令牌、`textContent` 写法 |
| P1 | `plugins/session-board/scripts/board.py` | 283-320, 400-430 | 服务排序；只服务 `index.html` 一个文件 |
| P1 | `plugins/session-board/hooks/report.ts` | `eccSummary` | ECC 字段的来源和含义 |
| P2 | `plugins/session-board/scripts/test_board.py` | 1-40 | Python 测试风格 |

## External Documentation
不需要外部资料：原生 DOM、`fetch`、CSS grid，Chrome 和 Safari 都支持。

---

## Design Tokens（从设计稿取）

| Token | Value | 用途 |
|---|---|---|
| bg | `#0B0E13` | 页面底色、徽章文字 |
| surface | `#151A22` | 小卡片、空看板 |
| text | `#EDF1F7` | 主文字 |
| muted | `#8E99AB` | 次要文字、计数 |
| faint | `#5B6577` | 标签、已退出 |
| approval / approval-bg | `#FFB224` / `#2A2110` | 等批准 |
| turn / turn-bg | `#4CB4FF` / `#0F2233` | 轮到你 |
| working | `#46C882` | 工作中 |
| lost | `#F2555A` | 失联、错误横幅（底 `#3A1416`） |
| font-ui | Noto Sans SC → PingFang SC → system-ui | |
| font-num | JetBrains Mono → SF Mono → Menlo → monospace | 计时、细节、ECC |

尺寸（设计稿 px，页面里除以 16 写成 rem）：页面内边距 32/40/40/40，区块间距 28；标题 30/700；计数 22，圆点 12；大卡片高 560、圆角 14、内边距 24/28、间距 18、顶边 6 px 色条；徽章 20/700 圆角 999 内边距 6/14；计时 64/700；项目名 38/700；位置 18；细节框底 `#00000055`、22/500 等宽；标签 16/600 字距 1；正文 22 行高 1.45；回答结尾 19 等宽，最后一行用 text 色；ECC 20/600，阶段 18/600，进度条 8 高，轨道 `#FFFFFF1A`。小卡片：圆角 12、内边距 18/20、间距 10；状态 18/600；时长 20/600 等宽；项目名 26/700；位置 16；交代 18 行高 1.4；ECC 16/600，进度条 6 高，轨道 `#FFFFFF14`；失联不透明度 0.75，已退出 0.5。图标（lucide）：等批准 `shield-alert`、轮到你 `message-circle`、空看板 `monitor-dot`、中断 `wifi-off`，内联 SVG。

---

## Patterns to Mirror

### FETCH_AND_TOKEN
// SOURCE: plugins/session-board/web/index.html:30-60
```js
const token = new URLSearchParams(location.search).get("token") || "";
const response = await fetch("/api/sessions", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
```

### SAFE_DOM
// SOURCE: plugins/session-board/web/index.html:36-40
只用 `createElement` + `textContent`，不用 `innerHTML` 拼会话数据。图标 SVG 是页面里写死的常量。

### ECC_SUMMARY_TEXT
// SOURCE: ecc-progress 状态行，Phase 2 `report.ts` 的 `eccSummary`
`PRD M{done}/{total} ▶{inProgress.join(",")} · T{plan.done}/{plan.total}`；`inProgress` 为空时省掉 `▶…`，没有 plan 时省掉 `· T…`；`isActive` 且有 `phase` 时右侧显示阶段。

### PY_TEST_STYLE
// SOURCE: plugins/session-board/scripts/test_board.py
`unittest`，标准库。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `plugins/session-board/web/index.html` | REPLACE | 正式页面：样式、纯逻辑脚本（`<script id="board-logic">`）、渲染脚本 |
| `plugins/session-board/web/page.test.mjs` | CREATE | 用 `node --test` 抽出 `board-logic` 脚本测纯函数 |
| `plugins/session-board/scripts/demo.py` | CREATE | 往看板推 10 个模拟会话并保持心跳，开发和验收用 |
| `plugins/session-board/scripts/test_board.py` | UPDATE | demo 的每条上报都能通过服务校验 |

## NOT Building
- 点击卡片跳转到会话、任何交互：v1 只读。
- 浅色主题：大屏固定深色，设计稿只有深色。
- 声音、通知、浏览器标题闪烁。
- 外部字体或 CDN：大屏可能离线，只用本机字体栈。
- 服务端改动：页面保持单文件。

---

## Step-by-Step Tasks

### Task 1: 纯逻辑
- **ACTION**: 在 `index.html` 里写 `<script id="board-logic">`，只定义函数，挂到 `globalThis.BoardLogic`，不碰 DOM。
- **IMPLEMENT**:
  - `split(sessions)` → `{waiting, others}`：`waiting` 是非失联的 `needs-approval` / `your-turn`，其余进 `others`；都保持服务给的顺序。
  - `kindOf(s)` → `approval | turn | working | lost | ended`。
  - `counts(sessions)` → 五类数量；`hostCount(sessions)`。
  - `formatTimer(ms)` → `mm:ss`，满 1 小时 `h:mm:ss`，负数当 0。
  - `formatAgo(ms)` → `N 秒` / `N 分钟` / `N 小时`；`durationText(s, nowMs)`：等待和工作中用 `formatTimer(now − waitingSince)`；失联用 `formatAgo(now − receivedAt)`；已退出用 `formatAgo(now − waitingSince) + "前"`。
  - `eccText(ecc)` → `{text, phase, fraction}` 或 `null`；`fraction` 优先 plan，再 prd，`total` 为 0 时为 0。
  - `messageOf(s)` → 等批准：`{label:"最后交代", lines:[lastPrompt.text]}`；轮到你：有 `lastAnswer` 时 `{label:"最后回答", lines: tail 的最后 4 行}`，否则退回最后交代；都没有时 `null`。
  - `errorReason(err)` → `HTTP 401` → `令牌不对`；`HTTP 5xx` → `服务出错`；其他 HTTP 原样；网络错误 → `网络不通`。
  - `syncText(hosts, agoMs)` → `N 台机器 · N 秒前更新`。
- **MIRROR**: ECC_SUMMARY_TEXT
- **GOTCHA**: 时间用服务器 `now` 和 `Date.now()` 的差换算，不能直接拿 `waitingSince` 跟大屏本地时钟比。
- **VALIDATE**: Task 4 的 node 测试。

### Task 2: 样式和骨架
- **ACTION**: 替换 `index.html` 的 `<style>` 和 `<body>`。
- **IMPLEMENT**: 按 Design Tokens 写 CSS 变量；根字号 `calc(100vw / 120)`（1920 宽时 16px），最小 10px；页面 `height: 100vh` 的纵向网格：header / 等你处理 / 其他会话。大卡片每行最多 4 张，超过 4 张换两行并降低高度、减少正文行数；只有 1–2 张时每张最多占 1/2 宽。小卡片一行 6 张，放不下的显示"另有 N 个"。没有等你的会话时，"等你处理"区显示一行"现在没有会话在等你"。文字溢出用省略号（项目名、位置、细节一行；正文多行截断）。
- **GOTCHA**: 不能出现滚动条——大屏没人滚动。
- **VALIDATE**: Task 5 浏览器截图对照设计稿。

### Task 3: 渲染和轮询
- **ACTION**: 第二个 `<script>`：拉取、渲染、每秒走表。
- **IMPLEMENT**: 每 2 秒拉一次；成功时记下时差、`lastOkAt`、数据，隐藏横幅；失败时保留数据，显示横幅（原因 + 上次成功时间 `HH:MM:SS`），主体加 `.stale`（不透明度 0.4）。每秒只更新计时、"N 秒前更新"和时钟文字，不重建卡片；数据变化时整体重建。没有会话且连接正常时显示空看板，地址用 `location.origin`。
- **MIRROR**: FETCH_AND_TOKEN, SAFE_DOM
- **GOTCHA**: 第一次拉取就失败（例如令牌错）时没有旧数据：只显示横幅，不显示空看板。
- **VALIDATE**: 手动：停掉服务看横幅，重启看横幅消失。

### Task 4: 测试
- **ACTION**: `web/page.test.mjs` 读 `index.html`，取出 `<script id="board-logic">` 的内容，在 `node:vm` 里执行，测 Task 1 的每个函数。
- **VALIDATE**: `node --test plugins/session-board/web/page.test.mjs`

### Task 5: 模拟数据和验收
- **ACTION**: `scripts/demo.py --url http://127.0.0.1:7777 --token t`：按设计稿推 10 个会话（2 等批准、2 轮到你、4 工作中、1 失联、1 已退出），`since` 错开；每 5 秒心跳，失联那个只报一次。`test_board.py` 加测试：demo 的每条上报都能被 `parse_report` 接受。
- **IMPLEMENT**: 标准库 `urllib`，不走代理，Ctrl-C 退出。
- **VALIDATE**: 启动 `board.py` 和 `demo.py`，Chrome 打开 1920×1080 截图对照设计稿；再看 1280×720 无滚动条；停服务看中断横幅。

---

## Testing Strategy

### Unit Tests
| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| split | 失联的等批准会话 | 进 `others` | 是 |
| formatTimer | 3599999 / 3600000 / -5 | `59:59` / `1:00:00` / `00:00` | 是 |
| durationText | 失联，receivedAt 2 分钟前 | `2 分钟` | |
| durationText | 已退出 7 分钟前 | `7 分钟前` | |
| eccText | prd + plan + active | `PRD M3/8 ▶4 · T7/14`，phase `VALIDATE`，fraction 0.5 | |
| eccText | 只有 prd，无进行中 | `PRD M1/4`，fraction 0.25 | |
| eccText | null / plan.total 0 | null / fraction 0 | 是 |
| messageOf | 轮到你，tail 10 行 | 最后 4 行 | 是 |
| messageOf | 轮到你，无回答 | 最后交代 | 是 |
| errorReason | HTTP 401 / TypeError | 令牌不对 / 网络不通 | |

### Edge Cases Checklist
- [ ] 0 个会话（空看板）
- [ ] 1 个等你的会话
- [ ] 8 个等你的会话（两行）
- [ ] 20 个其他会话（"另有 N 个"）
- [ ] 很长的项目名、cwd、detail、emoji
- [ ] 令牌错误（首次加载就 401）
- [ ] 服务中途停掉再恢复

---

## Validation Commands

### Static Analysis
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('plugins/session-board/web/index.html','utf8');for(const m of h.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(m[1]);console.log('scripts parse')"
python3 -m py_compile plugins/session-board/scripts/demo.py
```

### Unit Tests
```bash
node --test plugins/session-board/web/page.test.mjs
python3 -m unittest discover -s plugins/session-board/scripts -p 'test_*.py'
```

### Full Test Suite
```bash
claude plugin test plugins/session-board
```
EXPECT: Phase 2 的 16 个测试不受影响。

### Browser Validation
```bash
python3 plugins/session-board/scripts/board.py --token t &
python3 plugins/session-board/scripts/demo.py --token t &
# Chrome: http://127.0.0.1:7777/?token=t ，1920×1080 截图对照 designs/session-board.pen
```

### Manual Validation
- [ ] 3 米外能分辨等你的会话和它的计时（用户在大屏上确认）
- [ ] 停服务出现横幅、卡片变暗、计时继续；恢复后横幅消失

---

## Acceptance Criteria
- [ ] 1920×1080 下 10 个模拟会话与设计稿一致，无滚动条
- [ ] 空看板和连接中断两种状态与设计稿一致
- [ ] 计时每秒走，用服务器时钟换算
- [ ] node 和 Python 测试通过，Phase 2 测试无回归
- [ ] 会话数据只经 `textContent` 写入

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 大屏没装 Noto Sans SC / JetBrains Mono | High | Low | 字体栈退到 PingFang SC / SF Mono / Menlo |
| 会话很多时放不下 | Medium | Medium | 大卡片降高、小卡片"另有 N 个" |
| 大屏时钟和服务器不同步 | Medium | Medium | 用响应里的 `now` 换算 |

## Notes
- 页面必须是单文件：`board.py` 只服务 `index.html`。
- 纯逻辑放在独立的 `<script id="board-logic">` 里，不改服务也能用 node 测试。
