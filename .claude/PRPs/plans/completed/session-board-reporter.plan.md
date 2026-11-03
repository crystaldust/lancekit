# Plan: 会话上报 mod（session-board Phase 2）

## Summary
在 `plugins/session-board` 里加一个 mod：从会话事件推导状态（工作中 / 等批准 / 轮到你 / 已退出），读取 ecc-progress 的进度，按 `docs/session-board-contract.md` 的 v1 契约在状态变化时立即上报，并每 5 秒发一次心跳。看板地址和令牌放在 `userConfig`；`/session-board` 显示连接状态和最近一次上报。上报失败只记录，不影响会话。

## User Story
作为同时开约 10 个会话的开发者，我希望每个会话自己把状态报给看板，这样我不用切 tab 就知道谁在等我。

## Problem → Solution
看板服务已能接收和汇总（Phase 1），但没有会话上报 → 每个会话装上这个 mod 后自动上报。

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/session-board.prd.md`
- **PRD Phase**: 2 会话上报 mod
- **Estimated Files**: 8

---

## UX Design

### Before
看板为空；会话状态只在各自终端里。

### After
```
/config → session-board → Board URL: http://192.168.0.226:7777/?token=…   (整条粘贴启动信息里的地址即可)
/session-board
  看板  http://192.168.0.226:7777
  状态  轮到你（自 16:42:10）
  上报  成功，2 秒前（HTTP 204）
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `/config` | 无 | `Board URL`、`Token` 两项 | 地址里带 `?token=` 时自动取出令牌 |
| `/session-board` | 无 | 显示地址、当前状态、最近一次上报结果，并立即重报一次 | 没配置时说明怎么配 |
| 会话本身 | — | 无变化 | 上报失败不提示、不抛错 |

---

## Mandatory Reading

| Priority | File | Why |
|---|---|---|
| P0 | `docs/session-board-contract.md` | 上报体字段、长度上限、时间格式 |
| P0 | `plugins/ecc-progress/hooks/register.tsx:117-127` | ECC 摘要的算法（M、▶、T、phase） |
| P0 | `plugins/ecc-progress/types/index.d.ts` | `prd` / `plan` / `live` 的结构 |
| P1 | `plugins/ecc-progress/hooks/progress.test.tsx` | 测试写法：`claude-code/testing`、`on(...)` 代替引擎 |
| P1 | `plugins/chatlog/.claude-plugin/plugin.json` | 清单和 `userConfig` 写法 |
| P2 | plugin-authoring 技能的 `types/claude-code.d.ts` | 事件输入、`$.http.fetch`、`$.state.get`、`mock.clock` |

## External Documentation

KEY_INSIGHT: `classic.PermissionRequest` 的输入有 `tool_name`、`tool_input`；`classic.Notification` 有 `notification_type`、`message`；`turn.complete` 有 `answer`、`isAborted`、`agentId`（子代理才有）；`session.end` 有 `reason`、`sessionId`，`reason: 'clear'` 时进程以新会话 ID 继续，且不再触发 `session.start`。
APPLIES_TO: Task 2、3。
GOTCHA: 子代理的 `turn.start` / `turn.complete` 也会触发，带 `agentId`，必须忽略，否则子代理结束会把主会话标成"轮到你"。

KEY_INSIGHT: `$.state.get({ plugin: 'ecc-progress', key: 'prd' })` 可以读其他插件的值；没装 ecc-progress 时得到 `undefined`。`claude plugin validate` 对此只提示"未检查"，不报错，不需要 `dependencies`。
APPLIES_TO: Task 2。

KEY_INSIGHT: `$.clock.every(ms, fn)` 的计时器在模块重载时取消；`$.clock.now()` 是毫秒。测试用 `mock.clock(on)` 推进时间。
APPLIES_TO: Task 3、4。

KEY_INSIGHT: `userConfig` 字段支持 `"sensitive": true`，值存进安全存储，`/config` 里不显示明文。
APPLIES_TO: Task 1。

---

## Patterns to Mirror

- **清单**：`plugins/chatlog/.claude-plugin/plugin.json` 的 author、license、homepage、repository、userConfig 写法。
- **纯函数和接线分开**：ecc-progress 把解析放在 `hooks/parse.ts`，`register.tsx` 只接线；本 mod 同样把状态推导和上报体构造放在 `hooks/status.ts`、`hooks/report.ts`。
- **测试**：`claude-code/testing` 的 `test`、`expect`、`mock`；用 `on('http.fetch', …)` 代替网络，`on('state.get', …)` 代替 ecc-progress。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `plugins/session-board/.claude-plugin/plugin.json` | CREATE | 清单、`userConfig` |
| `plugins/session-board/hooks/hooks.json` | CREATE | 指向 `register.tsx` |
| `plugins/session-board/hooks/status.ts` | CREATE | 事件 → 状态的纯函数 |
| `plugins/session-board/hooks/report.ts` | CREATE | 上报体、ECC 摘要、地址解析的纯函数 |
| `plugins/session-board/hooks/register.tsx` | CREATE | 接线：事件、发送、心跳、命令 |
| `plugins/session-board/hooks/reporter.test.tsx` | CREATE | 每种状态、心跳、失败、命令 |
| `plugins/session-board/README.md` | CREATE | 用法（插件目录要求有 README） |
| `.claude-plugin/marketplace.json` | UPDATE | 登记 session-board |

## NOT Building

