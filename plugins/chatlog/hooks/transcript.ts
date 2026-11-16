import type { ChatEvent } from '../types'
import { eventsFromRow, textOfContent } from './events'

/** One line of Claude Code's own transcript (`~/.claude/projects/<project>/<session-id>.jsonl`), the parts read here. */
type TranscriptRow = {
  type?: unknown
  subtype?: unknown
  timestamp?: unknown
  uuid?: unknown
  cwd?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  isCompactSummary?: unknown
  interruptedMessageId?: unknown
  durationMs?: unknown
  origin?: { kind?: unknown }
  message?: { content?: unknown }
}

/** What the transcript held before the chatlog began: when and where the session started, and its events. */
export type History = { startedAt: string; cwd: string; events: ChatEvent[] }

export const BACKFILL_NOTE = 'Earlier conversation recovered from the Claude Code transcript'

const COMMAND_TAG = /<(command-name|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>/
const INTERRUPTED = /^\[Request interrupted by user/

const hasToolResult = (content: unknown): boolean =>
  Array.isArray(content) && content.some(block => typeof block === 'object' && block?.type === 'tool_result')

/** The log events one transcript row stands for, read the way `session.append` rows are. */
function eventsOfRow(row: TranscriptRow, ts: string): ChatEvent[] {
  if (row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) return []
  if (row.type === 'system') {
    if (row.subtype === 'turn_duration') {
      return [{ kind: 'turn', ts, reason: 'answer', durationMs: typeof row.durationMs === 'number' ? row.durationMs : 0 }]
    }
    return row.subtype === 'compact_boundary' ? [{ kind: 'note', ts, text: 'Conversation compacted' }] : []
  }
  const content = row.message?.content
  if (row.type === 'assistant') return eventsFromRow({ door: 'response', message: { content } }, ts)
  if (row.type !== 'user') return []
  if (hasToolResult(content)) return eventsFromRow({ door: 'tool-result', message: { content } }, ts)
  const text = textOfContent(content)
  if (row.interruptedMessageId !== undefined || INTERRUPTED.test(text)) {
    return [{ kind: 'turn', ts, reason: 'aborted', durationMs: 0 }]
  }
  if (COMMAND_TAG.test(text)) return eventsFromRow({ door: 'command', message: { content } }, ts)
  const origin = row.origin?.kind
  if (origin !== undefined && origin !== 'human' && origin !== 'composer') return []
  return eventsFromRow({ door: 'prompt', message: { content } }, ts)
}

const timeOf = (line: string): number => {
  try {
    const row: unknown = JSON.parse(line)
    const ts = typeof row === 'object' && row !== null ? (row as TranscriptRow).timestamp : undefined
    return typeof ts === 'string' ? Date.parse(ts) : Number.NaN
  } catch {
    return Number.NaN
  }
}

/** Whether a transcript line is a row from `before` or later: reading can stop there. */
export const isAtOrAfter = (line: string, before: string): boolean => timeOf(line) >= Date.parse(before)

const isCommandOutput = (events: readonly ChatEvent[]): boolean =>
  events.every(event => event.kind === 'result' && event.id === 'command')

const isExit = (event: ChatEvent): boolean =>
  event.kind === 'user' && event.via === 'command' && /^\/(exit|quit)\b/.test(event.text)

/**
 * The conversation a transcript recorded before `before` (UTC ISO 8601), as log
 * events: opened by a `session` start and a note saying where it came from, an
 * `/exit` closing a run and the next row resuming it. Null when none of it is
 * conversation. Lines that are not JSON, and rows without a time, are skipped.
 */
export function historyFromTranscript(lines: readonly string[], sessionId: string, before: string): History | null {
  const cutoff = Date.parse(before)
  const seen = new Set<string>()
  const events: ChatEvent[] = []
  let startedAt: string | undefined
  /** The first working directory the rows name, and the latest. */
  let startCwd = ''
  let cwd = ''
  let exitedAt: string | undefined
  for (const line of lines) {
    let row: TranscriptRow
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) continue
      row = parsed as TranscriptRow
    } catch {
      continue
    }
    if (typeof row.timestamp !== 'string' || Number.isNaN(Date.parse(row.timestamp))) continue
    if (!(Date.parse(row.timestamp) < cutoff)) continue
    if (typeof row.uuid === 'string') {
      if (seen.has(row.uuid)) continue
      seen.add(row.uuid)
    }
    const ts = new Date(Date.parse(row.timestamp)).toISOString()
    startedAt ??= ts
    if (typeof row.cwd === 'string' && row.cwd !== '') {
      cwd = row.cwd
      startCwd ||= row.cwd
    }
    const found = eventsOfRow(row, ts)
    if (found.length === 0) continue
    if (exitedAt !== undefined && !isCommandOutput(found)) {
      events.push({ kind: 'end', ts: exitedAt, reason: 'exit' }, { kind: 'session', ts, action: 'resume', sessionId, cwd })
      exitedAt = undefined
    }
    events.push(...found)
    if (found.some(isExit)) exitedAt = ts
  }
  if (startedAt === undefined || events.length === 0) return null
  if (exitedAt !== undefined) events.push({ kind: 'end', ts: exitedAt, reason: 'exit' })
  return {
    startedAt,
    cwd: startCwd,
    events: [
      { kind: 'session', ts: startedAt, action: 'start', sessionId, cwd: startCwd },
      { kind: 'note', ts: startedAt, text: BACKFILL_NOTE },
      ...events,
    ],
  }
}
