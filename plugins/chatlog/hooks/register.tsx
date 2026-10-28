import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChatEvent, LogState, SessionAction } from '../types'
import { eventsFromRow } from './events'
import { HTML_TAIL, htmlHead, plural, sessionHtml, sortLogs } from './html'
import type { NamedLog } from './html'
import { redactEvent } from './redact'
import {
  fileStamp,
  localTime,
  markdownHeader,
  parseOffset,
  resultLines,
  textHeader,
  toMarkdown,
  toText,
  turnNote,
} from './render'

const LOG_SUBDIR = '.claude/chatlog'
const PANE = 'chatlog-replay'
const RECENT = 15
const HTML_FILE = 'chatlog.html'
/** `$.fs.read` rejects anything larger. */
const MAX_READ_BYTES = 4 * 1024 * 1024
const SOURCE_ACTION: Record<string, SessionAction> = {
  startup: 'start',
  resume: 'resume',
  clear: 'clear',
  compact: 'compact',
  fork: 'fork',
}

type $ = EngineInterface
type Settings = { md: boolean; txt: boolean; gitignore: boolean; redact: boolean }
type LogFile = { name: string; mtimeMs: number; size: number }

const EMPTY_LOG: LogState = { base: null, sessionId: null, tzMinutes: null }
const logAtom = atom({ plugin: 'chatlog', key: 'log' } as const, EMPTY_LOG)
const replayAtom = atom({ plugin: 'chatlog', key: 'replay' } as const, null)

function settingsOf(options: Record<string, unknown>): Settings {
  const formats = typeof options.formats === 'string' ? options.formats : 'md+txt'
  return {
    md: formats.includes('md'),
    txt: formats.includes('txt'),
    gitignore: options.gitignore !== false,
    redact: options.redact !== false,
  }
}

const nowIso = (): string => new Date().toISOString()
const shortId = (id: string): string => id.slice(0, 8)

/** Log writes run one after another so lines land in the order the events happened. */
let queue: Promise<void> = Promise.resolve()
function serially(work: () => Promise<void>): Promise<void> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

async function appendFile($: $, path: string, text: string): Promise<void> {
  if (text === '') return
  const ran = await $.process.run(['/bin/sh', '-c', 'cat >> "$1"', 'chatlog', path], { stdin: text })
  if (ran.exitCode !== 0) throw new Error(`could not append to ${path}: ${ran.stderr.trim()}`)
}

async function tzMinutes($: $): Promise<number> {
  const known = (await read($, logAtom)).tzMinutes
  if (known !== null) return known
  const minutes = parseOffset((await $.process.run(['date', '+%z'])).stdout)
  await update($, logAtom, log => ({ ...log, tzMinutes: minutes }))
  return minutes
}

/**
 * The log folder, absolute under the project root: a relative path would follow
 * the session's working directory, which a shell `cd` moves.
 */
async function logDir($: $): Promise<string> {
  return `${await $.session.root()}/${LOG_SUBDIR}`
}