- 看板页面（Phase 3）。
- 点卡片切换到 Ghostty 窗口、提示音（PRD 的 Could）。
- 状态栏条目：ecc-progress 已占状态栏，本 mod 不加。
- 上报端重试队列：心跳每 5 秒会自然重发最新状态。

---

## Step-by-Step Tasks

### Task 1: 清单和配置
- **ACTION**: 创建 `plugin.json`、`hooks/hooks.json`。
- **IMPLEMENT**: `userConfig`：`boardUrl`（string，默认 ""，说明可整条粘贴启动信息里的地址）、`token`（string，`sensitive: true`，默认 ""）。`version: "0.1.0"`。
- **MIRROR**: chatlog 的清单。
- **VALIDATE**: `claude plugin validate plugins/session-board`。

### Task 2: 状态推导和上报体（纯函数）
- **ACTION**: 创建 `hooks/status.ts`、`hooks/report.ts`。
- **IMPLEMENT**:
  - `Status = { state, since, detail, lastPrompt, lastAnswer }`；`transition(status, next, now)` 只在状态变了时更新 `since`，返回新对象。
  - `toolDetail(tool, input)`：`Bash: <command>`、`Write: <file_path>`，否则工具名；截到 200。
  - `answerTail(text)`：去掉末尾空行，取最后 10 行，每行截到 500。
  - `eccSummary(prd, plan, live)`：和 ecc-progress 状态栏同一算法；都没有时为 `null`。
  - `parseBoardUrl(raw, token)`：去掉结尾 `/`，取出 `?token=`；返回 `{ base, token } | null`。
  - `buildReport(...)`：按契约字段和上限组装。时间用 `new Date(ms).toISOString()`。
- **GOTCHA**: 上报体必须小于 64 KiB；`lastPrompt.text` 客户端也截到 2000。
- **VALIDATE**: Task 4 的单元测试。

### Task 3: 接线
- **ACTION**: 创建 `hooks/register.tsx`。
- **IMPLEMENT**:
  - `session.start`：取 `hostname -s`（失败回退 `unknown`），记 `cwd`，状态"轮到你"，注册 `/session-board`，启动 5 秒心跳，立即上报。
  - `turn.start`（主循环）：工作中，记 `lastPrompt`。
  - `classic.PermissionRequest`：等批准，`detail = toolDetail(...)`。
  - `classic.Notification` 的 `permission_prompt`：等批准（兜底）。
  - `tool.call` 的 `AskUserQuestion`：调用前等批准（detail 为第一个问题），之后回到工作中；其他工具 `next` 返回后若仍是等批准，回到工作中。
  - `turn.complete`（主循环）与 `classic.Stop`：轮到你，记 `lastAnswer`。
  - `session.end`：已退出并立即上报；`reason: 'clear'` 时之后以新会话 ID 从"轮到你"开始。
  - 发送：同一时间只有一个请求在途；在途时又有变化就在完成后再发一次。结果记在模块变量里给 `/session-board` 用。
  - `.catch` 让 `tool.call` 和各 classic hook 出错时照常继续。
- **GOTCHA**: 忽略带 `agentId` 的 `turn.*`；`prompt.submit` 里的斜杠命令不改状态（用 `turn.start`，只有真正开始回合才算工作中）。
- **VALIDATE**: Task 4 的集成测试；`claude plugin validate`。

### Task 4: 测试
- **ACTION**: 创建 `hooks/reporter.test.tsx`。
- **IMPLEMENT**: 依次触发 `session.start`、`turn.start`、`classic.PermissionRequest`、`tool.call`、`turn.complete`、`session.end`，断言每次上报的 `state` 和字段；子代理的 `turn.complete` 不改状态；心跳 5 秒一次且 `since` 不变；`http.fetch` 抛错或返回 401 时会话照常、`/session-board` 显示原因；地址里的 `?token=` 被取出；ECC 摘要正确；没配置时不发请求。
- **VALIDATE**: `claude plugin test plugins/session-board`。

### Task 5: 登记和说明
- **ACTION**: 写 `README.md`，在 `marketplace.json` 登记。
- **VALIDATE**: `claude plugin validate .`。

---

## Validation Commands

```bash
claude plugin validate plugins/session-board
claude plugin test plugins/session-board
claude plugin validate .
claude plugin test plugins/ecc-progress && claude plugin test plugins/chatlog
(cd plugins/session-board/scripts && python3 -m unittest test_board)
```

### Manual Validation
- [ ] `claude --plugin-dir plugins/session-board` 启动一个会话，`/config` 填地址，`/session-board` 显示上报成功。
- [ ] 让会话跑一个需要批准的 Bash，看板 3 秒内显示等批准和命令。
- [ ] 关掉看板服务，会话照常；`/session-board` 显示失败原因。

## Acceptance Criteria
- [ ] PRD Phase 2 成功信号：依次触发 `prompt.submit`/`turn.start`、`classic.PermissionRequest`、`classic.Stop`、`session.end`，上报的状态依次正确；看板不可达时会话不受影响，`/session-board` 显示失败原因。
- [ ] 所有验证命令通过。

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `classic.PermissionRequest` 在某些情况下不触发（例如自动模式分类器拦下） | M | M | `Notification` 的 `permission_prompt` 兜底 |
| `$.http.fetch` 连不上的主机挂很久 | M | L | 在途只保留一个请求，状态变化合并；心跳不叠加 |
| mod API 变动 | M | M | 事件读取集中在 `register.tsx`；测试覆盖每种状态 |

## Notes
- `AskUserQuestion` 归为"等批准"：它和批准一样会卡住会话，必须你回答才能继续。PRD 的待解决问题因此关闭。
