# Session Board：Claude Code 多会话大屏看板

## Problem Statement

一个人同时开约 10 个 Claude Code 会话（Ghostty 多个 tab，可能分布在局域网内多台机器上）时，只能逐个切换窗口才知道每个会话的状态。会话在等批准时没人发现，它就一直白白停着；刚专注做完一个会话，又常常忘了其他会话下一步要做什么，只能再切几个 tab 去找。会话越多，在切换上浪费的时间和注意力越多。

## Evidence

- 用户原话："等批准很久我才发现，这确实是一个很让人恼火的场景。"
- 用户原话："session 开太多了，我有时候专注做完一个 session 的对话，剩下的我已经忘记要做什么了，可能会自己切换几个 tab 才知道下一步我要做哪个 session 中的任务。"
- 用户日常同时开约 10 个会话（用户自述）。
- 等待时长、切换次数目前没有数据，属于假设，要在 Phase 4 用看板自己的记录验证。

## Proposed Solution

lancekit 新增插件 `session-board`，由两部分组成：
- **上报 mod**：在每个会话里运行，把本会话的状态用 HTTP 推送给看板服务。状态包括：工作中、等批准、轮到你、已退出；最后一次交代；最后一次回答的结尾；ECC 进度（从 ecc-progress 的插件状态读取）。
- **看板服务**：一个零依赖的 Python 服务，运行在接大屏的那台机器上。它汇总各机器、各会话上报的状态，提供一个按"谁在等我"排序的大屏网页。

选择推送而不是读本地日志，有三个原因：
- "等批准"能准确拿到，不用推测。
- 能汇总局域网里多台机器的会话。
- 能带上 ECC 进度、最后交代这类社区看板都没有的内容。

## Key Hypothesis

我们相信：一块按"谁在等我"排序、并显示每个会话最后交代和最后回答的大屏，能消除同时开约 10 个会话的人切 tab 找状态、找下一步的成本。
验证标准：
- 会话开始等你之后，你在 1 分钟内处理它。
- 一天里不再为了看状态去切窗口。

## What We're NOT Building

- **在看板上操作会话**（批准、发消息、中断）：看板只读。操作要回到对应终端，避免看板变成一个需要严格鉴权的远程控制入口。
- **手机或平板专门适配**：目标是对面的大屏，网页能在平板浏览器打开即可，不做移动端布局。
- **费用和用量统计**：已有 ccusage 等工具。
- **提问内容遮盖等隐私处理**：用户明确先不考虑。
- **会话历史回放**：chatlog 已经提供。
- **用模型生成回答摘要**：每个回合都会多一次调用，产生成本和延迟。v1 截取回答的最后几行。

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|--------------|
| 等批准的响应时间 | 中位数 ≤ 1 分钟 | 看板记录每次"等批准"从开始到结束的时长 |
| 为看状态切窗口 | 一天 0 次（用户自述） | Phase 4 验收时用户连续使用一天后自评 |
| 状态延迟 | 会话状态变化后 ≤ 3 秒出现在大屏 | 看板记录上报时间和事件时间，取两者之差 |
| 失联识别 | 会话异常退出后 ≤ 30 秒标为失联 | 验收时直接关掉终端窗口测量 |
| 规模 | 10 个会话、2 台机器同时上报，页面稳定 | 验收运行 |

## Open Questions

- [ ] 会话在 `AskUserQuestion` 弹出的问题上等你回答时，能不能和"等批准"一样准确识别？需要在 Phase 2 确认对应的事件。
- [ ] 心跳间隔和失联判定阈值取多少（初定每 5 秒心跳、30 秒无心跳算失联）？
- [ ] 会话 ID 在 `/clear`、resume 之后是否变化？大屏上应显示为同一张卡片还是新卡片？
- [ ] 一台机器上同一项目开了多个会话时，卡片怎么区分（项目名 + 会话 ID 前几位，还是终端标题）？
- [ ] 看板服务重启后，各会话的状态要不要保留，还是等下一次心跳重新上报？

---

## Users & Context

**Primary User**
- **Who**：独立开发者，在一台或多台 Mac 上用 Ghostty 同时开约 10 个 Claude Code 会话，多数会话在跑 ECC 流程（`/ecc:prp-prd` → `/ecc:prp-plan` → `/ecc:prp-implement`）。
- **Current behavior**：逐个切 tab 看状态；靠记忆或翻对话回想每个会话在做什么。
- **Trigger**：一是专注于某个会话时，其他会话开始等批准；二是刚做完一个会话，要决定下一个去哪。
- **Success state**：抬头看一眼大屏，就知道哪个会话在等我、等了多久、我最后交代了什么、它答到哪，然后直接切到要处理的那个窗口。

