import type { ChatEvent } from '../types'
import { ACTION_LABEL, localTime, resultLines, turnNote } from './render'

/** A log as read from disk: its file name without extension, and its events. */
export type NamedLog = { name: string; events: ChatEvent[] }

type Step = Extract<ChatEvent, { kind: 'assistant' | 'tool' | 'result' }>
type Turn = Extract<ChatEvent, { kind: 'turn' }>
type Block =
  | { kind: 'marker'; event: Extract<ChatEvent, { kind: 'session' | 'end' | 'note' }> }
  | { kind: 'user'; event: Extract<ChatEvent, { kind: 'user' }> }
  | { kind: 'reply'; steps: Step[]; turn?: Turn }

/** `2026-10-23_153012_ab12cd34`: the local time the log file was named after. */
const FILE_STAMP = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})_/
const TITLE_CHARS = 80
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => ESCAPES[char] ?? char)

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

const stamp = (ts: string, tzMinutes: number): string => {
  if (Number.isNaN(Date.parse(ts))) return ''
  const { date, time, offset } = localTime(ts, tzMinutes)
  return `${date} ${time} ${offset}`
}

const clockOf = (ts: string, tzMinutes: number): string =>
  Number.isNaN(Date.parse(ts)) ? '' : `<time>${localTime(ts, tzMinutes).time}</time>`

/**
 * When the session began, as UTC ISO 8601: its first event's time, which moving
 * or renaming the folder leaves alone, else the time in its file name; '' if neither.
 */
