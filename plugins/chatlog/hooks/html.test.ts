import { expect, test } from 'claude-code/testing'

import type { ChatEvent } from '../types'
import { escapeHtml, logStart, sortLogs, toHtml } from './html'

const CST = 480
const SESSION = 'abcdef1234567890'

const at = (minute: number): string => `2026-10-23T07:${String(minute).padStart(2, '0')}:00.000Z`

const turnEvents: ChatEvent[] = [
  { kind: 'session', ts: at(0), action: 'start', sessionId: SESSION, cwd: '/work/demo' },
  { kind: 'user', ts: at(1), text: 'list files' },
  { kind: 'assistant', ts: at(2), text: 'Checking the folder.' },
  { kind: 'tool', ts: at(2), id: 't1', name: 'Bash', summary: 'ls' },
  { kind: 'result', ts: at(3), id: 't1', isError: false, preview: ['a.txt', 'b.txt', 'c.txt'], totalLines: 9 },
  { kind: 'tool', ts: at(3), id: 't2', name: 'Read', summary: 'missing.txt' },
  { kind: 'result', ts: at(3), id: 't2', isError: true, preview: ['File does not exist'], totalLines: 1 },
  { kind: 'assistant', ts: at(4), text: 'Three files: a, b and c.' },
  { kind: 'turn', ts: at(4), reason: 'answer', durationMs: 1 },
  { kind: 'end', ts: at(5), reason: 'prompt_input_exit' },
]

const detailsOf = (html: string): string[] => html.match(/<details[\s\S]*?<\/details>/g) ?? []

test('escapes everything a log carries into the page', () => {
  expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;',
  )
  const html = toHtml([{ name: 'log', events: [{ kind: 'user', ts: at(1), text: '<img src=x onerror=alert(1)>' }] }], CST)
  expect(html).not.toContain('<img src=x')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')

  const forged = { kind: 'user', ts: at(1), text: 'x', via: '<script>bad()</script>' } as unknown as ChatEvent
  const page = toHtml([{ name: 'a"b<c', events: [forged] }], CST)
  expect(page).not.toContain('<script>bad')
  expect(page).not.toContain('a"b<c')
})

test('names a log it cannot date, and labels a lone command output', () => {
  const events: ChatEvent[] = [
    { kind: 'user', ts: 'not a time', text: '/status', via: 'command' },
    { kind: 'result', ts: 'not a time', id: 'command', isError: false, preview: ['ok'], totalLines: 1 },
  ]
  const html = toHtml([{ name: 'odd-name', events }], CST)

  expect(html).toContain('<h2>odd-name</h2>')
  expect(html).toContain('<summary>1 result</summary>')
  expect(html).not.toContain('0 steps')
})

test('starts a log at its first event, not at its file name', () => {
  expect(logStart({ name: '2026-10-01_000000_abcdef12', events: turnEvents }, CST)).toBe(at(0))
  expect(logStart({ name: '2026-10-23_153012_abcdef12', events: [] }, CST)).toBe('2026-10-23T07:30:12.000Z')
  expect(logStart({ name: 'odd-name', events: [] }, CST)).toBe('')
})

test('orders logs by when each session began', () => {
  const early = { name: '2026-10-30_090000_late0000', events: [{ ...turnEvents[0], ts: at(10) } as ChatEvent] }
  const late = { name: '2026-10-01_090000_soon0000', events: [{ ...turnEvents[0], ts: at(20) } as ChatEvent] }
  expect(sortLogs([late, early], CST).map(log => log.name)).toEqual([early.name, late.name])
})

test('folds the steps of a reply and keeps its answer in view', () => {
  const html = toHtml([{ name: '2026-10-23_153000_abcdef12', events: turnEvents }], CST)
  const [steps, ...others] = detailsOf(html)

  expect(others).toEqual([])
  expect(steps).toBeDefined()
  expect(steps).not.toMatch(/<details[^>]*\bopen\b/)
  expect(steps).toContain('3 steps · 2 tool calls')
  expect(steps).toContain('Checking the folder.')
  expect(steps).toContain('Bash')
  expect(steps).toContain('a.txt')
  expect(steps).toContain('+6 lines')
  expect(steps).toContain('File does not exist')
  expect(steps).not.toContain('Three files')

  const outside = html.replace(steps ?? '', '')
  expect(outside).toContain('Three files: a, b and c.')
  expect(outside).toContain('list files')
  expect(outside).toContain('/work/demo')
})

test('folds a whole reply that ends on a tool call, and shows the interrupt', () => {
  const events: ChatEvent[] = [
    { kind: 'user', ts: at(1), text: 'run it' },
    { kind: 'assistant', ts: at(2), text: 'Running.' },
    { kind: 'tool', ts: at(2), id: 't1', name: 'Bash', summary: 'make' },
    { kind: 'turn', ts: at(3), reason: 'aborted', durationMs: 1 },
  ]
  const html = toHtml([{ name: 'log', events }], CST)
  const [steps] = detailsOf(html)

  expect(steps).toContain('Running.')
  expect(steps).toContain('2 steps · 1 tool call<')
  expect(html.replace(steps ?? '', '')).toContain('Interrupted by user')
})

test('leaves a reply without steps unfolded', () => {
  const events: ChatEvent[] = [
    { kind: 'user', ts: at(1), text: 'hi' },
    { kind: 'assistant', ts: at(2), text: 'Hello.' },
  ]
  const html = toHtml([{ name: 'log', events }], CST)

  expect(detailsOf(html)).toEqual([])
  expect(html).toContain('Hello.')
})