**Job to Be Done**
当我做完一个会话、或正专注于某个会话时，我想不切窗口就知道其他会话的状态，以及每个会话我最后交代了什么、它答了什么，这样我能马上挑出下一个要处理的会话，也不会让会话白白等批准。

**Non-Users**
- 团队或多人共用一块看板：v1 只服务一个人自己的会话。
- 需要远程或在外网查看的人：只在局域网内使用。
- 关心费用和用量分析的人：有其他工具。

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability | Rationale |
|----------|------------|-----------|
| Must | 准确的会话状态：工作中 / 等批准 / 轮到你 / 已退出 / 失联，以及进入当前状态的时间 | 解决"等批准很久才发现"，核心痛点 |
| Must | 每张卡片显示最后一次交代和最后一次回答的结尾几行 | 解决"忘了下一步要做什么" |
| Must | 显示 ECC 进度：PRD 阶段（`M3/8 ▶4`）、计划任务（`T3/14`）、当前阶段 | 多数会话在跑 ECC，进度决定下一步 |
| Must | 等你处理的会话排在最前面并高亮，按等待时长排序 | 一眼看出该先处理哪个 |
| Must | 局域网多台机器的会话汇总到一块看板 | 用户的会话分布在多台机器上 |
| Must | 看板服务和插件共用访问令牌，没有令牌的请求一律拒绝 | 防止局域网内被写入假数据或被随意打开 |
| Must | 会话里的 `/session-board` 命令显示连接状态和最近一次上报时间 | 配置错了能马上发现，而不是大屏上悄悄少一张卡片 |
| Should | 心跳超时把会话标为失联 | 终端被直接关掉时 `session.end` 可能来不及触发 |
| Should | 卡片上标出机器名和项目路径 | 多机器、多会话同项目时区分卡片 |
| Could | 有会话开始等你时，大屏发出提示音或闪烁 | 大屏不在视线内时也能注意到 |
| Could | 点卡片切到对应的 Ghostty 窗口（仅同一台机器） | 减少找窗口的时间 |
| Won't | 在看板上批准或发消息 | 只读，见 What We're NOT Building |
| Won't | 模型生成的回答摘要 | 成本和延迟，v1 截取文本 |

### MVP Scope

- **上报 mod**：在每个会话里运行，状态变化时上报，并定时发心跳。
- **看板服务**：一个零依赖的 Python 服务，接收上报并提供网页。
- **大屏网页**：按"谁在等我"排序显示会话卡片。

验证方式：一台机器上 10 个会话、另一台机器上至少 1 个会话同时上报，用户连续使用一天，核对 Success Metrics。

### User Flow

1. 在接大屏的机器上启动服务：`python3 plugins/session-board/scripts/board.py --host 0.0.0.0 --token <令牌>`，在大屏浏览器打开它给出的地址。
2. 在各机器上安装插件，在 `/config` 里填看板地址和令牌。
3. 正常使用 Claude Code。某个会话请求批准时，它的卡片在 3 秒内跳到大屏最前面并高亮，显示已等待的时长和最后交代。
4. 抬头看大屏，切到对应的 Ghostty 窗口处理，卡片回到"工作中"。
5. 做完一个会话后看大屏，根据每张卡片的最后交代、最后回答和 ECC 进度，决定下一个去哪。

---

## Technical Approach

**Feasibility**: HIGH

**Architecture Notes**
- **推送模型**：上报 mod 用 `$.http.fetch` 把状态 POST 给看板服务；看板服务地址和令牌放在插件的 `userConfig` 里。mod 不能监听端口，所以网页由单独的服务提供。
- **状态来源**：
  - 等批准：`classic.PermissionRequest`。
  - 回合结束、轮到你：`classic.Stop`、`turn.complete`。
  - 等输入提醒：`classic.Notification`。
  - 开始工作、最后交代：`prompt.submit`。
  - 最后回答：`turn.complete` 的文本。
  - 已退出：`session.end`。
  - ECC 进度：读 ecc-progress 的插件状态（`prd`、`plan`、`live`），只读，ecc-progress 本身不改。
