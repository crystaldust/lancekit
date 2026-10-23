import type { ChatEvent, SessionAction } from '../types'

/** Width of the `[HH:MM:SS] ` time column in the text log; continuation lines indent to it. */
const GUTTER = ' '.repeat(11)

const ACTION_LABEL: Record<SessionAction, string> = {
  start: 'started',
  resume: 'resumed',
  clear: 'started after /clear',
  compact: 'compacted',
  fork: 'forked',
}

export type LocalTime = { date: string; time: string; offset: string }

export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** `+0800` (what `date +%z` prints) as minutes east of UTC. */
export function parseOffset(text: string): number {
  const match = text.trim().match(/^([+-])(\d{2}):?(\d{2})$/)
  if (!match) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return match[1] === '-' ? -minutes : minutes
}

export function localTime(ts: string, tzMinutes: number): LocalTime {
  const shifted = new Date(Date.parse(ts) + tzMinutes * 60_000).toISOString()
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 19), offset: offsetLabel(tzMinutes) }
}

/** `2026-10-23_153012`, the log file's name prefix. */
export function fileStamp(ts: string, tzMinutes: number): string {
  const { date, time } = localTime(ts, tzMinutes)
  return `${date}_${time.replace(/:/g, '')}`
}

const fence = (text: string): string => {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}text\n${text}\n${ticks}\n\n`
}

export const resultLines = (event: Extract<ChatEvent, { kind: 'result' }>): string[] => {
  const head = event.preview.length === 0 ? ['(no output)'] : event.preview
  const more = event.totalLines - event.preview.length
  const lines = head.map((line, index) => (index === 0 ? `⎿  ${event.isError ? 'Error: ' : ''}${line}` : `   ${line}`))
  return more > 0 ? [...lines, `   … +${more} lines`] : lines
}

export const turnNote = (reason: string): string | undefined =>
  reason === 'aborted'
    ? 'Interrupted by user'
    : reason === 'error'
      ? 'Turn ended with an error'
      : reason === 'refusal'
        ? 'Claude declined to answer'
        : undefined

export function markdownHeader(sessionId: string, cwd: string, ts: string, tzMinutes: number): string {
  const { date, time, offset } = localTime(ts, tzMinutes)
  return `# Claude Code chatlog\n\n- Session: \`${sessionId}\`\n- Project: \`${cwd}\`\n- Created: ${date} ${time} ${offset}\n`
}

export function textHeader(sessionId: string, cwd: string, ts: string, tzMinutes: number): string {
  const { date, time, offset } = localTime(ts, tzMinutes)
  return `Claude Code chatlog\nSession: ${sessionId}\nProject: ${cwd}\nCreated: ${date} ${time} ${offset}\n`
}

export function toMarkdown(event: ChatEvent, tzMinutes: number): string {
  const { date, time, offset } = localTime(event.ts, tzMinutes)
  switch (event.kind) {
    case 'session':
      return `\n---\n\n**▶ Session ${ACTION_LABEL[event.action]}** · ${date} ${time} ${offset}\n\n`
    case 'end':
      return `\n**■ Session ended** (${event.reason}) · ${date} ${time} ${offset}\n\n`
    case 'user': {
      const label = event.via === 'command' ? ' · command' : event.via === 'queued' ? ' · queued' : ''
      const quoted = event.text.split('\n').map(line => `> ${line}`).join('\n')
      return `### › ${time}${label}\n\n${quoted}\n\n`
    }
    case 'assistant':
      return `**⏺ Claude** · ${time}\n\n${event.text}\n\n`
    case 'tool':
      return fence(`⏺ ${event.name}(${event.summary})  · ${time}`)
    case 'result':
      return fence(resultLines(event).map(line => `  ${line}`).join('\n'))
    case 'turn': {
      const note = turnNote(event.reason)
      return note ? `> ⚠️ **${note}** · ${time}\n\n` : ''
    }
    case 'note':
      return `_${event.text} · ${time}_\n\n`
  }
}

const withGutter = (head: string, text: string): string => {
  const [first = '', ...rest] = text.split('\n')
  return [`${head}${first}`, ...rest.map(line => `${GUTTER}${line}`)].join('\n') + '\n'
}

export function toText(event: ChatEvent, tzMinutes: number): string {
  const { date, time, offset } = localTime(event.ts, tzMinutes)
  const stamp = `[${time}] `
  switch (event.kind) {
    case 'session':
      return `\n===== ${date} ${time} ${offset}  session ${ACTION_LABEL[event.action]}  id=${event.sessionId} =====\n\n`
    case 'end':
      return `\n===== ${date} ${time} ${offset}  session ended (${event.reason}) =====\n`
    case 'user':
      return '\n' + withGutter(`${stamp}> `, event.via ? `${event.text}  (${event.via})` : event.text) + '\n'
    case 'assistant':
      return withGutter(`${stamp}⏺ `, event.text) + '\n'
    case 'tool':
      return `${stamp}⏺ ${event.name}(${event.summary})\n`
    case 'result':
      return resultLines(event).map(line => `${GUTTER}  ${line}`).join('\n') + '\n'
    case 'turn': {
      const note = turnNote(event.reason)
      return note ? `${GUTTER}  ⎿  ${note}\n\n` : ''
    }
    case 'note':
      return `${stamp}· ${event.text}\n`
  }
}
