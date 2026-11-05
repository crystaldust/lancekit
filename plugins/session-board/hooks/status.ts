// What a session is doing, derived from its events. Pure: every function returns a new value.

export type SessionState = 'working' | 'needs-approval' | 'your-turn' | 'ended'

export type Stamped<T> = T & { at: number }

export type Status = {
  state: SessionState
  /** When the session entered `state`, in `$.clock.now()` milliseconds. */
  since: number
  detail: string | null
  lastPrompt: Stamped<{ text: string }> | null
  lastAnswer: Stamped<{ tail: string[] }> | null
}

export const DETAIL_CHARS = 200
export const PROMPT_CHARS = 2000
export const TAIL_LINES = 10
export const TAIL_LINE_CHARS = 500
export const NAME_CHARS = 40

/** Control characters and the invisible marks that reorder or hide text; a name shows none of them. */
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/**
 * `text` cut to at most `max` UTF-16 units without splitting a surrogate pair:
 * a lone half would be invalid Unicode, which the board rejects.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastCode = cut.charCodeAt(cut.length - 1)
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? cut.slice(0, -1) : cut
}

export function initialStatus(now: number): Status {
  return { state: 'your-turn', since: now, detail: null, lastPrompt: null, lastAnswer: null }
}

/** Moves to `state`; `since` changes only when the state does, so a repeat is a no-op. */
export function enter(status: Status, state: SessionState, now: number, detail: string | null = null): Status {
  if (status.state === state && status.detail === detail) return status
  return { ...status, state, since: status.state === state ? status.since : now, detail }
}

export function withPrompt(status: Status, text: string, now: number): Status {
  const trimmed = text.trim()
  if (trimmed === '') return status
  return { ...status, lastPrompt: { text: clip(trimmed, PROMPT_CHARS), at: now } }
}

export function withAnswer(status: Status, answer: string, now: number): Status {
  const tail = answerTail(answer)
  if (tail.length === 0) return status
  return { ...status, lastAnswer: { tail, at: now } }
}

/** The answer's last lines, trailing blank lines dropped, as the board shows them. */
export function answerTail(text: string): string[] {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed.trim() === '') return []
  return trimmed.split('\n').slice(-TAIL_LINES).map(line => clip(line, TAIL_LINE_CHARS))
}

/** A short line naming what is waiting: `Bash: pnpm test`, `Write: src/a.ts`, or the tool's name. */
export function toolDetail(tool: string, input: unknown): string {
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const subject = ['command', 'file_path', 'path', 'url', 'pattern', 'description']
    .map(key => fields[key])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const line = subject ? `${tool}: ${subject.replace(/\s+/g, ' ').trim()}` : tool
  return clip(line, DETAIL_CHARS)
}

/** The first question an AskUserQuestion call asks, as a detail line. */
export function questionDetail(input: unknown): string {
  const questions = (input as { questions?: { question?: unknown }[] } | null)?.questions
  const first = Array.isArray(questions) ? questions[0]?.question : undefined
  const line = typeof first === 'string' && first.trim() !== '' ? `提问: ${first.trim()}` : '提问'
  return clip(line.replace(/\s+/g, ' '), DETAIL_CHARS)
}

/** The name a person gives the session, tidied for one line on the board; null for none. */
export function sessionName(text: string): string | null {
  const tidy = text.replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim()
  return tidy === '' ? null : clip(tidy, NAME_CHARS).trim()
}

const BACKGROUND_TYPES_SHOWN = 3

/** `后台 2 个任务：shell · subagent`: how many tasks run behind the turn, and of which kinds. */
export function backgroundDetail(tasks: readonly { type: string }[]): string {
  const types = [...new Set(tasks.map(task => task.type))]
  const shown = types.slice(0, BACKGROUND_TYPES_SHOWN).join(' · ')
  const more = types.length > BACKGROUND_TYPES_SHOWN ? ' 等' : ''
  return clip(`后台 ${tasks.length} 个任务：${shown}${more}`, DETAIL_CHARS)
}
