# lancekit

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.304-d97757)](https://code.claude.com)
[![ECC](https://img.shields.io/badge/ECC-2.2.3-555)](https://github.com/affaan-m/ECC)

A [Claude Code](https://code.claude.com) plugin marketplace with three plugins:

- Two extensions for the [ECC](https://github.com/affaan-m/ECC) workflow, `/ecc:prp-prd` → `/ecc:prp-plan` → `/ecc:prp-implement`: a live progress pane, and a consistency audit of the planning documents.
- A real-time chatlog of every session.

## Contents

- [Plugins](#plugins)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
  - [ecc-progress](#ecc-progress)
  - [ecc-doc-check](#ecc-doc-check)
  - [chatlog](#chatlog)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Plugins

| Plugin | Kind | What it does |
|---|---|---|
| [`ecc-progress`](plugins/ecc-progress) | mod | A side pane and status line showing PRD phases and live `/prp-implement` task and phase progress |
| [`ecc-doc-check`](plugins/ecc-doc-check) | skill | A read-only audit of PRDs, PRP-PRDs and plans. It finds status drift, invalid statuses, broken or archived links, and orphan plans |
| [`chatlog`](plugins/chatlog) | mod + skill + script | Writes every prompt, answer and tool call to `.claude/chatlog/` as it happens, and replays or exports the logs |

A *mod* is a plugin built on Claude Code's function hooks (`hooks/register.tsx`). It can draw panes, set the status line and register commands and tools.

## Requirements

- **Claude Code 2.1.304 or newer.** `ecc-progress` and `chatlog` are mods. Mods use function hooks, an early-access API that may change between Claude Code releases.
- **ECC 2.2.3** for `ecc-progress` and `ecc-doc-check`. Both read the documents ECC writes; [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md) lists the formats they depend on.
- **Python 3.10+** for `ecc-doc-check` and the chatlog replay script.

## Installation

Add the marketplace, then install the plugins you want:

```bash
claude plugin marketplace add crystaldust/lancekit   # or a local path to a clone
claude plugin install ecc-progress@lancekit
claude plugin install ecc-doc-check@lancekit
claude plugin install chatlog@lancekit
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

## Development

```
.claude-plugin/marketplace.json   # the lancekit marketplace
plugins/ecc-progress/             # mod: hooks/register.tsx, hooks/parse.ts, tests
plugins/ecc-doc-check/            # skill: skills/prd-plan-audit (SKILL.md, scripts/, tests/)
plugins/chatlog/                  # mod: hooks/, scripts/ (replay), skills/chatlog-replay
docs/ecc-doc-formats.md           # the ECC formats the ECC plugins depend on
```

Validate, test, and try the plugins without installing them:

```bash
claude plugin validate .                          # marketplace + plugins
claude plugin test plugins/ecc-progress
claude plugin test plugins/chatlog
(cd plugins/ecc-doc-check/skills/prd-plan-audit && python3 -m unittest discover -s tests)
(cd plugins/chatlog/scripts && python3 -m unittest test_chatlog_replay)
claude --plugin-dir plugins/ecc-progress --plugin-dir plugins/chatlog   # load from the working tree
```

Claude Code writes generated types to `plugins/*/.claude-plugin/types/` each time a mod loads. They are git-ignored.

## Contributing

Issues and pull requests are welcome.

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `chore:` and so on.
- Bump a plugin's `version` in its `.claude-plugin/plugin.json` in a separate `chore: bump <plugin> to X` commit. Installed copies are cached by version, so without a bump users do not receive the change.
- Run the validation and tests above before opening a pull request.
- After an ECC upgrade, re-check [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md). Update `plugins/ecc-progress/hooks/parse.ts` and `plugins/ecc-doc-check/skills/prd-plan-audit/scripts/audit.py` together.

## License

[MIT](LICENSE) © 2026 crystaldust
