---
name: prd-plan-audit
description: Read-only audit of ECC PRD and plan artifacts (.claude/prds, .claude/plans, .claude/PRPs) for status drift between parent and child PRDs, non-standard status values, broken or archived plan links, orphan plans, and milestones marked complete without evidence. Use when the user asks to check, audit, or reconcile PRD / plan / milestone status, especially in projects that mix plan-prd, plan, prp-plan, and prp-implement. 中文触发：检查 PRD 和 plan 状态、里程碑状态是否一致、扫描 PRD、计划文件审计。
---

# PRD / Plan 一致性审计

检查 ECC 规划产物之间的状态和链接是否一致。**全程只读**：只报告问题和修改建议，用户批准之前不改任何文件。

覆盖两套格式及其混用：
- `plan-prd`：`.claude/prds/*.prd.md`，表格标题 `Delivery Milestones`
- `prp-prd`：`.claude/PRPs/prds/*.prd.md`，表格标题 `Implementation Phases`
- 计划：`.claude/plans/**/*.plan.md`、`.claude/PRPs/plans/**/*.plan.md`（含 `completed/`）

## 第 1 步：确定性检查（脚本）

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/audit.py" --root <项目根目录>
```

加 `--json` 可得到结构化结果。退出码：有 ERROR 为 1，否则为 0；没有 `.claude/` 目录为 2。

| code | 级别 | 含义 |
|---|---|---|
| `status-drift` | ERROR | 父 PRD 的行状态与其子 PRD 的聚合状态不一致（全 complete → complete；全 pending → pending；其他 → in-progress） |
| `invalid-status` | ERROR | 状态不是 `pending` / `in-progress` / `complete`，`/plan` 和 `prp-plan` 无法识别 |
| `missing-path` | ERROR | 行里引用的文件不存在；如果在别处找到同名文件（常见是 `prp-implement` 归档到 `completed/`），会给出新路径 |
| `missing-source-prd` | ERROR | 计划的 `Source PRD` 指向不存在的文件 |
| `orphan-plan` | WARN | 计划声明了 Source PRD，但没有任何 PRD 行链接它 |
| `no-plan` | WARN | 行状态不是 pending，却没有链接任何计划或 PRD |
| `standalone-plan` | INFO | 计划既没有 Source PRD 也没被引用（多为临时 `/plan`） |
| `stale-footer` | INFO | PRD 结尾仍写着 "Implementation planning pending via /plan"，但里程碑已开始 |

## 第 2 步：语义审阅（需要判断，脚本做不了）

只针对状态为 `in-progress` 或 `complete` 的叶子里程碑（没有子 PRD 的行）：

1. **代码证据**：`git log --oneline` 中是否有对应里程碑编号（如 `M2.5.3`）的提交。标成 complete 却没有提交、或已有提交却仍是 pending，都要报告。
2. **验证证据**：计划里 `Validation` / `Acceptance` 引用的手工测试清单（常见在 `docs/testing/`）是否填写了结果。只统计结果列，不要把"结果列填 ✅ / ❌"这类说明文字算作结果。清单未填的里程碑，不建议标成 complete。
3. **收尾证据**：用 `prp-implement` 执行的计划，完成后应有 `.claude/PRPs/reports/*-report.md` 且计划被移入 `completed/`。只有部分里程碑有报告时，说明其他的没走完收尾，提示用户即可，不算错误。
4. **PRD 里的人工说明**：行下方的状态说明（如"创始人决定暂缓 Task 13"）可能解释了看似不一致的状态。先读说明再下结论，结论里引用它。

## 第 3 步：报告

按以下结构输出，不要直接修改文件：

1. 一张问题表：位置（`文件:行`）、问题、依据（finding code、提交哈希或清单统计）。
2. 区分**可直接修复的机械问题**（链接、非标准状态值、过时结尾说明）和**需要用户拍板的状态判断**（例如某里程碑应标 complete 还是 in-progress）。
3. 给出具体的修改建议，并询问是否执行。

## 注意

- 状态的取值由 ECC 的 `plan-prd` 和 `prp-prd` 模板定义，只有 `pending | in-progress | complete` 三种。
- 两套命令都只更新直接上级的 PRD，不会同步总 PRD；多层 PRD 的项目，`status-drift` 是最常见的问题。
- 运行测试：`cd "${CLAUDE_SKILL_DIR}" && python3 -m unittest discover -s tests`