export function logStart(log: NamedLog, tzMinutes: number): string {
  const first = log.events.find(event => !Number.isNaN(Date.parse(event.ts)))
  if (first) return new Date(Date.parse(first.ts)).toISOString()
  const match = log.name.match(FILE_STAMP)
  const local = match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : Number.NaN
  return Number.isNaN(local) ? '' : new Date(local - tzMinutes * 60_000).toISOString()
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Oldest session first; a log with no known start goes last. */
export function sortLogs(logs: readonly NamedLog[], tzMinutes: number): NamedLog[] {
  const keyOf = (log: NamedLog) => logStart(log, tzMinutes) || '￿'
  return [...logs].sort((a, b) => compare(keyOf(a), keyOf(b)) || compare(a.name, b.name))
}

/** The page anchor of a log, from its file name alone, so it needs no escaping. */
const anchorOf = (log: NamedLog): string => `log-${log.name.replace(/[^A-Za-z0-9_-]/g, '_')}`

/** Cuts a log into markers, prompts and replies; a reply runs until the next prompt, marker or turn end. */
function blocksOf(events: readonly ChatEvent[]): Block[] {
  const blocks: Block[] = []
  let steps: Step[] = []
  const close = (turn?: Turn) => {
    if (steps.length > 0 || turn) blocks.push({ kind: 'reply', steps, turn })
    steps = []
  }
  for (const event of events) {
    if (event.kind === 'assistant' || event.kind === 'tool' || event.kind === 'result') {
      steps = [...steps, event]
    } else if (event.kind === 'turn') {
      close(event)
    } else {
      close()
      blocks.push(event.kind === 'user' ? { kind: 'user', event } : { kind: 'marker', event })
    }
  }
  close()
  return blocks
}

function stepHtml(step: Step, tzMinutes: number): string {
  switch (step.kind) {
    case 'assistant':
      return `<div class="step text md">${escapeHtml(step.text)}</div>`
    case 'tool':
      return `<div class="step tool"><b>${escapeHtml(step.name)}</b>(<code>${escapeHtml(step.summary)}</code>) ${clockOf(step.ts, tzMinutes)}</div>`
    case 'result':
      return `<pre class="step result${step.isError ? ' error' : ''}">${escapeHtml(resultLines(step).join('\n'))}</pre>`
  }
}

/**
 * A reply shows its last words; everything the model did before them folds away,
 * closed. A result counts with its tool call, not as a step of its own.
 */
function replyHtml(steps: readonly Step[], turn: Turn | undefined, tzMinutes: number): string {
  const last = steps.at(-1)
  const answer = last?.kind === 'assistant' ? last : undefined
  const folded = answer ? steps.slice(0, -1) : steps
  const note = turn ? turnNote(turn.reason) : undefined
  if (folded.length === 0 && !answer && !note) return ''
  const stepCount = folded.filter(step => step.kind !== 'result').length
  const toolCount = folded.filter(step => step.kind === 'tool').length
  const label = stepCount === 0
    ? plural(folded.length, 'result')
    : `${plural(stepCount, 'step')} · ${plural(toolCount, 'tool call')}`
  const details = folded.length === 0
    ? ''
    : `<details class="steps"><summary>${label}</summary>${folded.map(step => stepHtml(step, tzMinutes)).join('')}</details>`
  const ts = answer?.ts ?? steps[0]?.ts ?? turn?.ts ?? ''
  return [
    `<div class="msg reply"><div class="who">Claude ${clockOf(ts, tzMinutes)}</div>`,
    details,
    answer ? `<div class="text md">${escapeHtml(answer.text)}</div>` : '',
    note ? `<p class="warn">⚠ ${escapeHtml(note)}</p>` : '',
    '</div>',
  ].join('')
}

function blockHtml(block: Block, tzMinutes: number): string {
  if (block.kind === 'reply') return replyHtml(block.steps, block.turn, tzMinutes)
  const { event } = block
  switch (event.kind) {
    case 'user': {
      const via = event.via ? ` · ${escapeHtml(event.via)}` : ''
      return `<div class="msg user"><div class="who">You${via} ${clockOf(event.ts, tzMinutes)}</div><div class="text md">${escapeHtml(event.text)}</div></div>`
    }
    case 'session':
      return `<div class="marker">▶ Session ${escapeHtml(ACTION_LABEL[event.action] ?? event.action)} · ${stamp(event.ts, tzMinutes)}</div>`
    case 'end':
      return `<div class="marker">■ Session ended (${escapeHtml(event.reason)}) · ${stamp(event.ts, tzMinutes)}</div>`
    case 'note':
      return `<div class="marker">· ${escapeHtml(event.text)} · ${stamp(event.ts, tzMinutes)}</div>`
  }
}

function titleOf(log: NamedLog): string {
  const prompt = log.events.find(event => event.kind === 'user')
  const text = prompt?.kind === 'user' ? prompt.text.split('\n')[0] ?? '' : ''
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text || log.name
}

/** One session's section. Throws on an event whose fields are not the strings and lists the log format promises. */
export function sessionHtml(log: NamedLog, tzMinutes: number): string {
  const session = log.events.find(event => event.kind === 'session')
  const cwd = session?.kind === 'session' ? session.cwd : ''
  const meta = [cwd, log.name].filter(Boolean).map(escapeHtml).join(' · ')
  const title = stamp(logStart(log, tzMinutes), tzMinutes) || escapeHtml(log.name)
  return [
    `<section class="session" id="${anchorOf(log)}">`,
    `<header><h2>${title}</h2><p class="meta">${meta}</p></header>`,
    ...blocksOf(log.events).map(block => blockHtml(block, tzMinutes)),
    '</section>\n',
  ].join('')
}

const STYLE = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e2e2dc;--user:#e8f0fe;--accent:#c96442;--error:#b42318;--code:#f1f1ed}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--panel:#232321;--text:#ececea;--muted:#9a9a94;--line:#363632;--user:#1f2c40;--accent:#e08a6a;--error:#f97066;--code:#2c2c29}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}
nav ol{padding-left:20px;color:var(--muted)}nav a{color:var(--accent)}
.session{margin-top:40px;border-top:1px solid var(--line);padding-top:16px}
.session h2{font-size:17px;margin:0}.meta{color:var(--muted);margin:2px 0 12px;font-size:13px;word-break:break-all}
.marker{color:var(--muted);font-size:13px;text-align:center;margin:14px 0}
.msg{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0}
.msg.user{background:var(--user);margin-left:48px}.msg.reply{margin-right:48px}
.who{font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}time{font-weight:400;margin-left:6px}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
details.steps{margin:4px 0 8px;border-left:3px solid var(--line);padding-left:10px}
summary{cursor:pointer;color:var(--accent);font-size:13px}
.step{margin:6px 0}.tool{font-size:13px}code,pre{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:var(--code);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
pre.result{background:var(--code);padding:6px 10px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 8px}
pre.error{color:var(--error)}.warn{color:var(--error);font-size:13px;margin:6px 0 0}
.md.rendered{white-space:normal}.md.rendered>:first-child{margin-top:0}.md.rendered>:last-child{margin-bottom:0}
.md.rendered :is(p,ul,ol,pre,table,blockquote){margin:6px 0}.md.rendered :is(h1,h2,h3,h4,h5,h6){font-size:1.05em;margin:12px 0 4px}
.md.rendered pre{background:var(--code);padding:6px 10px;border-radius:6px;overflow-x:auto}.md.rendered pre code{background:none;padding:0;overflow-wrap:normal}
.md.rendered table{border-collapse:collapse;display:block;overflow-x:auto}.md.rendered :is(th,td){border:1px solid var(--line);padding:3px 8px}
.md.rendered blockquote{border-left:3px solid var(--line);padding-left:10px;color:var(--muted)}.md.rendered a{color:var(--accent)}
@media (max-width:600px){.msg.user{margin-left:16px}.msg.reply{margin-right:0}}
`

/** The page up to the first session: style, title and a contents list of the sorted logs. */
export function htmlHead(sorted: readonly NamedLog[], tzMinutes: number): string {
  const contents = sorted
    .map(log => `<li><a href="#${anchorOf(log)}">${stamp(logStart(log, tzMinutes), tzMinutes) || escapeHtml(log.name)}</a> ${escapeHtml(titleOf(log))}</li>`)
    .join('')
  return [
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>Claude Code chatlog</title><style>${STYLE}</style></head><body><main>`,
    `<h1>Claude Code chatlog</h1><p class="meta">${plural(sorted.length, 'session')}, oldest first. Each reply's steps are folded: click to open.</p>`,
    `<nav><ol>${contents}</ol></nav>\n`,
  ].join('')
}

