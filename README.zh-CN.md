# lancekit

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.304-d97757)](https://code.claude.com)
[![ECC](https://img.shields.io/badge/ECC-2.2.3-555)](https://github.com/affaan-m/ECC)

一个 [Claude Code](https://code.claude.com) 插件市场，包含四个插件：

- 两个 [ECC](https://github.com/affaan-m/ECC) 工作流（`/ecc:prp-prd` → `/ecc:prp-plan` → `/ecc:prp-implement`）的扩展：一个实时进度面板，一个规划文档一致性审计。
- 一个实时记录每次会话的聊天日志。
- 一块跨机器显示哪些会话在等你的看板。

## 目录

- [插件](#插件)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
  - [ecc-progress](#ecc-progress)
  - [ecc-doc-check](#ecc-doc-check)
  - [chatlog](#chatlog)
  - [session-board](#session-board)
- [开发](#开发)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 插件

| 插件 | 类型 | 作用 |
|---|---|---|
| [`ecc-progress`](plugins/ecc-progress) | mod | 用侧边面板和状态栏显示 PRD 各阶段，以及 `/prp-implement` 执行中的任务和阶段进度 |
| [`ecc-doc-check`](plugins/ecc-doc-check) | skill | 只读审计 PRD、PRP-PRD 和计划，找出状态不一致、非法状态值、失效或已归档的链接，以及孤立的计划 |
| [`chatlog`](plugins/chatlog) | mod + skill + 脚本 | 把每条提问、回答和工具调用实时写入 `.claude/chatlog/`，并能回放或导出日志 |
| [`session-board`](plugins/session-board) | mod + 脚本 | 把每个会话的状态上报到一块大屏看板，跨局域网里的多台机器显示谁在等你 |

*mod* 是基于 Claude Code 函数钩子（`hooks/register.tsx`）的插件，可以绘制面板、设置状态栏、注册命令和工具。

## 环境要求

- **Claude Code 2.1.304 或更新版本。** `ecc-progress`、`chatlog` 和 `session-board` 是 mod。mod 使用函数钩子，这是一个抢先体验的 API，可能随 Claude Code 版本变化。
- **ECC 2.2.3**，`ecc-progress` 和 `ecc-doc-check` 需要。两者都读取 ECC 生成的文档，依赖的格式见 [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md)。
- **Python 3.10+**，`ecc-doc-check`、chatlog 回放脚本和 session-board 看板服务需要。

## 安装

先添加插件市场，再安装需要的插件：

```bash
claude plugin marketplace add crystaldust/lancekit   # 也可以是本地克隆的路径
claude plugin install ecc-progress@lancekit
claude plugin install ecc-doc-check@lancekit
claude plugin install chatlog@lancekit
claude plugin install session-board@lancekit
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

### session-board

在大屏上集中显示局域网里所有会话，按"谁在等你"排序。每个会话把自己的状态、最后一次交代、最后一次回答的结尾和 ECC 进度上报给一个小型 Python 服务，大屏上用任意浏览器打开看板即可。

- **等批准**和**轮到你**的会话在上方显示为大卡片，带计时，站在远处也能看出该去哪个窗口、等了多久。等批准的卡片还显示等着批准的工具调用，例如 `Bash: pnpm test`。
- 工作中、失联和已退出的会话在下方显示为小卡片。
- 会话 30 秒没有上报就显示为失联；已退出的会话保留 10 分钟。

**1. 启动看板**，在接大屏的机器上：

```bash
python3 plugins/session-board/scripts/board.py --host 0.0.0.0 --token <令牌> --record states.jsonl
```

它会为每个监听地址打印一条链接，例如 `http://192.168.0.226:7777/?token=…`，在大屏上打开其中一条。不加 `--host` 时只监听 `127.0.0.1`；不给 `--token`（或 `SESSION_BOARD_TOKEN`）时随机生成一个令牌并打印出来。已安装的插件副本在 `~/.claude/plugins/` 下，也可以从克隆的仓库运行这个脚本。

**2. 让各台机器指向它。** 在 `/config` 的 session-board 下填 **Board URL**。可以直接粘贴打印出来的整条链接，里面的令牌会被使用，但这条链接会明文保存在设置里。想把令牌放进安全存储，就在 Board URL 里只填地址，令牌填在 **Token** 里：安装插件时 Claude Code 会询问这一项，`/config` 里不列出它。

| 选项 | 默认值 | 含义 |
|---|---|---|
| `boardUrl` | 空 | 看板地址，其中的 `?token=` 会被当作令牌 |
| `token` | 空 | 看板令牌，保存在安全存储里 |

保存选项后插件重新加载，会话随即开始上报。`/session-board` 显示看板地址、本会话的状态和最近一次上报的结果。

**给会话起名：** `/session-board name <名称>` 让卡片显示这个名称而不是项目名，同一项目开了几个会话也能分清。项目名移到下面一行。`/session-board name` 后面不写名称就是清除。名称一直保留到退出 Claude Code，`/clear` 和改选项都不影响。

**后台任务：** 一轮结束时如果还有后台任务在跑，这个会话显示为工作中，详情行写着任务情况（例如 `后台 2 个任务：shell · subagent`），先不会出现在“等你处理”里；超过 3 分钟任务还没做完，就照样转到“轮到你”（详情行仍写着任务情况），这样开着开发服务器的会话也会叫你。

**没有会话时先试看：** `python3 plugins/session-board/scripts/demo.py --token <令牌>` 推送 10 个模拟会话。

**核对一天的使用：** `python3 plugins/session-board/scripts/metrics.py states.jsonl` 读取记录文件，给出等批准时长（中位数、P90）、上报延迟和同时在线的会话数。

**局限。** 令牌是共享口令，看板用明文 HTTP，只在可信的网络里使用。看板的状态只在内存里，重启后各会话在下一次心跳（每 5 秒）时重新出现。数据契约见 [docs/session-board-contract.md](docs/session-board-contract.md)。

## 开发

```
.claude-plugin/marketplace.json   # lancekit 插件市场
plugins/ecc-progress/             # mod：hooks/register.tsx、hooks/parse.ts、测试
plugins/ecc-doc-check/            # skill：skills/prd-plan-audit（SKILL.md、scripts/、tests/）
plugins/chatlog/                  # mod：hooks/、scripts/（回放）、skills/chatlog-replay
plugins/session-board/            # mod：hooks/（上报）；scripts/（看板服务、模拟数据、指标）；web/（大屏页面）
docs/session-board-contract.md    # session-board 上报端和看板服务之间的数据契约
docs/ecc-doc-formats.md           # ECC 插件依赖的 ECC 文档格式
```

校验、测试，以及不安装直接试用插件：

```bash
claude plugin validate .                          # 插件市场和各插件
claude plugin test plugins/ecc-progress
claude plugin test plugins/chatlog
claude plugin test plugins/session-board
(cd plugins/ecc-doc-check/skills/prd-plan-audit && python3 -m unittest discover -s tests)
(cd plugins/chatlog/scripts && python3 -m unittest test_chatlog_replay)
python3 -m unittest discover -s plugins/session-board/scripts
node --test plugins/session-board/web/page.test.mjs
claude --plugin-dir plugins/ecc-progress --plugin-dir plugins/chatlog --plugin-dir plugins/session-board   # 从工作区加载
```

每次加载 mod 时，Claude Code 会把生成的类型写到 `plugins/*/.claude-plugin/types/`，这个目录已被 git 忽略。

## 参与贡献

欢迎提交 issue 和 pull request。

- 使用 [Conventional Commits](https://www.conventionalcommits.org)：`feat:`、`fix:`、`docs:`、`chore:` 等。
- 插件的 `version`（在 `.claude-plugin/plugin.json` 里）单独用一个 `chore: bump <plugin> to X` 提交升级。已安装的副本按版本号缓存，不升版本号，用户就收不到改动。
- 提交 pull request 前，先运行上面的校验和测试。
- ECC 升级后，重新核对 [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md)，并同时更新 `plugins/ecc-progress/hooks/parse.ts` 和 `plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py`。`plugins/session-board/hooks/report.ts` 读取 ecc-progress 的状态，也要一并核对。

## 许可证

[MIT](LICENSE) © 2026 crystaldust
