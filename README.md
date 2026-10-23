# lancekit

A Claude Code plugin marketplace: extensions for the
[ECC](https://github.com/affaan-m/ECC) PRD → PRP plan → `/prp-implement` workflow, and session chatlogs.

| Plugin | Kind | What it does |
|---|---|---|
| [`ecc-progress`](plugins/ecc-progress) | mod (function hooks) | Side pane with PRD milestones and live `/prp-implement` task / phase progress; `/ecc-progress` opens it |
| [`ecc-doc-check`](plugins/ecc-doc-check) | skill | Read-only audit of PRDs, PRP-PRDs and plans for status drift, invalid statuses, broken or archived links and orphan plans |
| [`chatlog`](plugins/chatlog) | mod + skill + script | Writes every prompt, answer and tool call to `.claude/chatlog/` as it happens (Markdown, text, JSONL), with interrupts, exits, `/clear`, compaction and resume; `/chatlog replay` and `scripts/chatlog_replay.py` replay a log in terminal style |

## Requirements

- Claude Code 2.1.304 or newer. `ecc-progress` and `chatlog` are mods (function hooks), an early-access API that may change between Claude Code releases.
- `ecc-progress` and `ecc-doc-check` read the documents of [ECC](https://github.com/affaan-m/ECC) 2.2.3 (see [docs/ecc-doc-formats.md](docs/ecc-doc-formats.md)).
- `ecc-doc-check` and the chatlog replay script need Python 3.10+.

## Install

```bash
claude plugin marketplace add crystaldust/lancekit   # or a local path to a clone
claude plugin install ecc-progress@lancekit
claude plugin install ecc-doc-check@lancekit
claude plugin install chatlog@lancekit
```

## chatlog

- Files: `.claude/chatlog/<YYYY-MM-DD_HHMMSS>_<session-id-8>.{jsonl,md,txt}`; a resumed session keeps appending to its own file.
- Each prompt is on disk before the model sees it; every line carries its time.
- Options (`/config` or `pluginConfigs.chatlog` in settings): `formats` (`md+txt` | `md` | `txt`), `gitignore` (default on: the folder ignores itself), `redact` (default on: API keys, tokens, private keys, `password=` values are masked).
- `/chatlog` shows the files being written, `/chatlog list` the recent logs, `/chatlog replay [n|name]` a side-pane replay.
- In a terminal: `python3 plugins/chatlog/scripts/chatlog_replay.py [n|path] [--list] [--play] [--follow] [--no-color]`.

## Layout

```
.claude-plugin/marketplace.json   # the lancekit marketplace
plugins/ecc-progress/             # mod: hooks/register.tsx, hooks/parse.ts, tests
plugins/ecc-doc-check/            # skill: skills/prd-plan-audit (SKILL.md, scripts/, tests/)
plugins/chatlog/                  # mod: hooks/ (register, events, render, redact, tests); scripts/ replay; skills/chatlog-replay
docs/ecc-doc-formats.md           # ECC formats both plugins depend on
```

## Develop

```bash
claude plugin validate .                          # marketplace + plugins
claude plugin test plugins/ecc-progress
(cd plugins/ecc-doc-check/skills/prd-plan-audit && python3 -m unittest discover -s tests)
claude plugin test plugins/chatlog
(cd plugins/chatlog/scripts && python3 -m unittest test_chatlog_replay)
claude --plugin-dir plugins/ecc-progress --plugin-dir plugins/ecc-doc-check   # try without installing
```
