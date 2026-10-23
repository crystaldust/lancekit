import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { eventsFromRow, summarizeToolInput } from './events'
import { redactText } from './redact'
import { localTime, parseOffset, toMarkdown, toText } from './render'

const TS = '2026-10-23T07:30:12.000Z'
const CST = 480

test('reads the person, the model and tools out of stored rows', () => {
  expect(eventsFromRow({ door: 'prompt', message: { content: 'hello' } }, TS)).toEqual([
    { kind: 'user', ts: TS, text: 'hello' },
  ])
  expect(eventsFromRow({ door: 'prompt', message: { isMeta: true, content: 'reminder' } }, TS)).toEqual([])
  const response = eventsFromRow(
    {
      door: 'response',
      message: {
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status\necho more' } },
        ],
      },
    },
    TS,
  )
  expect(response).toEqual([
    { kind: 'assistant', ts: TS, text: 'Checking.' },
    { kind: 'tool', ts: TS, id: 't1', name: 'Bash', summary: 'git status' },
  ])
  const results = eventsFromRow(
    {
      door: 'tool-result',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'a\nb\nc\nd\ne' }] },
    },
    TS,
  )
  expect(results).toEqual([
    { kind: 'result', ts: TS, id: 't1', isError: true, preview: ['a', 'b', 'c'], totalLines: 5 },
  ])
})

test('reads slash commands and their output', () => {
  const ran = eventsFromRow(
    { door: 'command', message: { content: '<command-name>/plugin</command-name>\n<command-args>list</command-args>' } },
    TS,
  )
  expect(ran).toEqual([{ kind: 'user', ts: TS, text: '/plugin list', via: 'command' }])
  const output = eventsFromRow(
    { door: 'command', message: { content: '<local-command-stdout>done</local-command-stdout>' } },
    TS,
  )
  expect(output).toEqual([{ kind: 'result', ts: TS, id: 'command', isError: false, preview: ['done'], totalLines: 1 }])
})

test('keeps only typed prompts that arrive mid-turn', () => {
  const typed = { door: 'delivery', message: { content: 'also this' }, origin: { kind: 'composer' } }
  const notice = { door: 'delivery', message: { content: 'task done' }, origin: { kind: 'task-notification' } }
  expect(eventsFromRow(typed, TS)).toEqual([{ kind: 'user', ts: TS, text: 'also this', via: 'queued' }])
  expect(eventsFromRow(notice, TS)).toEqual([])
})

test('names a tool call by its main argument', () => {
  expect(summarizeToolInput('Read', { file_path: '/a/b.ts', limit: 5 })).toBe('/a/b.ts')
  expect(summarizeToolInput('mcp__x__y', { query: 'q' })).toBe('q')
})

test('masks secrets', () => {
  expect(redactText('key sk-ant-abcdefghijklmnopqrstuvwxyz0123')).toBe('key [REDACTED]')
  expect(redactText('password=hunter2hunter2')).toBe('password=[REDACTED]')
  expect(redactText('nothing secret here')).toBe('nothing secret here')
})

test('stamps local time from the UTC offset', () => {
  expect(parseOffset('+0800\n')).toBe(480)
  expect(parseOffset('-0530')).toBe(-330)
  expect(localTime(TS, CST)).toEqual({ date: '2026-10-23', time: '15:30:12', offset: '+08:00' })
})

test('writes terminal-style text and Markdown', () => {
  expect(toText({ kind: 'user', ts: TS, text: 'hi\nthere' }, CST)).toBe('\n[15:30:12] > hi\n           there\n\n')
  expect(toText({ kind: 'tool', ts: TS, id: 't', name: 'Bash', summary: 'ls' }, CST)).toBe('[15:30:12] ⏺ Bash(ls)\n')
  expect(toText({ kind: 'turn', ts: TS, reason: 'aborted', durationMs: 5 }, CST)).toContain('⎿  Interrupted by user')
  expect(toText({ kind: 'turn', ts: TS, reason: 'answer', durationMs: 5 }, CST)).toBe('')
  expect(toMarkdown({ kind: 'user', ts: TS, text: 'hi' }, CST)).toBe('### › 15:30:12\n\n> hi\n\n')
  expect(toMarkdown({ kind: 'end', ts: TS, reason: 'prompt_input_exit' }, CST)).toContain('Session ended')
})

