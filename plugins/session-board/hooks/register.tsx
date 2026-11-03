import type { EngineInterface, Register } from 'claude-code'

import { buildReport, boardSessionId, eccSummary, parseBoardUrl, sessionUrl } from './report'
import type { Board, EccLive, EccPlan, EccPrd, EccSummary, Where } from './report'
import { clip, enter, initialStatus, questionDetail, toolDetail, withAnswer, withPrompt } from './status'
import type { SessionState, Status } from './status'

type $ = EngineInterface

const HEARTBEAT_MS = 5000
/** How long an exiting session waits for its last report. */
const END_REPORT_MS = 1500
/** A request the board has not answered by then counts as failed; the next heartbeat tries again. */
const REQUEST_TIMEOUT_MS = 4000
const ERROR_CHARS = 160

const STATE_NAMES: Record<SessionState, string> = {
  working: '工作中',
  'needs-approval': '等批准',
  'your-turn': '轮到你',
  ended: '已退出',
}

type Approval = { tool: string | null; agentId: string | undefined }

type Link = { attemptAt: number | null; okAt: number | null; error: string | null }

const clock = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, ERROR_CHARS)

/**
 * What this session has told the board, held for the life of the module (a reload starts it over).
 * The one mutable record of the mod; its fields are replaced, never edited in place.
 */
type Reporter = {
  board: Board | null
  status: Status | null
  where: Where
  sessionId: string | null
  /** What made the current wait: the tool (null for a notification) and the loop it waits in. */
  approval: Approval | null
  link: Link
  inFlight: Promise<void> | null
  isDirty: boolean
}

async function readEcc($: $): Promise<EccSummary | null> {
  try {
    // ecc-progress's own values; undefined where it is not installed.
    const prd = await $.state.get({ plugin: 'ecc-progress', key: 'prd' } as never)
    const plan = await $.state.get({ plugin: 'ecc-progress', key: 'plan' } as never)
    const live = await $.state.get({ plugin: 'ecc-progress', key: 'live' } as never)
    return eccSummary(prd.value as EccPrd | null, plan.value as EccPlan | null, live.value as EccLive | null)
  } catch {
    return null
  }
}

async function postOnce($: $, r: Reporter) {
  const { board, status } = r
  if (board === null || status === null) return
  let now = 0
  try {
    now = await $.clock.now()
    // Read once: a /clear or /resume may replace r.sessionId while this request is out.
    const sessionId = r.sessionId ?? (await $.session.id())
    r.sessionId ??= sessionId
    const body = JSON.stringify(buildReport(status, r.where, await readEcc($), now))
    const request = $.http.fetch(sessionUrl(board, boardSessionId(sessionId)), {
      method: 'POST',
      headers: { Authorization: `Bearer ${board.token}`, 'Content-Type': 'application/json' },
      body,
    })
    const response = await Promise.race([request, $.clock.sleep(REQUEST_TIMEOUT_MS).then(() => null)])
    if (response === null) {
      r.link = { ...r.link, attemptAt: now, error: `${REQUEST_TIMEOUT_MS / 1000} 秒内没有回应` }
      return
    }
    const reason = response.text.trim() ? `HTTP ${response.status}: ${response.text.trim()}` : `HTTP ${response.status}`
    r.link = { attemptAt: now, okAt: response.ok ? now : r.link.okAt, error: response.ok ? null : clip(reason, ERROR_CHARS) }
  } catch (error) {
    r.link = { ...r.link, attemptAt: now, error: errorText(error) }
  }
}

/** One request at a time; a change made while one is out is sent right after it. */
function send($: $, r: Reporter): Promise<void> {
  if (r.inFlight !== null) {
    r.isDirty = true
    return r.inFlight
  }
  r.inFlight = (async () => {
    do {
      r.isDirty = false
      await postOnce($, r)
    } while (r.isDirty)
  })().finally(() => {
    r.inFlight = null
  })
  return r.inFlight
}

/** Applies `change`; a real change is reported at once, off the event's own dispatch. */
async function apply($: $, r: Reporter, change: (status: Status, now: number) => Status) {
  const now = await $.clock.now()
  const current = r.status ?? initialStatus(now)
  const changed = change(current, now)
  if (changed === r.status) return
  r.status = changed
  if (changed !== current) $.clock.after(0, () => send($, r))
}