/** Logs in the folder, most recently written first. */
async function listLogs($: $, dir: string): Promise<LogFile[]> {
  if (!(await $.fs.exists(dir))) return []
  return (await $.fs.list(dir))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
    .map(entry => ({ name: entry.name.slice(0, -'.jsonl'.length), mtimeMs: entry.mtimeMs, size: entry.size }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

async function writeEvent($: $, settings: Settings, base: string, event: ChatEvent): Promise<void> {
  const tz = await tzMinutes($)
  const clean = settings.redact ? redactEvent(event) : event
  await Promise.all([
    appendFile($, `${base}.jsonl`, `${JSON.stringify({ v: 1, ...clean })}\n`),
    settings.md ? appendFile($, `${base}.md`, toMarkdown(clean, tz)) : undefined,
    settings.txt ? appendFile($, `${base}.txt`, toText(clean, tz)) : undefined,
  ])
}

/** Opens this session's log (continuing its file when one exists) and records how it began. */
async function openLog($: $, settings: Settings, action: SessionAction, sessionId: string): Promise<string> {
  const tz = await tzMinutes($)
  const cwd = await $.session.cwd()
  const ts = nowIso()
  const dir = await logDir($)
  const existing = (await listLogs($, dir)).find(log => log.name.endsWith(`_${shortId(sessionId)}`))
  const base = `${dir}/${existing?.name ?? `${fileStamp(ts, tz)}_${shortId(sessionId)}`}`
  if (!existing) {
    if (settings.gitignore && !(await $.fs.exists(`${dir}/.gitignore`))) {
      await $.fs.write(`${dir}/.gitignore`, '*\n')
    }
    await $.fs.write(`${base}.jsonl`, '')
    if (settings.md) await $.fs.write(`${base}.md`, markdownHeader(sessionId, cwd, ts, tz))
    if (settings.txt) await $.fs.write(`${base}.txt`, textHeader(sessionId, cwd, ts, tz))
  }
  await update($, logAtom, log => ({ ...log, base, sessionId }))
  const begun = existing && action === 'start' ? 'resume' : action
  await writeEvent($, settings, base, { kind: 'session', ts, action: begun, sessionId, cwd })
  return base
}

async function currentBase($: $, settings: Settings): Promise<string> {
  const log = await read($, logAtom)
  const sessionId = await $.session.id()
  if (log.base && log.sessionId === sessionId) return log.base
  return openLog($, settings, 'start', sessionId)
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function reportFailure($: $, error: unknown): void {
  $.ui.toast(`chatlog: ${errorText(error)}`)
}

function record($: $, settings: Settings, events: ChatEvent[]): Promise<void> {
  if (events.length === 0) return Promise.resolve()
  return serially(async () => {
    const base = await currentBase($, settings)
    for (const event of events) await writeEvent($, settings, base, event)
  }).catch(error => reportFailure($, error))
}

function parseLog(text: string): ChatEvent[] {
  return text.split('\n').flatMap(line => {
    if (line.trim() === '') return []
    try {
      const parsed: unknown = JSON.parse(line)
      return typeof parsed === 'object' && parsed !== null && typeof (parsed as { kind?: unknown }).kind === 'string'
        ? [parsed as ChatEvent]
        : []
    } catch {
      return []
    }
  })
}

async function replay($: $, target: string | undefined): Promise<string> {
  const dir = await logDir($)
  const logs = await listLogs($, dir)
  const picked = target === undefined
    ? logs[0]
    : /^\d+$/.test(target)
      ? logs[Number(target) - 1]
      : logs.find(log => log.name.includes(target))
  if (!picked) return `No chatlog matches "${target ?? 'latest'}". Run /chatlog list.`
  const path = `${dir}/${picked.name}.jsonl`
  const events = parseLog(await $.fs.read(path))
  await update($, replayAtom, () => ({ name: picked.name, path, events }))
  await $.ui.open({ id: PANE, title: `Replay · ${picked.name}`, focus: true })
  return [
    `Replaying ${picked.name} (${events.length} events) in the side pane.`,
    `In a plain terminal: python3 ${$.plugin.root}/scripts/chatlog_replay.py ${path}`,
  ].join('\n')
}

type Rendered = { log: NamedLog; html: string }
/** Why a log was left out of the page: its name and the reason. */
type Skip = string

async function readLog($: $, dir: string, file: LogFile): Promise<NamedLog | Skip> {
  if (file.size > MAX_READ_BYTES) return `${file.name} (over 4 MiB)`
  try {
    return { name: file.name, events: parseLog(await $.fs.read(`${dir}/${file.name}.jsonl`)) }
  } catch (error) {
    return `${file.name} (${errorText(error)})`
  }
}

function renderLog(log: NamedLog, tz: number): Rendered | Skip {
  try {
    return { log, html: sessionHtml(log, tz) }
  } catch (error) {
    return `${log.name} (${errorText(error)})`
  }
}

const isSkip = (value: unknown): value is Skip => typeof value === 'string'

/**
 * Writes every log into one HTML page, oldest session first. Every session is
 * rendered before the first write, so a bad log is skipped rather than leaving a
 * half-written page; the page then goes to disk a session at a time, since it may
 * outgrow what one `$.fs.write` takes.
 */
async function genHtml($: $): Promise<string> {
  const dir = await logDir($)
  const files = await listLogs($, dir)
  if (files.length === 0) return `No chatlogs yet under ${dir}.`
  const tz = await tzMinutes($)
  const read = await Promise.all(files.map(file => readLog($, dir, file)))
  const rendered = sortLogs(read.filter((log): log is NamedLog => !isSkip(log)), tz).map(log => renderLog(log, tz))
  const pages = rendered.filter((page): page is Rendered => !isSkip(page))
  const skipped = [...read, ...rendered].filter(isSkip)
  const path = `${dir}/${HTML_FILE}`
  await $.fs.write(path, htmlHead(pages.map(page => page.log), tz))
  for (const page of pages) await appendFile($, path, page.html)
  await appendFile($, path, HTML_TAIL)
  return [
    `Wrote ${path} (${plural(pages.length, 'session')}, oldest first).`,
    ...(skipped.length > 0 ? [`Skipped: ${skipped.join(', ')}`] : []),
    `Open it in a browser: open "${path}"`,
  ].join('\n')
}

async function listText($: $): Promise<string> {
  const dir = await logDir($)
  const logs = await listLogs($, dir)
  if (logs.length === 0) return `No chatlogs yet under ${dir}.`
  const current = (await read($, logAtom)).base
  return logs
    .slice(0, RECENT)
    .map((log, index) => `${index + 1}. ${log.name}${`${dir}/${log.name}` === current ? '  (current)' : ''}`)
    .join('\n')
}

async function statusText($: $, settings: Settings): Promise<string> {
  const base = (await read($, logAtom)).base
  const files = base === null
    ? ['(not opened yet: the first prompt opens it)']
    : [`${base}.jsonl`, ...(settings.md ? [`${base}.md`] : []), ...(settings.txt ? [`${base}.txt`] : [])]
  return [
    'Recording this session to:',
    ...files.map(file => `  ${file}`),
    '',
    '/chatlog list             recent logs',
    '/chatlog replay [n|name]  replay a log in a side pane (default: the most recent)',
    `/chatlog gen_html         write every log into one HTML page (${LOG_SUBDIR}/${HTML_FILE})`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chatlog',
      description: 'Session chatlog: where it is recorded, list logs, replay one in terminal style, export all as HTML',
      argumentHint: '[list | replay [n|name] | gen_html]',
    })
    await tzMinutes($).catch(error => reportFailure($, error))
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const action = SOURCE_ACTION[e.source] ?? 'start'
    await serially(async () => {
      const log = await read($, logAtom)
      if (log.base && log.sessionId === e.session_id) {
        const cwd = await $.session.cwd()
        await writeEvent($, settings, log.base, { kind: 'session', ts: nowIso(), action, sessionId: e.session_id, cwd })
        return
      }
      await openLog($, settings, action, e.session_id)
    }).catch(error => reportFailure($, error))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined) {
      const row = { door: e.door, message: e.message, origin: e.origin as { kind?: string } }
      await record($, settings, eventsFromRow(row, nowIso()))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await record($, settings, [{ kind: 'turn', ts: nowIso(), reason: e.reason, durationMs: e.durationMs }])
    }
    return done
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await serially(async () => {
      const log = await read($, logAtom)
      if (log.base === null) return
      await writeEvent($, settings, log.base, { kind: 'end', ts: nowIso(), reason: e.reason })
      await update($, logAtom, now => ({ ...now, base: null, sessionId: null }))
    }).catch(error => reportFailure($, error))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'chatlog' }, async ($, e) => {
    const [sub = '', target] = e.args.trim().split(/\s+/).filter(Boolean)
    if (sub === 'list') return { text: await listText($) }
    if (sub === 'replay') return { text: await replay($, target) }
    if (sub === 'gen_html') return { text: await genHtml($) }
    return { text: await statusText($, settings) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const loaded = await read($, replayAtom)
    const tz = (await read($, logAtom)).tzMinutes ?? 0
    if (loaded === null) return <Text dimColor>Run /chatlog replay to load a log.</Text>

    const draw = (event: ChatEvent) => {
      const { date, time } = localTime(event.ts, tz)
      switch (event.kind) {
        case 'session':
          return <Box marginTop={1}><Text dimColor>── {date} {time} · session {event.action} ──</Text></Box>
        case 'end':
          return <Box marginTop={1}><Text dimColor>── {time} · session ended ({event.reason}) ──</Text></Box>
        case 'user':
          return (
            <Box marginTop={1} flexDirection="row">
              <Text color="subtle">{'> '}</Text>
              <Box flexDirection="column" flexShrink={1}>
                <Text>{event.text}</Text>
                <Text dimColor>{time}{event.via ? ` · ${event.via}` : ''}</Text>
              </Box>
            </Box>
          )
        case 'assistant':
          return (
            <Box marginTop={1} flexDirection="row">
              <Text>{'⏺ '}</Text>
              <Box flexDirection="column" flexShrink={1}>
                <Markdown text={event.text} />
              </Box>
            </Box>
          )
        case 'tool':
          return (
            <Box marginTop={1} flexDirection="row">
              <Text color="success">{'⏺ '}</Text>
              <Text bold>{event.name}</Text>
              <Text>({event.summary})</Text>
            </Box>
          )
        case 'result':
          return (
            <Box flexDirection="column" paddingLeft={2}>
              {resultLines(event).map(line => (
                <Text color={event.isError ? 'error' : undefined} dimColor={!event.isError}>{line}</Text>
              ))}
            </Box>
          )
        case 'turn': {
          const note = turnNote(event.reason)
          return note ? <Box paddingLeft={2}><Text color="error">⎿  {note}</Text></Box> : null
        }
        case 'note':
          return <Box marginTop={1}><Text dimColor>· {event.text} · {time}</Text></Box>
      }
    }

    return <Box flexDirection="column">{loaded.events.map(draw)}</Box>
  })
}