- **状态契约**：每个会话一份 JSON，字段在 Phase 1 定稿，写进 `docs/`，ecc-progress 的格式文档也照这个方式维护。上报和看板两边都只依赖这份契约。
- **看板服务**：Python 3 标准库（`http.server`），和 lancekit 现有脚本一致，零依赖。状态保存在内存中，按会话 ID 覆盖更新；超过心跳阈值没有更新的会话标为失联。
- **网页**：纯 HTML 加原生 JS，定时拉取 `GET /api/sessions`。不用构建工具，不引入 npm 依赖。
- **默认安全**：服务默认只监听 `127.0.0.1`，需要显式加 `--host 0.0.0.0` 才对局域网开放。上报和页面访问都要求令牌。

**Technical Risks**

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| mod API 处于抢先体验阶段，事件名或字段变化 | M | 把读取事件的代码集中在一个文件；用 `claude plugin test` 覆盖每种状态的推导 |
| 终端被直接关掉，`session.end` 来不及发出 | H | 心跳超时判为失联（Should） |
| 看板服务没启动或地址填错，上报失败影响会话 | M | 上报失败只记录、不抛错，不影响会话本身；`/session-board` 显示失败原因 |
| 每个会话频繁上报，大屏闪烁或服务压力大 | L | 只在状态变化时立即上报，其余靠心跳；10 个会话、每 5 秒一次心跳，量很小 |
| `AskUserQuestion` 等待没有可用事件 | M | Phase 2 先确认；拿不到时归入"轮到你"，在 Open Questions 跟踪 |

---

## Implementation Phases

<!--
  STATUS: pending | in-progress | complete
  PARALLEL: phases that can run concurrently (e.g., "with 3" or "-")
  DEPENDS: phases that must complete first (e.g., "1, 2" or "-")
  PRP: link to generated plan file once created
-->

| # | Phase | Description | Status | Parallel | Depends | PRP Plan |
|---|-------|-------------|--------|----------|---------|----------|
| 1 | 状态契约与看板服务 | 定稿会话状态 JSON 契约；Python 看板服务：令牌校验、接收上报、汇总、失联判定、`GET /api/sessions` | complete | - | - | .claude/PRPs/plans/completed/session-board-server.plan.md · report: .claude/PRPs/reports/session-board-server-report.md |
| 2 | 会话上报 mod | 从事件推导状态、读取 ecc-progress 进度、状态变化即时上报加心跳、`userConfig`、`/session-board` 连接状态 | complete | with 3 | 1 | .claude/PRPs/plans/completed/session-board-reporter.plan.md · report: .claude/PRPs/reports/session-board-reporter-report.md |
| 3 | 大屏页面 | 先出页面设计，再实现：按等待排序的会话卡片、高亮、等待时长、最后交代和回答、ECC 进度 | complete | with 2 | 1 | .claude/PRPs/plans/completed/session-board-page.plan.md · design: designs/session-board.pen · report: .claude/PRPs/reports/session-board-page-report.md |
| 4 | 端到端验收与文档 | 两台机器、约 10 个会话连续使用一天，核对 Success Metrics；README 中英文更新 | pending | - | 2, 3 | - |

### Phase Details

**Phase 1：状态契约与看板服务**
- **Goal**：定下上报和看板之间唯一的数据契约，并让服务能独立运行。
- **Scope**：
  - 契约文档：会话 ID、机器名、项目路径、状态、状态开始时间、最后交代、最后回答结尾、ECC 进度、心跳时间。
  - `board.py`：`POST /api/sessions/<id>` 上报、`GET /api/sessions` 汇总、令牌校验、失联判定、提供静态网页。
  - 单元测试。
- **Success signal**：用 curl 模拟 10 个会话上报，`GET` 返回正确的汇总和失联标记；没有令牌的请求返回 401。

**Phase 2：会话上报 mod**
- **Goal**：每个会话准确、及时地上报自己的状态。
- **Scope**：
  - 事件到状态的推导；读取 ecc-progress 的插件状态；变化即时上报加心跳。
  - `userConfig`：看板地址和令牌。
  - `/session-board` 命令；上报失败不影响会话。
  - 用 `claude plugin test` 覆盖每种状态。
- **Success signal**：测试里依次触发 `prompt.submit`、`classic.PermissionRequest`、`classic.Stop`、`session.end`，上报的状态依次正确；看板服务不可达时会话不受影响，`/session-board` 显示失败原因。

**Phase 3：大屏页面**
- **Goal**：站在对面也能一眼看出谁在等我、下一步去哪。
- **Scope**：
  - 先做页面设计（布局、卡片字段、状态配色、10 张卡片的排布），确认后再实现。
  - 实现：纯 HTML 加原生 JS，按等待优先、等待时长排序。
  - 用 Phase 1 的契约样例数据开发。
