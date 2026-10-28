export type SessionAction = 'start' | 'resume' | 'clear' | 'compact' | 'fork'

/** One line of the JSONL log (each line also carries `v: 1`). `ts` is UTC ISO 8601. */
export type ChatEvent =
  | { kind: 'session'; ts: string; action: SessionAction; sessionId: string; cwd: string }
  | { kind: 'end'; ts: string; reason: string }
  | { kind: 'user'; ts: string; text: string; via?: 'command' | 'queued' }
  | { kind: 'assistant'; ts: string; text: string }
  | { kind: 'tool'; ts: string; id: string; name: string; summary: string }
  | { kind: 'result'; ts: string; id: string; isError: boolean; preview: string[]; totalLines: number }
  | { kind: 'turn'; ts: string; reason: string; durationMs: number }
  | { kind: 'note'; ts: string; text: string }

export type LogState = {
  /** Absolute path of the log without extension, e.g. `/repo/.claude/chatlog/2026-10-23_153012_ab12cd34`. */
  base: string | null
  sessionId: string | null
  /** Local UTC offset in minutes, read once from `date +%z`. */
  tzMinutes: number | null
}

export type ReplayState = { name: string; path: string; events: ChatEvent[] } | null

declare module 'claude-code' {
  interface PluginState {
    chatlog: {
      log: LogState
      replay: ReplayState
    }
  }
}