/** A disk in memory under the hooks the plugin's `$.fs` and `$.process.run` calls reach. */
function fakeDisk(on: On): Map<string, string> {
  const files = new Map<string, string>()
  const key = (path: string) => (path.includes('.claude/') ? path.slice(path.indexOf('.claude/')) : path.replace(/^\/+/, ''))
  on('fs.exists', (_, e) => ({
    value: [...files.keys()].some(file => file === key(e.path) || file.startsWith(`${key(e.path)}/`)),
  }))
  on('fs.write', (_, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({ value: files.get(key(e.path)) ?? '' }))
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(file => file.startsWith(`${key(e.path ?? '')}/`))
      .map(file => ({ name: file.split('/').pop() ?? file, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', (_, e) => {
    const done = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'date') return { value: { ...done, stdout: '+0800\n' } }
    const path = key(String(e.argv[4]))
    files.set(path, (files.get(path) ?? '') + (e.init?.stdin ?? ''))
    return { value: { ...done, stdout: '' } }
  })
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('command.register', () => ({ value: { command: 'chatlog' } }))
  on('ui.toast', () => ({ value: undefined }))
  return files
}

const logOf = (files: Map<string, string>, ext: string): string => {
  const name = [...files.keys()].find(file => file.endsWith(`_abcdef12.${ext}`))
  return name === undefined ? '' : files.get(name) ?? ''
}

test('records a session from start to interrupt to exit, prompt first', async ($, on) => {
  const files = fakeDisk(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  let loggedBeforeStored = false
  on('session.append', (_, e, next) => {
    if (e.door === 'prompt') loggedBeforeStored = logOf(files, 'jsonl').includes('"text":"fix the bug"')
    return next(e)
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', session_id: 'abcdef1234567890' })
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
  })
  await $.turn.complete({ answer: '', durationMs: 900, isAborted: true, turnId: 't1', reason: 'aborted' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'abcdef1234567890', resume: { id: '' } })

  expect(loggedBeforeStored).toBe(true)
  const kinds = logOf(files, 'jsonl').trim().split('\n').map(line => JSON.parse(line).kind)
  expect(kinds).toEqual(['session', 'user', 'turn', 'end'])
  expect(files.get('.claude/chatlog/.gitignore')).toBe('*\n')
  const text = logOf(files, 'txt')
  expect(text).toContain('session started')
  expect(text).toContain('> fix the bug')
  expect(text).toContain('Interrupted by user')
  expect(text).toContain('session ended (prompt_input_exit)')
  expect(logOf(files, 'md')).toContain('# Claude Code chatlog')
})

test('a resumed session continues its own log', async ($, on) => {
  const files = fakeDisk(on)
  files.set('.claude/chatlog/2026-10-22_090000_abcdef12.jsonl', '{"v":1,"kind":"session"}\n')
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'resume', session_id: 'abcdef1234567890' })

  const lines = files.get('.claude/chatlog/2026-10-22_090000_abcdef12.jsonl')?.trim().split('\n') ?? []
  expect(lines.length).toBe(2)
  expect(JSON.parse(lines[1] ?? '{}').action).toBe('resume')
})

test('/chatlog replay draws a log in terminal style, on every surface', async ($, on) => {
  const files = fakeDisk(on)
  const events = [
    { v: 1, kind: 'session', ts: TS, action: 'start', sessionId: 'abcdef1234567890', cwd: '/w' },
    { v: 1, kind: 'user', ts: TS, text: 'list files' },
    { v: 1, kind: 'tool', ts: TS, id: 't1', name: 'Bash', summary: 'ls' },
    { v: 1, kind: 'result', ts: TS, id: 't1', isError: false, preview: ['a.txt'], totalLines: 1 },
    { v: 1, kind: 'assistant', ts: TS, text: 'One file: **a.txt**' },
    { v: 1, kind: 'turn', ts: TS, reason: 'aborted', durationMs: 1 },
  ]
  files.set('.claude/chatlog/2026-10-23_153012_abcdef12.jsonl', events.map(e => JSON.stringify(e)).join('\n'))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({
    command: 'chatlog',
    args: 'replay 1',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toContain('6 events')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'chatlog',
      surface,
      component: 'Pane',
      requestId: 'chatlog-replay',
      props: {
        title: 'Replay',
        isFocused: true,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: /list files/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Bash$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Interrupted by user/ })).toBeDefined()
    await ui.unmount()
  }
})
