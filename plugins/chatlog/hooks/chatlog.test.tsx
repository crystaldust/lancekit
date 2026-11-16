import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { eventsFromRow, summarizeToolInput } from './events'
import { redactText } from './redact'
import { localTime, parseOffset, toMarkdown, toText } from './render'
import { BACKFILL_NOTE, historyFromTranscript } from './transcript'

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
  const failed = eventsFromRow(
    { door: 'command', message: { content: '<local-command-stderr>Error: no such plugin</local-command-stderr>' } },
    TS,
  )
  expect(failed).toEqual([{ kind: 'result', ts: TS, id: 'command', isError: true, preview: ['Error: no such plugin'], totalLines: 1 }])
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

/**
 * A disk in memory under the hooks the plugin's `$.fs` and `$.process.run` calls reach.
 * `cwd` is the session's working directory (the project root stays `/work/demo`);
 * `touched` collects every path written, as the plugin spelled it; `reads` every
 * line range a transcript read asked for. `stdoutLimit` truncates a read's output
 * the way `$.process.run` does past 4 MiB; `failMoves` fails moving a log.
 */
function fakeDisk(
  on: On,
  { cwd = '/work/demo', touched = [] as string[], stdoutLimit = Infinity, reads = [] as string[], failMoves = false } = {},
): Map<string, string> {
  const files = new Map<string, string>()
  const key = (path: string) => (path.includes('.claude/') ? path.slice(path.indexOf('.claude/')) : path.replace(/^\/+/, ''))
  on('fs.exists', (_, e) => ({
    value: [...files.keys()].some(file => file === key(e.path) || file.startsWith(`${key(e.path)}/`)),
  }))
  on('fs.write', (_, e) => {
    touched.push(e.path)
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({ value: files.get(key(e.path)) ?? '' }))
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(file => file.startsWith(`${key(e.path ?? '')}/`))
      .map(file => ({
        name: file.split('/').pop() ?? file,
        kind: 'file' as const,
        size: files.get(file)?.length ?? 0,
        mtimeMs: 1,
        isLink: false,
      })),
  }))
  on('process.run', (_, e) => {
    const done = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'date') return { value: { ...done, stdout: '+0800\n' } }
    if (e.argv[0] === '/bin/sh' && String(e.argv[2]).startsWith('for f in')) {
      const found = [...files.keys()].find(file => /^\.claude\/projects\/[^/]+\//.test(file) && file.endsWith(`/${e.argv[4]}.jsonl`))
      return { value: { ...done, stdout: found === undefined ? '' : `/home/me/${found}` } }
    }
    if (e.argv[0] === '/bin/sh' && String(e.argv[2]).startsWith('for ext')) {
      if (failMoves) return { value: { ...done, exitCode: 1, stdout: '', stderr: 'mv failed' } }
      for (const ext of ['jsonl', 'md', 'txt']) {
        const from = key(`${e.argv[4]}.${ext}`)
        const text = files.get(from)
        if (text === undefined) continue
        files.set(key(`${e.argv[5]}.${ext}`), text)
        files.delete(from)
      }
      return { value: { ...done, stdout: '' } }
    }
    if (e.argv[0] === 'sed') {
      reads.push(String(e.argv[2]))
      const [from = 1, to = 1] = String(e.argv[2]).split(';')[0]!.replace(/p$/, '').split(',').map(Number)
      const text = files.get(key(String(e.argv[3])))
      if (text === undefined) return { value: { ...done, exitCode: 2, stdout: '', stderr: 'No such file' } }
      const lines = text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined).slice(from - 1, to)
      const stdout = lines.map(line => `${line}\n`).join('')
      return { value: { ...done, stdout: stdout.slice(0, stdoutLimit), isStdoutTruncated: stdout.length > stdoutLimit } }
    }
    if (e.argv[0] === 'rm') {
      for (const path of e.argv.slice(2)) files.delete(key(String(path)))
      return { value: { ...done, stdout: '' } }
    }
    touched.push(String(e.argv[4]))
    const path = key(String(e.argv[4]))
    files.set(path, (files.get(path) ?? '') + (e.init?.stdin ?? ''))
    return { value: { ...done, stdout: '' } }
  })
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: '/work/demo' }))
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

