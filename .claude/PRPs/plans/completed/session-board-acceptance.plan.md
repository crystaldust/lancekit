# Plan: 端到端验收与文档（session-board Phase 4）

## Summary
让用户能在两台机器、约 10 个会话上连续用一天，并用看板自己的记录核对 PRD 的 Success Metrics。交付三样东西：`scripts/metrics.py`（读 `--record` 文件算出等批准时长、上报延迟和规模），README 中英文的 session-board 一节，以及 PRD 里已回答的 Open Questions。一天的试用由用户进行；拿到记录后跑 `metrics.py`，结果写进报告，Phase 4 才标为完成。

## User Story
作为同时开约 10 个会话的开发者，我希望照着 README 就能在两台机器上装好、用上一天，再用一条命令看到这一天的数据是否达标。

## Problem → Solution
三个阶段都完成了，但没有安装说明，也没有办法从记录里读出指标 → README 写清楚安装和使用，`metrics.py` 一条命令出指标。

## Metadata
- **Complexity**: Small
- **Source PRD**: `.claude/PRPs/prds/session-board.prd.md`
- **PRD Phase**: 4 端到端验收与文档
- **Estimated Files**: 6

---

## UX Design

### After
```
$ python3 plugins/session-board/scripts/metrics.py states.jsonl
记录  2026-11-05 09:02 → 18:47（9.8 小时），2 台机器，11 个会话，412 次状态变化

等批准时长（目标：中位数 ≤ 60 秒）                         ✓
  次数 37   中位数 41.2 秒   P90 2.6 分钟   最长 9.1 分钟

上报延迟（目标：大屏 ≤ 3 秒 = 上报 ≤ 1 秒 + 页面轮询 2 秒）   ✓
  次数 412  中位数 0.0 秒   P95 0.4 秒   最长 1.8 秒   超过 1 秒 3 次

规模（目标：2 台机器、10 个会话同时在线）                   ✓
  同时在线最多 10 个会话（2 台机器），在 14:20

失联（目标：异常退出后 ≤ 30 秒标为失联）                    手动核对
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| README | 没有 session-board | 安装、启动看板、配置、使用、开发 | 中英文同步 |
| 验收 | 无 | `metrics.py <record>` | 只读，标准库 |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `plugins/session-board/scripts/board.py` | 243-261 | 记录行字段：`ts`、`sessionId`、`host`、`from`、`to`、`since`、`sentAt`、`receivedAt`、`reportDelayS`、`waitS` |
| P0 | `docs/session-board-contract.md` | 115-134 | 记录文件契约：心跳不写；`waitS` 只在 `from` 为 `needs-approval` 时有 |
| P0 | `.claude/PRPs/prds/session-board.prd.md` | 41-57 | Success Metrics、Open Questions |
| P1 | `README.md`、`README.zh-CN.md` | all | 各插件一节的写法、表格、Development 命令 |
| P1 | `plugins/session-board/.claude-plugin/plugin.json` | all | `userConfig` 项名和说明 |
| P2 | `plugins/session-board/scripts/demo.py` | all | 命令行参数风格 |

---

## Patterns to Mirror

### CLI_STYLE
// SOURCE: plugins/session-board/scripts/demo.py
模块 docstring 给用法；`argparse`，`description=__doc__.splitlines()[0]`；`main(argv) -> int`，`sys.exit(main())`；出错写 stderr 并返回非零。

### TEST_STYLE
// SOURCE: plugins/session-board/scripts/test_board.py
`unittest`，`sys.path.insert(0, 脚本目录)` 后 import；用 `board.format_time` 造时间。

### README_SECTION
// SOURCE: README.md "### chatlog"
先一句话说做什么，再给命令和表格；选项表三列 `Option | Default | Meaning`。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `plugins/session-board/scripts/metrics.py` | CREATE | 从记录文件算 Success Metrics |
| `plugins/session-board/scripts/test_metrics.py` | CREATE | 指标计算的测试 |
| `README.md` | UPDATE | session-board 一节、插件表、Requirements、Installation、Development |
| `README.zh-CN.md` | UPDATE | 同上，中文 |
| `.claude/PRPs/prds/session-board.prd.md` | UPDATE | Open Questions 写结论；Phase 4 状态 |
| `docs/session-board-contract.md` | UPDATE | 去掉"由 Phase 2 确认"的待定说法 |

## NOT Building
- 在记录里加失联事件：失联由服务判定、不经过上报；失联按 PRD 手动测量。
- 图表或网页版的指标报告：命令行文字足够。
- 插件版本号变化：0.1.0 还未发布过。

---

## Step-by-Step Tasks

### Task 1: metrics.py
- **ACTION**: 新建 `scripts/metrics.py <record.jsonl> [--json]`。
- **IMPLEMENT**:
  - `load(path)` → `(lines, bad)`：逐行解析，跳过空行；坏行计数、不中断。
  - `percentile(values, p)`：最近秩法，不引入第三方库。
  - `peak_concurrency(lines)`：每个会话的在线区间取它第一行到最后一行的 `ts`，扫描这些区间，返回最多同时在线的会话数、其中的机器数和时刻。心跳和失联都不写记录，所以这是下限估计——达到 10 就一定达标。
  - `summarize(lines, bad)` → dict：时间范围、机器数、会话数、状态变化次数、三组统计和是否达标。
  - 达标规则：等批准中位数 ≤ 60 秒；上报延迟 P95 ≤ 1 秒（页面每 2 秒拉一次，合计 ≤ 3 秒）；同时在线 ≥ 10 个会话且 ≥ 2 台机器。没有数据时显示"没有数据"。
  - 输出格式见 UX Design；`--json` 输出 `summarize` 的结果。时长 ≥ 120 秒时用分钟显示。
- **MIRROR**: CLI_STYLE
- **GOTCHA**: `reportDelayS` 和 `waitS` 只用上报端自己的时钟，可以跨机器直接比；`ts` 是服务器时钟，用来排序和算时间范围。
- **VALIDATE**: Task 2 的测试；用 demo 生成的真实记录跑一遍。

### Task 2: test_metrics.py
- **IMPLEMENT**: 百分位；等批准中位数 60 秒达标、61 秒不达标；上报延迟；同时在线；坏行跳过并计数；空文件；`--json` 输出能被 `json.loads`；端到端：用 `board.Board` + `RecordFile` 写一份记录再算。
- **VALIDATE**: `python3 -m unittest discover -s plugins/session-board/scripts -p 'test_*.py'`

### Task 3: README（英文）
- **IMPLEMENT**:
  - 开头"three plugins"改为四个，加一条看板的介绍；Contents、Plugins 表加 `session-board`（kind：mod + script）。
  - Requirements：看板服务要 Python 3.10+。Installation 加 `claude plugin install session-board@lancekit`。
  - Usage → session-board：启动服务（`--host 0.0.0.0`、`--token`、`--record`，它列出所有可访问地址）；每台机器 `/config` 填 Board URL 和 Token（令牌放 Token 存安全存储，放在地址里则明文存在设置中）；页面说明（等你处理、其他会话、计时、失联 30 秒、已退出保留 10 分钟）；`/session-board`；`demo.py` 试看；`metrics.py` 核对数据；选项表；局限（共享令牌、无 HTTPS、只适合可信局域网）。
  - Development：目录树、测试命令、`--plugin-dir` 示例加 session-board；Contributing 的 ECC 升级说明加 `plugins/session-board/hooks/report.ts`。
- **MIRROR**: README_SECTION
- **VALIDATE**: 相对链接都存在；命令能跑。

### Task 4: README（中文）
- **IMPLEMENT**: 与 Task 3 一一对应，结构保持同步。
- **VALIDATE**: 两份 README 标题数一致。

### Task 5: PRD 和契约
- **IMPLEMENT**: Open Questions 写结论：AskUserQuestion 能识别（Phase 2，`tool.call` 进入时标为等批准）；心跳 5 秒、30 秒失联；`/clear`、resume 后会话 ID 变化，旧卡片标为已退出、新 ID 出新卡片；服务重启后下一次心跳重新出现。同一项目多个会话的区分留待验收后决定。契约 Session ID 一节改为确定的说法。Phase 4 行改为 in-progress 并链接本计划。
- **VALIDATE**: 人工核对；`audit.py` 对这份 PRD 读不出表格是已知问题（`plugins/ecc-doc-check/KNOWN_ISSUES.md`）。

### Task 6: 验收（用户）
- **ACTION**: 用户按 README 在两台机器上装好，带 `--record` 启动服务，连续用一天；期间关掉一个终端窗口，看 30 秒内是否标为失联。
- **VALIDATE**: `metrics.py` 的结果和用户自评（为看状态切窗口的次数）写进报告；全部达标后 Phase 4 标为完成。

---

## Testing Strategy

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| percentile | [5] / [1,2,3,4] / 1..100 P95 | 5 / 中位数 2 / 95 | 是 |
| approval median | waitS [30,60,90] | 60，达标 | |
| approval median | [61] | 不达标 | 是 |
| delays | [0.0,0.4,1.8] | P95 1.8，超过 1 秒 1 次 | |
| peak | 3 个会话、2 台机器、其中一个 ended 后再来一个 | 最多 3 | |
| bad lines | 一行坏 JSON | 跳过，计 1 | 是 |
| empty | 空文件 | 各项"没有数据" | 是 |

## Validation Commands

```bash
python3 -m py_compile plugins/session-board/scripts/metrics.py
python3 -m unittest discover -s plugins/session-board/scripts -p 'test_*.py'
node --test plugins/session-board/web/page.test.mjs
claude plugin test plugins/session-board
claude plugin validate .
```

## Acceptance Criteria
- [x] `metrics.py` 和测试完成
- [x] README 中英文同步更新
- [x] PRD Open Questions 更新
- [x] 用户一天试用的数据全部达标（Task 6）→ 部分达标：两台机器未测、等批准样本不足，按用户同意作为例外，见 reports/session-board-acceptance-report.md

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 同时在线数是下限估计（心跳不写记录），长时间不变状态的会话会被少算 | High | Low | 报告注明；不达标时由用户在大屏上目测确认 |
| 一天试用暴露新问题 | Medium | Medium | 记录下来，修完再标完成 |

## Notes
- 前 5 个任务现在就能做完；Phase 4 要等 Task 6 的数据才标为完成。
