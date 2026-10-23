import type { ChatEvent } from '../types'

const MASK = '[REDACTED]'

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"']{6,}/gi, `$1${MASK}`],
]

export const redactText = (text: string): string =>
  SECRET_PATTERNS.reduce((masked, [pattern, mask]) => masked.replace(pattern, mask), text)

/** The event with every free-text field masked; ids and timestamps are left alone. */
export function redactEvent(event: ChatEvent): ChatEvent {
  switch (event.kind) {
    case 'user':
    case 'assistant':
    case 'note':
      return { ...event, text: redactText(event.text) }
    case 'tool':
      return { ...event, summary: redactText(event.summary) }
    case 'result':
      return { ...event, preview: event.preview.map(redactText) }
    default:
      return event
  }
}