/** Rows as Claude Code's transcript stores them, one JSON object per line. */
const transcriptOf = (rows: object[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const T0 = '2026-11-14T03:16:53.000Z'
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString()
const OLD_SESSION = [
  { type: 'permission-mode', permissionMode: 'default' },
  { type: 'user', uuid: 'r1', timestamp: at(0), cwd: '/work/demo', origin: { kind: 'human' }, message: { role: 'user', content: 'parse the pdf' } },
  { type: 'user', uuid: 'r2', timestamp: at(0), cwd: '/work/demo', isMeta: true, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
  { type: 'assistant', uuid: 'r3', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } },
  { type: 'assistant', uuid: 'r4', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pip install pypdf' } }] } },
  { type: 'user', uuid: 'r5', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'r6', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Done: **3 pages**' }] } },
  { type: 'assistant', uuid: 'r6', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Done: **3 pages**' }] } },
  { type: 'system', subtype: 'turn_duration', uuid: 'r7', timestamp: at(3), durationMs: 180000 },
  { type: 'user', uuid: 'r8', timestamp: at(4), message: { role: 'user', content: '<bash-input>ls</bash-input>' } },
  { type: 'user', uuid: 'r9', timestamp: at(4), message: { role: 'user', content: '<bash-stdout>a.pdf</bash-stdout><bash-stderr></bash-stderr>' } },
  { type: 'user', uuid: 'r10', timestamp: at(5), origin: { kind: 'task-notification' }, message: { role: 'user', content: 'task done' } },
  { type: 'user', uuid: 'r11', timestamp: at(6), origin: { kind: 'human' }, message: { role: 'user', content: 'how?' } },
  { type: 'user', uuid: 'r12', timestamp: at(7), interruptedMessageId: 'm', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  { type: 'user', uuid: 'r13', timestamp: at(8), message: { role: 'user', content: '<command-name>/exit</command-name>\n<command-args></command-args>' } },
  { type: 'user', uuid: 'r14', timestamp: at(8), message: { role: 'user', content: '<local-command-stdout>See ya!</local-command-stdout>' } },
  { type: 'user', uuid: 'r15', timestamp: at(60), cwd: '/work/demo', origin: { kind: 'human' }, message: { role: 'user', content: 'back again' } },
  { type: 'user', uuid: 'r16', timestamp: at(3000), origin: { kind: 'human' }, message: { role: 'user', content: 'after the cutoff' } },
]

test('reads a session back out of the Claude Code transcript', () => {
  const lines = transcriptOf(OLD_SESSION).trim().split('\n').concat('not json')
  const history = historyFromTranscript(lines, 'c73fece9-1d91', at(2000))
  expect(history?.startedAt).toBe(T0)
  expect(history?.cwd).toBe('/work/demo')
  expect(history?.events.map(event => (event.kind === 'user' ? `user:${event.text}` : event.kind))).toEqual([
    'session',
    'note',
    'user:parse the pdf',
    'tool',
    'result',
    'assistant',
    'turn',
    'user:! ls',
    'result',
    'user:how?',
    'turn',
    'user:/exit',
    'result',
    'end',
    'session',
    'user:back again',
  ])
  expect(history?.events[1]).toEqual({ kind: 'note', ts: T0, text: BACKFILL_NOTE })
  expect(history?.events[10]).toEqual({ kind: 'turn', ts: at(7), reason: 'aborted', durationMs: 0 })
  expect(history?.events[14]).toEqual({ kind: 'session', ts: at(60), action: 'resume', sessionId: 'c73fece9-1d91', cwd: '/work/demo' })
  expect(historyFromTranscript(lines, 'c73fece9-1d91', T0)).toBeNull()
})

test('a session begun before the chatlog gets its earlier conversation, under its real start', async ($, on) => {
  const files = fakeDisk(on)
  files.set('.claude/projects/-work-demo/abcdef1234567890.jsonl', transcriptOf(OLD_SESSION.slice(0, -1)))
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({
    source: 'resume',
    session_id: 'abcdef1234567890',
    transcript_path: '/elsewhere/.claude/projects/-work-demo/abcdef1234567890.jsonl',
  })

  const names = [...files.keys()].filter(file => file.startsWith('.claude/chatlog/2'))
  expect(names.sort()).toEqual([
    '.claude/chatlog/2026-11-14_111653_abcdef12.jsonl',
    '.claude/chatlog/2026-11-14_111653_abcdef12.md',
    '.claude/chatlog/2026-11-14_111653_abcdef12.txt',
  ])
  const events = logOf(files, 'jsonl').trim().split('\n').map(line => JSON.parse(line))
  expect(events[0]).toMatchObject({ kind: 'session', action: 'start', ts: T0 })
  expect(events.at(-1)).toMatchObject({ kind: 'session', action: 'resume' })
  expect(events.some(event => event.text === 'parse the pdf')).toBe(true)
  expect(logOf(files, 'md')).toContain('Created: 2026-11-14 11:16:53 +08:00')
  expect(logOf(files, 'txt')).toContain('> parse the pdf')
})

test('a log that began mid-session is rebuilt with what came before it, and renamed', async ($, on) => {
  const files = fakeDisk(on)
  const liveTs = at(2000)
  files.set(
    '.claude/chatlog/2026-11-16_101658_abcdef12.jsonl',
    [
      { v: 1, kind: 'session', ts: liveTs, action: 'start', sessionId: 'abcdef1234567890', cwd: '/work/demo' },
      { v: 1, kind: 'user', ts: liveTs, text: 'logged live' },
    ].map(e => JSON.stringify(e)).join('\n') + '\n',
  )
  files.set('.claude/chatlog/2026-11-16_101658_abcdef12.md', 'old md')
  files.set('.claude/projects/-work-demo/abcdef1234567890.jsonl', transcriptOf(OLD_SESSION))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.append', (_, e, next) => next(e))
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

  await $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'new prompt' }] },
  })

  expect(files.has('.claude/chatlog/2026-11-16_101658_abcdef12.jsonl')).toBe(false)
  expect(files.has('.claude/chatlog/2026-11-16_101658_abcdef12.md')).toBe(false)
  const texts = logOf(files, 'jsonl').trim().split('\n').map(line => JSON.parse(line)).map(event => event.text ?? event.kind)
  expect(texts.indexOf('parse the pdf')).toBeLessThan(texts.indexOf('logged live'))
  expect(texts).not.toContain('after the cutoff')
  expect(texts.at(-1)).toBe('new prompt')
  expect(logOf(files, 'md')).toContain('logged live')
  const actions = logOf(files, 'jsonl').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.kind === 'session').map(e => e.action)
  expect(actions).toEqual(['start', 'resume', 'resume', 'resume'])
  expect([...files.keys()].some(file => file.includes('.rebuild_'))).toBe(false)
})

