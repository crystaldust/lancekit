# lancekit

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.304-d97757)](https://code.claude.com)
[![ECC](https://img.shields.io/badge/ECC-2.2.3-555)](https://github.com/affaan-m/ECC)

A [Claude Code](https://code.claude.com) plugin marketplace with four plugins:

- Two extensions for the [ECC](https://github.com/affaan-m/ECC) workflow, `/ecc:prp-prd` → `/ecc:prp-plan` → `/ecc:prp-implement`: a live progress pane, and a consistency audit of the planning documents.
- A real-time chatlog of every session.
- A wall board that shows, across machines, which sessions are waiting on you.

## Contents

- [Plugins](#plugins)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
  - [ecc-progress](#ecc-progress)
  - [ecc-doc-check](#ecc-doc-check)
  - [chatlog](#chatlog)
  - [session-board](#session-board)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Plugins

| Plugin | Kind | What it does |
|---|---|---|
| [`ecc-progress`](plugins/ecc-progress) | mod | A side pane and status line showing PRD phases and live `/prp-implement` task and phase progress |
| [`ecc-doc-check`](plugins/ecc-doc-check) | skill | A read-only audit of PRDs, PRP-PRDs and plans. It finds status drift, invalid statuses, broken or archived links, and orphan plans |
| [`chatlog`](plugins/chatlog) | mod + skill + script | Writes every prompt, answer and tool call to `.claude/chatlog/` as it happens, and replays or exports the logs |
| [`session-board`](plugins/session-board) | mod + script | Reports every session's state to a wall display that shows who is waiting on you, across machines on a LAN |

A *mod* is a plugin built on Claude Code's function hooks (`hooks/register.tsx`). It can draw panes, set the status line and register commands and tools.

## Requirements

- **Claude Code 2.1.304 or newer.** `ecc-progress`, `chatlog` and `session-board` are mods. Mods use function hooks, an early-access API that may change between Claude Code releases.
- **ECC 2.2.3** for `ecc-progress` and `ecc-doc-check`. Both read the documents ECC writes; [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md) lists the formats they depend on.
- **Python 3.10+** for `ecc-doc-check`, the chatlog replay script and the session-board server.

## Installation

Add the marketplace, then install the plugins you want:

```bash
claude plugin marketplace add crystaldust/lancekit   # or a local path to a clone
claude plugin install ecc-progress@lancekit
claude plugin install ecc-doc-check@lancekit
claude plugin install chatlog@lancekit
claude plugin install session-board@lancekit
```

To update, refresh the marketplace and update the plugin, then start a new session:

```bash
claude plugin marketplace update lancekit
claude plugin update ecc-progress@lancekit
```

Claude Code caches each installed plugin by its version, so an update arrives only after its version number changes.

To uninstall a plugin, run `claude plugin uninstall <plugin>@lancekit`.

## Usage

### ecc-progress

A pane beside the transcript shows the newest PRD's phases and the tasks of one plan:

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

- **Opening the pane.** It opens by itself in the fullscreen layout when the PRD has unfinished phases or a run is under way. Otherwise, type `/ecc-progress`. It docks on the right at 110 columns or wider. In a narrower terminal, or on the main screen (for example under tmux), it sits above the prompt. The reply to `/ecc-progress` says where it went, or why it is not shown.
- **Status line.** The line reads `ECC M3/8 ▶4 · T3/14 · EXECUTE`: completed and total PRD phases, the phases in progress, then during a run the tasks done and the current phase.
- **Which plan it shows.**
  - During `/prp-implement`, the plan being run.
  - Otherwise, the open plan linked from the PRD's in-progress phase, then from a pending phase.
  - Without a PRD, the newest open plan, then the newest archived one.
- **Live progress.** The plugin gives the model a `mcp__ecc-progress__report` tool and asks it to report each phase and each task as it starts and finishes. It also reads the `[done] Task N` lines `/prp-implement` writes. The pane refreshes after file edits and every 4 seconds. A run ends when its plan moves to `completed/`.
- **Tasks** are `### Task N: name` headings. A range such as `### Task 5–12: name` counts as tasks 5 to 12.

### ecc-doc-check

Ask Claude to check or audit your PRDs and plans (for example "check whether the PRD and plan statuses agree"), or run the `prd-plan-audit` skill. It reports problems and suggested fixes and changes nothing until you approve.

The deterministic checks also run on their own:

```bash
python3 plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py --root <project> [--json]
```

The script exits with 1 when it finds an ERROR and 2 when the project has no `.claude/` folder.

| Finding | Level | Meaning |
|---|---|---|
| `status-drift` | ERROR | A parent PRD row disagrees with the combined status of its child PRD |
| `invalid-status` | ERROR | A status other than `pending`, `in-progress` or `complete` |
| `missing-path` | ERROR | A linked file is missing. If a file of the same name exists elsewhere (usually `completed/`), the finding gives that path |
| `missing-source-prd` | ERROR | A plan's `Source PRD` does not exist |
| `orphan-plan` | WARN | A plan names a Source PRD, but no PRD row links to it |
| `no-plan` | WARN | A started row links no plan or PRD |
| `standalone-plan` | INFO | A plan with no Source PRD that nothing links to |
| `stale-footer` | INFO | A PRD still says planning is pending although its milestones have started |

After the script, the skill reviews what the script cannot judge: commits, filled-in test checklists and implementation reports for each milestone in progress or complete.

### chatlog

Each session is written to `.claude/chatlog/<YYYY-MM-DD_HHMMSS>_<session-id-8>.{jsonl,md,txt}`.

- Each prompt reaches the disk before the model sees it, and every line carries its time.
- The log records interrupts, exits, `/clear` and compaction.
- A resumed session keeps appending to its own file.

| Command | What it does |
|---|---|
| `/chatlog` | Shows the files being written |
| `/chatlog list` | Lists recent logs |
| `/chatlog replay [n\|name]` | Replays a log in a side pane |
| `/chatlog gen_html` | Exports every log to `.claude/chatlog/chatlog.html`, oldest session first |

**Replay in a terminal:**

```bash
python3 plugins/chatlog/scripts/chatlog_replay.py [n|path] [--list] [--play] [--follow] [--no-color]
```

The bundled `chatlog-replay` skill lets Claude find, read and summarize past sessions when you ask about them.

**The HTML export.**
- Each answer shows its final text. The tool calls and text before it fold into a closed section.
- Prompts and answers render as Markdown, using pinned, hash-checked `marked` and `DOMPurify` from cdnjs. Offline, the page shows plain text.
- Logs over 4 MiB are skipped, and the page names them.

**Options.** Set these in `/config` or under `pluginConfigs.chatlog` in settings:

| Option | Default | Meaning |
|---|---|---|
| `formats` | `md+txt` | Readable files written beside the JSONL: `md+txt`, `md` or `txt` |
| `gitignore` | `true` | Writes a `.gitignore` that keeps the chatlog folder out of git |
| `redact` | `true` | Masks API keys, tokens, private keys and `password=` values before they reach disk |

### session-board

A wall display of every session on your LAN, ordered by who is waiting on you. Each session reports its state, its last prompt, the end of its last answer and its ECC progress to a small Python server; any browser on a big screen shows the board.

- **等批准 (needs approval)** and **轮到你 (your turn)** sessions get large cards at the top with a timer, so you can tell from across the room which window to go to and how long it has waited. An approval card shows the tool call waiting, for example `Bash: pnpm test`.
- Working, lost and ended sessions get small cards below.
- A session that stops reporting for 30 seconds shows as lost. An ended session stays for 10 minutes.

**1. Start the board** on the machine attached to the screen:

```bash
python3 plugins/session-board/scripts/board.py --host 0.0.0.0 --token <token> --record states.jsonl
```

It prints a link for every address it listens on, such as `http://192.168.0.226:7777/?token=…`. Open one on the big screen. Without `--host` it listens on `127.0.0.1` only. Without `--token` (or `SESSION_BOARD_TOKEN`) it makes up a token and prints it. The plugin's installed copy lives under `~/.claude/plugins/`; you can also run the script from a clone.

**2. Point each machine at it.** In `/config`, under session-board, set **Board URL**. You can paste the whole printed link: the token in it is used. That link is then stored in plain settings. To keep the token in secure storage, put only the address in Board URL and give the token in **Token**, which Claude Code asks for when the plugin is installed and does not list in `/config`.

| Option | Default | Meaning |
|---|---|---|
| `boardUrl` | empty | The board's address. A `?token=` in it is used as the token |
| `token` | empty | The board's token, kept in secure storage |

Saving the option reloads the plugin, and the session starts reporting. `/session-board` shows the board address, this session's state and the result of its last report.

**Name a session:** `/session-board name <name>` puts that name on the card in place of the project name, so two sessions in one project are easy to tell apart. The project moves to the line below. `/session-board name` with no name clears it. The name is saved with the conversation and restored when it is reopened with `--resume`, `--continue` or `/resume`. `/clear` and option changes keep it. It is stored on this machine only, and a name not renamed or reopened for 90 days is forgotten (at most 200 are kept).

**Background tasks:** a session whose turn ended with background tasks still running shows as working, with the tasks in its detail line (for example `后台 2 个任务：shell · subagent`), not under "waiting on you". If the tasks have not finished after 3 minutes, it moves to "your turn" anyway (the tasks stay in the detail line), so a dev server still gets your attention.

**Try it without sessions:** `python3 plugins/session-board/scripts/demo.py --token <token>` pushes ten made-up sessions.

**Check a day of use:** `python3 plugins/session-board/scripts/metrics.py states.jsonl` reads the record file and reports the approval wait (median, P90), the report delay and the peak number of sessions online.

**Limits.** The token is a shared password and the board speaks plain HTTP, so run it on a network you trust. The board keeps state in memory only: after a restart, sessions reappear with their next heartbeat (every 5 seconds). The data contract is [docs/session-board-contract.md](docs/session-board-contract.md).

## Development

```
.claude-plugin/marketplace.json   # the lancekit marketplace
plugins/ecc-progress/             # mod: hooks/register.tsx, hooks/parse.ts, tests
plugins/ecc-doc-check/            # skill: skills/prd-plan-audit (SKILL.md, scripts/, tests/)
plugins/chatlog/                  # mod: hooks/, scripts/ (replay), skills/chatlog-replay
plugins/session-board/            # mod: hooks/ (reporter); scripts/ (board server, demo, metrics); web/ (wall page)
docs/session-board-contract.md    # the data contract between the session-board reporter and server
docs/ecc-doc-formats.md           # the ECC formats the ECC plugins depend on
```

Validate, test, and try the plugins without installing them:

```bash
claude plugin validate .                          # marketplace + plugins
claude plugin test plugins/ecc-progress
claude plugin test plugins/chatlog
claude plugin test plugins/session-board
(cd plugins/ecc-doc-check/skills/prd-plan-audit && python3 -m unittest discover -s tests)
(cd plugins/chatlog/scripts && python3 -m unittest test_chatlog_replay)
python3 -m unittest discover -s plugins/session-board/scripts
node --test plugins/session-board/web/page.test.mjs
claude --plugin-dir plugins/ecc-progress --plugin-dir plugins/chatlog --plugin-dir plugins/session-board   # load from the working tree
```

Claude Code writes generated types to `plugins/*/.claude-plugin/types/` each time a mod loads. They are git-ignored.

## Contributing

Issues and pull requests are welcome.

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `chore:` and so on.
- Bump a plugin's `version` in its `.claude-plugin/plugin.json` in a separate `chore: bump <plugin> to X` commit. Installed copies are cached by version, so without a bump users do not receive the change.
- Run the validation and tests above before opening a pull request.
- After an ECC upgrade, re-check [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md). Update `plugins/ecc-progress/hooks/parse.ts` and `plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py` together. `plugins/session-board/hooks/report.ts` reads ecc-progress's state, so check it too.

## License

[MIT](LICENSE) © 2026 crystaldust