- **Success signal**：用 10 个模拟会话在大屏分辨率下打开，3 米外能分辨出等你的会话和它等待的时长。

**Phase 4：端到端验收与文档**
- **Goal**：在真实使用中验证核心假设。
- **Scope**：
  - 两台机器、约 10 个真实会话连续使用一天。
  - 记录等批准的响应时长、状态延迟、失联识别时间。
  - 更新 README 和 README.zh-CN。
- **Success signal**：Success Metrics 各项达标，或记录下未达标的原因和后续调整。

### Parallelism Notes

Phase 1 定下契约之后，Phase 2（上报 mod）和 Phase 3（页面）只依赖这份契约，可以并行：
- 上报 mod 用模拟的看板服务做测试。
- 页面用契约样例数据开发。

Phase 4 需要两者都完成。

---

## Decisions Log

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| 自建还是用现有看板 | 自建，放在 lancekit | 接入 disler/claude-code-hooks-multi-agent-observability 等社区看板 | 现有看板都看不到 ECC 进度和最后交代，格式没有文档，受第三方变化影响 |
| 代码放在哪 | lancekit 新插件 `plugins/session-board` | 单独的仓库 | 和 ecc-progress 同仓库，契约改动能一起提交；保持零依赖；需要构建工具或独立发布时再拆出去 |
| 数据怎么传 | 会话主动用 HTTP 推送给看板服务 | 各会话写共享目录，看板读取；读 `~/.claude/projects` 日志 | 支持多台机器；"等批准"能准确拿到 |
| 先设计页面还是先出计划 | PRD 之后、Phase 3 计划之前先出页面设计 | 计划写完再设计 | 计划的任务拆分依赖页面上的区域和字段 |
| 回答摘要 | 截取最后几行 | 模型生成一句话摘要 | 不产生额外成本和延迟 |
| 访问控制 | 共享令牌，默认只监听本机 | 不做鉴权 | 局域网内防止假数据和随意访问，成本低 |
| 隐私 | v1 不处理 | 遮盖提问内容 | 用户明确先不考虑 |
| `/session-board` 命令的作用 | 显示本会话的连接状态 | 启动看板服务 | 推送模型下服务单独运行在大屏那台机器上 |

---

## Research Summary

**Market Context**
- 社区已有十来个多会话看板，例如 [Stargx/claude-code-dashboard](https://github.com/Stargx/claude-code-dashboard)、[disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)、[radzki/claude-code-monitor](https://github.com/radzki/claude-code-monitor)、[augml/claude-code-ui](https://github.com/augml/claude-code-ui)、[simple10/agents-observe](https://github.com/simple10/agents-observe)。没有 Anthropic 官方的多会话看板。
- 状态分类基本一致：工作中、等批准、等输入、空闲。
- 数据来源有两种：读 `~/.claude/projects/*.jsonl` 日志（"等批准"只能推测），或用 hooks 推事件（更准）。
- 这些项目都没有显示"最后交代、最后回答"和 ECC 进度；接口各自定义，互不兼容，文档较少。
- 官方的 [OpenTelemetry 导出](https://code.claude.com/docs/en/monitoring-usage) 提供的是汇总指标，不适合展示单个会话的实时状态。

**Technical Context**
- **mod API 覆盖了所需能力**（在 Claude Code 2.1.312 的类型定义里核对过）：
  - 会话事件：`classic.PermissionRequest`、`classic.Notification`、`classic.Stop`、`prompt.submit`、`turn.complete`、`session.end`。
  - 网络与文件：`$.http.fetch` 发 HTTP 请求；`$.env.get("HOME")` 加 `$.fs.write` 写用户目录。
  - 跨插件状态：可以读取其他插件的状态，所以 ECC 进度可以直接从 ecc-progress 的 `prd`、`plan`、`live` 读取。
- **lancekit 现有代码可以参考**：
  - ecc-progress（`plugins/ecc-progress/hooks/register.tsx`）的定时刷新和状态读取。
  - chatlog（`plugins/chatlog/hooks/`）对 `prompt.submit`、`turn.complete` 的处理。
  - ecc-doc-check 和 chatlog 回放脚本的零依赖 Python 写法，以及 `claude plugin test` 的测试方式。

---

*Generated: 2026-11-03*
*Status: DRAFT - needs validation*