test('a rebuild that fails part way leaves the old log as it was', async ($, on) => {
  const files = fakeDisk(on, { failMoves: true })
  const old = `${JSON.stringify({ v: 1, kind: 'session', ts: at(2000), action: 'start', sessionId: 'abcdef1234567890', cwd: '/w' })}\n`
  files.set('.claude/chatlog/2026-11-16_101658_abcdef12.jsonl', old)
  files.set('t.jsonl', transcriptOf(OLD_SESSION))
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'resume', session_id: 'abcdef1234567890', transcript_path: '/t.jsonl' })

  expect(files.get('.claude/chatlog/2026-11-16_101658_abcdef12.jsonl')).toBe(old)
  expect([...files.keys()].some(file => file.startsWith('.claude/chatlog/2026-11-14'))).toBe(false)
})

test('a fork leaves its parent\'s conversation to the parent\'s log', async ($, on) => {
  const files = fakeDisk(on)
  files.set('t.jsonl', transcriptOf(OLD_SESSION))
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'fork', session_id: 'abcdef1234567890', transcript_path: '/t.jsonl' })

  const kinds = logOf(files, 'jsonl').trim().split('\n').map(line => JSON.parse(line).kind)
  expect(kinds).toEqual(['session'])
})

test('a log that already holds the whole session is only appended to, its transcript barely read', async ($, on) => {
  const reads: string[] = []
  const files = fakeDisk(on, { reads })
  const first = JSON.stringify({ v: 1, kind: 'session', ts: T0, action: 'start', sessionId: 'abcdef1234567890', cwd: '/w' })
  files.set('.claude/chatlog/2026-11-14_111653_abcdef12.jsonl', `${first}\n`)
  const later = Array.from({ length: 5000 }, (_, i) => ({
    type: 'user', uuid: `later${i}`, timestamp: at(10 + i), origin: { kind: 'human' }, message: { role: 'user', content: `later ${i}` },
  }))
  files.set('t.jsonl', transcriptOf([...OLD_SESSION, ...later]))
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'resume', session_id: 'abcdef1234567890', transcript_path: '/t.jsonl' })

  const lines = files.get('.claude/chatlog/2026-11-14_111653_abcdef12.jsonl')?.trim().split('\n') ?? []
  expect(lines.length).toBe(2)
  expect(lines[0]).toBe(first)
  expect(reads).toEqual(['1,2000p;2000q'])
})