export const register: Register = (on, options) => {
  const r: Reporter = {
    board: parseBoardUrl(String(options.boardUrl ?? ''), String(options.token ?? '')),
    status: null,
    where: { host: 'unknown', cwd: '' },
    sessionId: null,
    approval: null,
    link: { attemptAt: null, okAt: null, error: null },
    inFlight: null,
    isDirty: false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'session-board', description: 'Show whether this session reaches the session board, and report now' })
    const host = await $.process.run(['hostname', '-s']).then(r => r.stdout.trim(), () => '')
    r.where = { host: host || 'unknown', cwd: e.cwd }
    r.sessionId = null
    r.status = r.status ?? initialStatus(await $.clock.now())
    $.clock.every(HEARTBEAT_MS, () => (r.status?.state === 'ended' ? undefined : send($, r)))
    $.clock.after(0, () => send($, r))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      r.approval = null
      await apply($, r, (s, now) => withPrompt(enter(s, 'working', now), e.text, now))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    r.approval = { tool: e.tool_name, agentId: e.agent_id }
    await apply($, r, (s, now) => enter(s, 'needs-approval', now, toolDetail(e.tool_name, e.tool_input)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' && r.status?.state !== 'needs-approval') {
      r.approval = { tool: null, agentId: e.agent_id }
      await apply($, r, (s, now) => enter(s, 'needs-approval', now, clip(e.message, 200) || null))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const detail = e.tool === 'AskUserQuestion' ? questionDetail(e) : toolDetail(e.tool, e)
    if (e.agentId === undefined && e.tool === 'AskUserQuestion') {
      r.approval = { tool: e.tool, agentId: undefined }
      await apply($, r, (s, now) => enter(s, 'needs-approval', now, detail))
    }
    const result = await next(e)
    const { approval } = r
    const waitedOnThis =
      r.status?.state === 'needs-approval' &&
      approval !== null &&
      approval.agentId === e.agentId &&
      (approval.tool === null || r.status.detail === detail)
    if (waitedOnThis) {
      r.approval = null
      await apply($, r, (s, now) => enter(s, 'working', now))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      r.approval = null
      await apply($, r, (s, now) => withAnswer(enter(s, 'your-turn', now), e.answer, now))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    await apply($, r, (s, now) => (s.state === 'working' ? enter(s, 'your-turn', now) : s))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    r.sessionId = e.sessionId
    const now = await $.clock.now()
    r.status = enter(r.status ?? initialStatus(now), 'ended', now)
    await Promise.race([send($, r), $.clock.sleep(END_REPORT_MS)])
    if (e.reason === 'clear' || e.reason === 'resume') {
      // The process goes on under another id, and no session.start follows.
      r.sessionId = null
      r.status = initialStatus(await $.clock.now())
      $.clock.after(0, () => send($, r))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'session-board' }, async $ => {
    const { board } = r
    if (board === null) {
      return {
        text: [
          'session-board 还没配置看板地址。',
          '在 /config 里找到 session-board，把 board.py 启动时打印的地址（可以带 ?token=）填进 Board URL。',
        ].join('\n'),
      }
    }
    // Bounded: a change queued behind a hung request must not hold the command too.
    await Promise.race([send($, r), $.clock.sleep(REQUEST_TIMEOUT_MS)])
    const now = await $.clock.now()
    const lines = [
      `看板  ${board.base}${board.token ? '' : '（没有令牌，看板会拒绝）'}`,
      `状态  ${r.status ? `${STATE_NAMES[r.status.state]}（自 ${clock(r.status.since)}）` : '未知'}`,
      r.link.error === null && r.link.okAt !== null
        ? `上报  成功，${Math.round((now - r.link.okAt) / 1000)} 秒前`
        : `上报  失败：${r.link.error ?? '还没有发出'}${r.link.okAt !== null ? `；上次成功在 ${clock(r.link.okAt)}` : ''}`,
    ]
    return { text: lines.join('\n') }
  })
}
