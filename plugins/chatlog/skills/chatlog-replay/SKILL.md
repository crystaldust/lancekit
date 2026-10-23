---
name: chatlog-replay
description: Find, read and replay Claude Code session chatlogs recorded by the chatlog plugin under .claude/chatlog (JSONL + Markdown + text). Use when the user asks to see, replay, restore, search or summarize an earlier conversation or session, or asks what was said or done in a past session. 中文触发：回放对话、复现会话、查看之前的对话记录、聊天记录、会话日志。
---

# Chatlog replay

The chatlog plugin writes every session of this project to `.claude/chatlog/`:

- `<YYYY-MM-DD_HHMMSS>_<session-id-8>.jsonl`: one event per line, the source of truth
- `.md` and `.txt` beside it: readable copies
- Each JSONL event has `kind` (`session`, `user`, `assistant`, `tool`, `result`, `turn`, `note`, `end`) and `ts` (UTC ISO 8601). `turn` with `reason: "aborted"` is an interrupt; `session` carries `action` (`start`, `resume`, `clear`, `compact`, `fork`); `end` carries the exit `reason`.

## Show it to the person

Replay output is for the person's eyes, not yours. Offer both ways and let them pick:

1. **Inside Claude Code**: they run `/chatlog list`, then `/chatlog replay <n>` (a side pane, scrolled with the keys while focused).
2. **In their terminal**: they run (typing `!` first runs it in this session)

   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/scripts/chatlog_replay.py" --list
   python3 "${CLAUDE_PLUGIN_ROOT}/scripts/chatlog_replay.py" <n> | less -R
   ```

   Flags: `--play [--speed 4]` replays with the session's own pacing, `--follow` tails a live log, `--no-color` for plain text.

## Answer questions about a past session

Read the `.md` (or grep the `.jsonl`) yourself, then answer with times and quotes from the log. Do not paste the whole log back.

## Notes

- Tool calls are kept as a one-line summary and the first lines of their result, not full output.
- Secrets are masked before they reach disk when the plugin's `redact` option is on (the default).
- A session killed without a clean exit has no `end` event; its last line is the last thing recorded.