test('reads a transcript too large for one read, skipping a line no read can hold', async ($, on) => {
  const files = fakeDisk(on, { stdoutLimit: 2000 })
  const huge = { type: 'user', uuid: 'big', timestamp: at(1), message: { role: 'user', content: 'x'.repeat(5000) } }
  const rows = [...OLD_SESSION.slice(1, 2), huge, ...Array.from({ length: 40 }, (_, i) => ({
    type: 'user', uuid: `p${i}`, timestamp: at(2 + i), origin: { kind: 'human' }, message: { role: 'user', content: `prompt ${i}` },
  }))]
  files.set('t.jsonl', transcriptOf(rows))
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'resume', session_id: 'abcdef1234567890', transcript_path: '/t.jsonl' })

  const texts = logOf(files, 'jsonl').trim().split('\n').map(line => JSON.parse(line).text)
  expect(texts).toContain('parse the pdf')
  expect(texts).toContain('prompt 39')
  expect(texts.some(text => typeof text === 'string' && text.startsWith('xxx'))).toBe(false)
})

test('keeps writing under the project root after a shell cd', async ($, on) => {
  const touched: string[] = []
  fakeDisk(on, { cwd: '/work/demo/packages/app', touched })
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'startup', session_id: 'abcdef1234567890' })
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hello' }] },
  })

  expect(touched.length).toBeGreaterThan(0)
  expect(touched.filter(path => !path.startsWith('/work/demo/.claude/chatlog/'))).toEqual([])
})

test('/chatlog gen_html writes every log into one page, oldest session first', async ($, on) => {
  const files = fakeDisk(on)
  const logLines = (ts: string, text: string) =>
    [
      { v: 1, kind: 'session', ts, action: 'start', sessionId: 'abcdef1234567890', cwd: '/work/demo' },
      { v: 1, kind: 'user', ts, text },
    ].map(e => JSON.stringify(e)).join('\n')
  files.set('.claude/chatlog/2026-10-01_090000_bbbbbbbb.jsonl', logLines('2026-10-25T01:00:00.000Z', 'second prompt'))
  files.set('.claude/chatlog/2026-10-30_090000_aaaaaaaa.jsonl', logLines('2026-10-24T01:00:00.000Z', 'first prompt'))
  files.set('.claude/chatlog/2026-10-26_090000_cccccccc.jsonl', 'x'.repeat(4 * 1024 * 1024 + 1))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({
    command: 'chatlog',
    args: 'gen_html',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const html = files.get('.claude/chatlog/chatlog.html') ?? ''
  expect(ran.text).toContain('/work/demo/.claude/chatlog/chatlog.html')
  expect(ran.text).toContain('2 sessions')
  expect(ran.text).toContain('2026-10-26_090000_cccccccc')
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html.trimEnd().endsWith('</html>')).toBe(true)
  expect(html.indexOf('first prompt')).toBeGreaterThan(-1)
  expect(html.indexOf('first prompt')).toBeLessThan(html.indexOf('second prompt'))
})

test('/chatlog gen_html skips a log it cannot render and still finishes the page', async ($, on) => {
  const files = fakeDisk(on)
  const good = { v: 1, kind: 'user', ts: '2026-10-24T01:00:00.000Z', text: 'good prompt' }
  const bad = { v: 1, kind: 'user', ts: '2026-10-25T01:00:00.000Z', text: 123 }
  files.set('.claude/chatlog/2026-10-24_090000_aaaaaaaa.jsonl', JSON.stringify(good))
  files.set('.claude/chatlog/2026-10-25_090000_dddddddd.jsonl', JSON.stringify(bad))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({
    command: 'chatlog',
    args: 'gen_html',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const html = files.get('.claude/chatlog/chatlog.html') ?? ''
  expect(ran.text).toContain('1 session')
  expect(ran.text).toContain('2026-10-25_090000_dddddddd')
  expect(html).toContain('good prompt')
  expect(html.trimEnd().endsWith('</html>')).toBe(true)
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
