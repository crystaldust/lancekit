# lancekit

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.304-d97757)](https://code.claude.com)
[![ECC](https://img.shields.io/badge/ECC-2.2.3-555)](https://github.com/affaan-m/ECC)

一个 [Claude Code](https://code.claude.com) 插件市场，包含三个插件：

- 两个 [ECC](https://github.com/affaan-m/ECC) 工作流（`/ecc:prp-prd` → `/ecc:prp-plan` → `/ecc:prp-implement`）的扩展：一个实时进度面板，一个规划文档一致性审计。
- 一个实时记录每次会话的聊天日志。

## 目录

- [插件](#插件)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
  - [ecc-progress](#ecc-progress)
  - [ecc-doc-check](#ecc-doc-check)
  - [chatlog](#chatlog)
- [开发](#开发)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 插件

| 插件 | 类型 | 作用 |
|---|---|---|
| [`ecc-progress`](plugins/ecc-progress) | mod | 用侧边面板和状态栏显示 PRD 各阶段，以及 `/prp-implement` 执行中的任务和阶段进度 |
| [`ecc-doc-check`](plugins/ecc-doc-check) | skill | 只读审计 PRD、PRP-PRD 和计划，找出状态不一致、非法状态值、失效或已归档的链接，以及孤立的计划 |
| [`chatlog`](plugins/chatlog) | mod + skill + 脚本 | 把每条提问、回答和工具调用实时写入 `.claude/chatlog/`，并能回放或导出日志 |

*mod* 是基于 Claude Code 函数钩子（`hooks/register.tsx`）的插件，可以绘制面板、设置状态栏、注册命令和工具。

## 环境要求

- **Claude Code 2.1.304 或更新版本。** `ecc-progress` 和 `chatlog` 是 mod。mod 使用函数钩子，这是一个抢先体验的 API，可能随 Claude Code 版本变化。
- **ECC 2.2.3**，`ecc-progress` 和 `ecc-doc-check` 需要。两者都读取 ECC 生成的文档，依赖的格式见 [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md)。
- **Python 3.10+**，`ecc-doc-check` 和 chatlog 回放脚本需要。

## 安装

先添加插件市场，再安装需要的插件：

```bash
claude plugin marketplace add crystaldust/lancekit   # 也可以是本地克隆的路径
claude plugin install ecc-progress@lancekit
claude plugin install ecc-doc-check@lancekit
claude plugin install chatlog@lancekit
```

更新时，先刷新插件市场再更新插件，然后开一个新会话：

```bash
claude plugin marketplace update lancekit
claude plugin update ecc-progress@lancekit
```

Claude Code 按版本号缓存已安装的插件，所以只有版本号变了，更新才会生效。

卸载插件：`claude plugin uninstall <plugin>@lancekit`。

## 使用

### ecc-progress

对话旁边的面板显示最新 PRD 的各阶段，以及一个计划的任务：

```
PRD AI Short Drama Platform
████████░░░░░░░░░░░░ 3/8
✓ 1 Project data layer
▶ 4 Orchestration and overview
· 5 Image and video generation
Plan: Overview web UI
████░░░░░░░░░░░░░░░░ 3/14  EXECUTE
✓ T1 Server skeleton
▶ T4 Front-end project
· T5 Pages
```

- **打开面板。** 在全屏布局下，PRD 有未完成的阶段或正在执行时，面板会自动打开；其他情况输入 `/ecc-progress`。终端宽度在 110 列及以上时，面板停靠在右侧；终端较窄，或在主屏幕上（例如 tmux 里）时，面板出现在输入框上方。`/ecc-progress` 的回复会说明面板去了哪里，或者为什么没有显示。
- **状态栏。** 显示为 `ECC M3/8 ▶4 · T3/14 · EXECUTE`：已完成和总的 PRD 阶段数、进行中的阶段，执行期间还有已完成的任务数和当前阶段。
- **显示哪个计划。**
  - 执行 `/prp-implement` 时，显示正在执行的计划。
  - 否则显示 PRD 中进行中阶段链接的未归档计划，其次是待开始阶段链接的。
  - 没有 PRD 时，显示最新的未归档计划，其次是最新的已归档计划。
- **实时进度。** 插件给模型提供一个 `mcp__ecc-progress__report` 工具，要求它在每个阶段、每个任务开始和完成时上报。插件也读取 `/prp-implement` 输出的 `[done] Task N` 行。面板在文件编辑后和每 4 秒刷新一次。计划被移入 `completed/` 时，这次执行结束。
- **任务**是 `### Task N: 名称` 形式的标题。`### Task 5–12: 名称` 这样的范围算作任务 5 到 12。

### ecc-doc-check

让 Claude 检查或审计 PRD 和计划（例如"检查 PRD 和计划的状态是否一致"），或者运行 `prd-plan-audit` skill。它只报告问题和修改建议，你批准之前不改任何文件。

确定性检查也可以单独运行：

```bash
python3 plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py --root <project> [--json]
```

发现 ERROR 时脚本退出码为 1；项目没有 `.claude/` 目录时为 2。

| 发现 | 级别 | 含义 |
|---|---|---|
| `status-drift` | ERROR | 父 PRD 的某行状态与其子 PRD 的汇总状态不一致 |
| `invalid-status` | ERROR | 状态不是 `pending`、`in-progress` 或 `complete` |
| `missing-path` | ERROR | 链接的文件不存在。如果别处有同名文件（通常在 `completed/`），会给出那个路径 |
| `missing-source-prd` | ERROR | 计划的 `Source PRD` 不存在 |
| `orphan-plan` | WARN | 计划声明了 Source PRD，但没有任何 PRD 行链接它 |
| `no-plan` | WARN | 已开始的行没有链接任何计划或 PRD |
| `standalone-plan` | INFO | 计划没有 Source PRD，也没有被任何地方链接 |
| `stale-footer` | INFO | PRD 结尾仍写着计划待定，但里程碑已经开始 |

脚本之后，skill 会审阅脚本判断不了的内容：每个进行中或已完成的里程碑的提交记录、已填写的测试清单和实施报告。

### chatlog

每次会话写入 `.claude/chatlog/<YYYY-MM-DD_HHMMSS>_<session-id-8>.{jsonl,md,txt}`。

- 每条提问在模型看到之前就已写入磁盘，每一行都带时间。
- 日志会记录中断、退出、`/clear` 和上下文压缩。
- 恢复的会话继续追加到原来的文件。

| 命令 | 作用 |
|---|---|
| `/chatlog` | 显示正在写入的文件 |
| `/chatlog list` | 列出最近的日志 |
| `/chatlog replay [n\|name]` | 在侧边面板回放一份日志 |
| `/chatlog gen_html` | 把所有日志导出到 `.claude/chatlog/chatlog.html`，最早的会话在前 |

**在终端回放：**

```bash
python3 plugins/chatlog/scripts/chatlog_replay.py [n|path] [--list] [--play] [--follow] [--no-color]
```

内置的 `chatlog-replay` skill 让 Claude 在你问起以前的会话时，能找到、读取并总结它们。

**HTML 导出。**
- 每条回答显示最终的文字，之前的工具调用和文字折叠起来。
- 提问和回答按 Markdown 渲染，使用 cdnjs 上固定版本、校验哈希的 `marked` 和 `DOMPurify`。离线时页面显示纯文本。
- 超过 4 MiB 的日志会被跳过，页面上会列出它们。

**选项。** 在 `/config` 或设置的 `pluginConfigs.chatlog` 下配置：

| 选项 | 默认值 | 含义 |
|---|---|---|
| `formats` | `md+txt` | 在 JSONL 旁边写入的可读文件：`md+txt`、`md` 或 `txt` |
| `gitignore` | `true` | 写一个 `.gitignore`，让 chatlog 目录不进入 git |
| `redact` | `true` | 在写入磁盘前遮盖 API 密钥、令牌、私钥和 `password=` 的值 |

## 开发

```
.claude-plugin/marketplace.json   # lancekit 插件市场
plugins/ecc-progress/             # mod：hooks/register.tsx、hooks/parse.ts、测试
plugins/ecc-doc-check/            # skill：skills/prd-plan-audit（SKILL.md、scripts/、tests/）
plugins/chatlog/                  # mod：hooks/、scripts/（回放）、skills/chatlog-replay
docs/ecc-doc-formats.md           # ECC 插件依赖的 ECC 文档格式
```

校验、测试，以及不安装直接试用插件：

```bash
claude plugin validate .                          # 插件市场和各插件
claude plugin test plugins/ecc-progress
claude plugin test plugins/chatlog
(cd plugins/ecc-doc-check/skills/prd-plan-audit && python3 -m unittest discover -s tests)
(cd plugins/chatlog/scripts && python3 -m unittest test_chatlog_replay)
claude --plugin-dir plugins/ecc-progress --plugin-dir plugins/chatlog   # 从工作区加载
```

每次加载 mod 时，Claude Code 会把生成的类型写到 `plugins/*/.claude-plugin/types/`，这个目录已被 git 忽略。

## 参与贡献

欢迎提交 issue 和 pull request。

- 使用 [Conventional Commits](https://www.conventionalcommits.org)：`feat:`、`fix:`、`docs:`、`chore:` 等。
- 插件的 `version`（在 `.claude-plugin/plugin.json` 里）单独用一个 `chore: bump <plugin> to X` 提交升级。已安装的副本按版本号缓存，不升版本号，用户就收不到改动。
- 提交 pull request 前，先运行上面的校验和测试。
- ECC 升级后，重新核对 [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md)，并同时更新 `plugins/ecc-progress/hooks/parse.ts` 和 `plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py`。

## 许可证

[MIT](LICENSE) © 2026 crystaldust