/** Pinned builds on cdnjs, checked by hash; offline, the page keeps the plain text. */
const MARKDOWN_LIBS = [
  ['https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.12/marked.min.js', 'sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+'],
  ['https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.6/purify.min.js', 'sha384-JEyTNhjM6R1ElGoJns4U2Ln4ofPcqzSsynQkmEc/KGy6336qAZl70tDLufbkla+3'],
] as const

/**
 * Renders each `.md` block's text as Markdown. Raw HTML in the text stays literal
 * text, and DOMPurify cleans what marked makes (links included) before it lands.
 */
const RENDER_MARKDOWN = `(() => {
  if (!window.marked || !window.DOMPurify) return
  const escapes = ${JSON.stringify(ESCAPES)}
  const literal = ({ text }) => text.replace(/[&<>"']/g, c => escapes[c])
  marked.use({ gfm: true, breaks: true, renderer: { html: literal } })
  for (const el of document.querySelectorAll('.md')) {
    try {
      el.innerHTML = DOMPurify.sanitize(marked.parse(el.textContent))
      el.classList.add('rendered')
    } catch { /* this block keeps its plain text */ }
  }
})()`

export const HTML_TAIL = [
  '</main>',
  ...MARKDOWN_LIBS.map(([src, hash]) => `<script src="${src}" integrity="${hash}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`),
  `<script>${RENDER_MARKDOWN}</script>`,
  '</body></html>\n',
].join('\n')

export function toHtml(logs: readonly NamedLog[], tzMinutes: number): string {
  const sorted = sortLogs(logs, tzMinutes)
  return htmlHead(sorted, tzMinutes) + sorted.map(log => sessionHtml(log, tzMinutes)).join('') + HTML_TAIL
}
