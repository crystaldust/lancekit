import type { ChatEvent } from '../types'

const PREVIEW_LINES = 3
const LINE_CHARS = 160
const SUMMARY_CHARS = 80

/** The tool input field that best names what a call did, as the terminal shows it: `Bash(git status)`. */
const PRIMARY_ARG: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Agent: 'description',
  Task: 'description',
  Skill: 'skill',
}

type Block = {
  type?: unknown
  text?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

/** The parts of a `session.append` row this module reads. */
export type Row = {
  door: string
  message: { type?: string; isMeta?: boolean; content?: unknown }
  origin?: { kind?: string }
}

const blocksOf = (content: unknown): Block[] =>
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? content.filter((block): block is Block => typeof block === 'object' && block !== null)
      : []

export const textOfContent = (content: unknown): string =>
  blocksOf(content)
    .filter(block => block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n')

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const firstLine = (text: string): string => text.split('\n')[0] ?? ''

const tagged = (text: string, tag: string): string | undefined =>
  text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]

export function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const key = PRIMARY_ARG[name] ?? Object.keys(fields).find(field => typeof fields[field] === 'string')
  const value = key === undefined ? undefined : fields[key]
  return typeof value === 'string' ? clip(firstLine(value).trim(), SUMMARY_CHARS) : ''
}

export function previewOf(text: string): { preview: string[]; totalLines: number } {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed.trim() === '') return { preview: [], totalLines: 0 }
  const lines = trimmed.split('\n')
  return {
    preview: lines.slice(0, PREVIEW_LINES).map(line => clip(line, LINE_CHARS)),
    totalLines: lines.length,
  }
}

function fromCommandRow(text: string, ts: string): ChatEvent[] {
  const name = tagged(text, 'command-name')
  if (name !== undefined) {
    const args = tagged(text, 'command-args') ?? ''
    return [{ kind: 'user', ts, text: `${name.trim()} ${args.trim()}`.trim(), via: 'command' }]
  }
  const stdout = tagged(text, 'local-command-stdout')
  if (stdout === undefined) return []
  return [{ kind: 'result', ts, id: 'command', isError: false, ...previewOf(stdout) }]
}

function fromResponse(content: unknown, ts: string): ChatEvent[] {
  return blocksOf(content).flatMap((block): ChatEvent[] => {
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      return text.trim() === '' ? [] : [{ kind: 'assistant', ts, text }]
    }
    if (block.type === 'tool_use') {
      const name = String(block.name ?? 'tool')
      return [{ kind: 'tool', ts, id: String(block.id ?? ''), name, summary: summarizeToolInput(name, block.input) }]
    }
    return []
  })
}

function fromToolResults(content: unknown, ts: string): ChatEvent[] {
  return blocksOf(content)
    .filter(block => block.type === 'tool_result')
    .map(block => ({
      kind: 'result' as const,
      ts,
      id: String(block.tool_use_id ?? ''),
      isError: block.is_error === true,
      ...previewOf(typeof block.content === 'string' ? block.content : textOfContent(block.content)),
    }))
}

/** Turns one row the main conversation stores into the log events it stands for. */
export function eventsFromRow(row: Row, ts: string): ChatEvent[] {
  const { door, message } = row
  if (message.isMeta) return []
  const text = textOfContent(message.content)
  switch (door) {
    case 'prompt':
      return text.trim() === '' ? [] : [{ kind: 'user', ts, text }]
    case 'delivery':
      return row.origin?.kind === 'composer' && text.trim() !== ''
        ? [{ kind: 'user', ts, text, via: 'queued' }]
        : []
    case 'command':
      return fromCommandRow(text, ts)
    case 'response':
      return fromResponse(message.content, ts)
    case 'tool-result':
      return fromToolResults(message.content, ts)
    case 'compaction':
      return message.type === 'system' ? [{ kind: 'note', ts, text: 'Conversation compacted' }] : []
    default:
      return []
  }
}
