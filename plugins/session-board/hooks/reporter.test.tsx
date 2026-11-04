import { expect, mock, test } from 'claude-code/testing'

import type { HttpResponse, On } from 'claude-code'

import { answerTail, backgroundDetail, clip, sessionName, toolDetail } from './status'
import { boardSessionId, eccSummary, parseBoardUrl } from './report'

const BOARD = { options: { boardUrl: 'http://board.lan:7777/?token=secret', token: '' } }
const T0 = Date.UTC(2026, 10, 3, 8, 0, 0)
const OK: HttpResponse = { status: 204, ok: true, headers: {}, text: '' }
const COMPOSER = { kind: 'composer' } as const
const COMMAND = {
  command: 'session-board',
  args: '',
  origin: COMPOSER,
  presentation: { isFullscreen: true, columns: 160 },
}

type Post = { url: string; headers: Record<string, string>; body: Record<string, any> }
type World = {
  posts: Post[]
  respond: (post: Post) => HttpResponse | { deny: string } | Promise<HttpResponse>
  sessionId: string
  ecc: Record<string, unknown>
  /** session-board's own $.state values, as the host holds them across a reload. */
  mine: Record<string, unknown>
  /** When set, writes to $.state are refused with this reason. */
  stateDeny: string | null
}

/** The engine beneath the plugin: a board that records each POST, a host, a session. */
function world(on: On): World {
  const w: World = { posts: [], respond: () => OK, sessionId: 'session-one', ecc: {}, mine: {}, stateDeny: null }
  on('http.fetch', async (_, e) => {
    const post = { url: e.url, headers: e.init?.headers ?? {}, body: JSON.parse(e.init?.body ?? '{}') }
    w.posts.push(post)
    const answer = await w.respond(post)
    return 'deny' in answer ? answer : { value: answer }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'mac-mini\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.id', () => ({ value: w.sessionId }))
  on('state.get', (_, e) => {
    const { plugin, key } = e as { plugin: string; key: string }
    const value = (plugin === 'session-board' ? w.mine : w.ecc)[key]
    return { value: { value, version: value === undefined ? 0 : 1 } }
  })
  on('state.set', (_, e) => {
    if (w.stateDeny !== null) return { deny: w.stateDeny }
    const { plugin, key, value } = e as { plugin: string; key: string; value: unknown }
    if (plugin === 'session-board') w.mine[key] = value
    return { value: { isSet: true, version: 2 } }
  })
  on('command.register', () => ({ value: { command: 'session-board' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => e)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: {} }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))
  on('classic.Stop', () => ({}))
  return w
}

const states = (w: World) => w.posts.map(p => p.body.state)
const last = (w: World) => w.posts[w.posts.length - 1]!.body

async function start($: any, clock: { settle: () => Promise<void> }) {
  await $.session.start({ cwd: '/Users/me/work/app', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

test('reports each state of a turn as it happens', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)

  await clock.advance(1000)
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  await clock.settle()
  await clock.advance(1000)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'pnpm test' } })
  await clock.settle()
  const approval = last(w)
  await clock.advance(2000)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  await clock.settle()
  await $.turn.complete({ answer: 'All 12 tests pass.\nCommit?\n\n', durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-one', resume: { id: 'session-one' } })

  expect(states(w)).toEqual(['your-turn', 'working', 'needs-approval', 'working', 'your-turn', 'ended'])
  expect(w.posts[0]!.url).toBe('http://board.lan:7777/api/sessions/session-one')
  expect(w.posts[0]!.headers.Authorization).toBe('Bearer secret')
  expect(w.posts[0]!.body).toMatchObject({ v: 1, host: 'mac-mini', cwd: '/Users/me/work/app', project: 'app', ecc: null })
  expect(w.posts[1]!.body.lastPrompt).toEqual({ text: 'run the tests', at: new Date(T0 + 1000).toISOString() })
  expect(approval).toMatchObject({ detail: 'Bash: pnpm test', since: new Date(T0 + 2000).toISOString() })
  expect(w.posts[4]!.body.lastAnswer.tail).toEqual(['All 12 tests pass.', 'Commit?'])
  expect(w.posts[4]!.body.detail).toBe(null)
})

test('a heartbeat every 5 seconds keeps since, and stops once the session ended', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await clock.advance(5000)
  await clock.advance(5000)

  expect(w.posts.map(p => p.body.sentAt)).toEqual([0, 5000, 10000].map(ms => new Date(T0 + ms).toISOString()))
  expect(new Set(w.posts.map(p => p.body.since)).size).toBe(1)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-one', resume: { id: 'session-one' } })
  const count = w.posts.length
  await clock.advance(15000)
  expect(w.posts.length).toBe(count)
})

test("a subagent's turns leave the session's state alone", BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await clock.settle()
  await $.turn.start({ text: 'sub task', turnId: 't2', agentId: 'a1' })
  await $.turn.complete({ answer: 'sub done', durationMs: 10, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' })
  await clock.settle()

  expect(states(w)).toEqual(['your-turn', 'working'])
  expect(last(w).lastPrompt.text).toBe('review it')
})

test('a question to the person counts as waiting, and ends when it is answered', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  let detailWhileAsking: unknown
  // Registered before world(): the first test hook to answer ends the chain.
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await clock.settle()
    detailWhileAsking = last(w).detail
    return { result: {} }
  })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'plan it', turnId: 't1' })
  await clock.settle()
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which database?', header: 'DB', options: [], multiSelect: false }] } as never)
  await clock.settle()

  expect(detailWhileAsking).toBe('提问: Which database?')
  expect(states(w)).toEqual(['your-turn', 'working', 'needs-approval', 'working'])
})

test('another tool finishing does not end the wait for an approval', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'clean up', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  await clock.settle()
  await $.tool.call({ tool: 'Read', file_path: '/Users/me/work/app/README.md' })
  await clock.settle()

  expect(last(w)).toMatchObject({ state: 'needs-approval', detail: 'Bash: rm -rf build' })
})

test('a permission notification is a fallback when no permission request was seen', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'needs-approval', detail: 'Claude needs your permission to use Bash' })

  await $.tool.call({ tool: 'Bash', command: 'make' })
  await clock.settle()
  expect(last(w).state).toBe('working')
})

test('an unreachable board never breaks the session, and /session-board says why', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.respond = () => ({ deny: 'connect ECONNREFUSED 192.168.0.226:7777' })
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  const ran = await $.command.run(COMMAND)
  expect(ran.text).toContain('看板  http://board.lan:7777')
  expect(ran.text).toContain('状态  轮到你')
  expect(ran.text).toMatch(/上报  失败：.*ECONNREFUSED/)

  w.respond = () => ({ status: 401, ok: false, headers: {}, text: 'unauthorized' })
  expect((await $.command.run(COMMAND)).text).toContain('上报  失败：HTTP 401: unauthorized')

  w.respond = () => OK
  await clock.advance(3000)
  expect((await $.command.run(COMMAND)).text).toContain('上报  成功，0 秒前')
})

test('without a board URL nothing is sent and /session-board explains the setting', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(10000)

  expect(w.posts).toEqual([])
  expect((await $.command.run(COMMAND)).text).toContain('还没配置看板地址')
})

test("carries ecc-progress's figures, read from its state", BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.ecc = {
    prd: {
      file: 'x.prd.md',
      title: 'Session board',
      milestones: [
        { n: '1', name: 'a', status: 'complete', plans: [] },
        { n: '2', name: 'b', status: 'in-progress', plans: [] },
        { n: '3', name: 'c', status: 'in-progress', plans: [] },
        { n: '4', name: 'd', status: 'pending', plans: [] },
      ],
    },
    plan: { file: 'p.plan.md', name: 'Reporter', tasks: [{}, {}, {}, {}, {}], isArchived: false },
    live: { planPath: 'p.plan.md', doneTasks: [1, 2], currentTask: 3, phase: 'EXECUTE', isActive: true },
  }
  await start($, clock)

  expect(last(w).ecc).toEqual({
    prd: { title: 'Session board', done: 1, total: 4, inProgress: ['2', '3'] },
    plan: { name: 'Reporter', done: 2, total: 5, isArchived: false },
    phase: 'EXECUTE',
    isActive: true,
  })
})

test('after /clear the old session is ended and a new one starts under the new id', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'first', turnId: 't1' })
  await clock.settle()
  w.sessionId = 'session-two'
  await $.session.end({ reason: 'clear', sessionId: 'session-one', resume: { id: 'session-one' } })
  await clock.settle()

  expect(w.posts.map(p => [p.url.split('/').pop(), p.body.state])).toEqual([
    ['session-one', 'your-turn'],
    ['session-one', 'working'],
    ['session-one', 'ended'],
    ['session-two', 'your-turn'],
  ])
  expect(last(w).lastPrompt).toBe(null)
})

test('the pure helpers', () => {
  expect(parseBoardUrl('http://192.168.0.226:7777/?token=abc', '')).toEqual({ base: 'http://192.168.0.226:7777', token: 'abc' })
  expect(parseBoardUrl('192.168.0.226:7777/', 'mine')).toEqual({ base: 'http://192.168.0.226:7777', token: 'mine' })
  expect(parseBoardUrl('  ', 'x')).toBe(null)
  expect(parseBoardUrl('ftp://host', 'x')).toBe(null)
  expect(boardSessionId('a b/c')).toBe('a-b-c')
  expect(toolDetail('Write', { file_path: 'src/a.ts', content: 'x' })).toBe('Write: src/a.ts')
  expect(toolDetail('mcp__x__y', {})).toBe('mcp__x__y')
  expect(toolDetail('Bash', { command: 'x'.repeat(300) }).length).toBe(200)
  expect(answerTail(Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n'))).toEqual(
    Array.from({ length: 10 }, (_, i) => `line ${i + 5}`),
  )
  expect(answerTail('  \n\n')).toEqual([])
  expect(eccSummary(null, null, null)).toBe(null)
  expect(eccSummary(null, { name: 'P', tasks: [1, 2], isArchived: true }, null)).toEqual({
    prd: null,
    plan: { name: 'P', done: 2, total: 2, isArchived: true },
    phase: null,
    isActive: false,
  })
})

test('after /resume the old card is ended and the resumed conversation reports under its own id', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  w.sessionId = 'session-two'
  await $.session.end({ reason: 'resume', sessionId: 'session-one', resume: { id: 'session-one' } })
  await clock.settle()
  await clock.advance(5000)

  expect(w.posts.map(p => [p.url.split('/').pop(), p.body.state])).toEqual([
    ['session-one', 'your-turn'],
    ['session-one', 'ended'],
    ['session-two', 'your-turn'],
    ['session-two', 'your-turn'],
  ])
})

test('a board that never answers times out, and /session-board still answers', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.respond = () => clock.sleep(60000).then(() => OK)
  await start($, clock)
  const ran = $.command.run(COMMAND)
  await clock.advance(4000)

  expect((await ran).text).toContain('上报  失败：4 秒内没有回应')
  w.respond = () => OK
  await clock.advance(5000)
  expect((await $.command.run(COMMAND)).text).toContain('上报  成功')
})

test("a main-loop tool finishing leaves a subagent's approval waiting", BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'make' }, agent_id: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'make' })
  await clock.settle()
  expect(last(w).state).toBe('needs-approval')

  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'a1' } as never)
  await clock.settle()
  expect(last(w).state).toBe('working')
})

test("the answer reaches the board at once even when Stop already moved the state", BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false })
  await clock.settle()
  await $.turn.complete({ answer: 'finished', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(last(w)).toMatchObject({ state: 'your-turn', lastAnswer: { tail: ['finished'] } })
})

test('cutting text never leaves half an emoji behind', () => {
  expect(clip('ab😀', 3)).toBe('ab')
  expect(clip('ab😀', 4)).toBe('ab😀')
  expect(clip('abc', 2)).toBe('ab')
  const tail = answerTail('x'.repeat(499) + '😀')
  expect(tail[0]).toBe('x'.repeat(499))
})

const named = (args: string) => ({ ...COMMAND, args })

test('/session-board name sets a name the board shows, reported at once, and clears it', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  expect(last(w).name).toBe(null)

  const set = await $.command.run(named('name   前端   重构  '))
  await clock.settle()
  expect(set.text).toContain('名称已设为「前端 重构」')
  expect(last(w).name).toBe('前端 重构')
  expect(w.mine.name).toBe('前端 重构')
  expect((await $.command.run(COMMAND)).text).toContain('名称  前端 重构')

  await clock.advance(5000)
  expect(last(w).name).toBe('前端 重构')

  const cleared = await $.command.run(named('name'))
  await clock.settle()
  expect(cleared.text).toContain('名称已清除')
  expect(last(w).name).toBe(null)
  expect((await $.command.run(COMMAND)).text).toContain('名称  （未设置，显示项目名 app）')
})

test('a name kept in state outlives a reload and carries over to the session after /clear', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.mine.name = '接口联调'
  await start($, clock)
  expect(last(w).name).toBe('接口联调')

  w.sessionId = 'session-two'
  await $.session.end({ reason: 'clear', sessionId: 'session-one', resume: { id: 'session-one' } })
  await clock.settle()
  expect(w.posts.map(p => [p.url.split('/').pop(), p.body.name]).slice(-2)).toEqual([
    ['session-one', '接口联调'],
    ['session-two', '接口联调'],
  ])
})

test('/session-board with an unknown argument shows how to use it', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  world(on)
  await start($, clock)
  const ran = await $.command.run(named('rename x'))
  expect(ran.text).toContain('/session-board name <名称>')
})

test('a name works without a board URL too, and is sent once one is set', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  expect((await $.command.run(named('name docs'))).text).toContain('名称已设为「docs」')
  expect(w.posts).toEqual([])
})

test('names are tidied and cut to 40 characters', () => {
  expect(sessionName('  a \t\n b  ')).toBe('a b')
  expect(sessionName('   ')).toBe(null)
  expect(sessionName('x'.repeat(50))).toBe('x'.repeat(40))
  expect(sessionName('名'.repeat(39) + '😀')).toBe('名'.repeat(39))
  expect(sessionName('a\u0000b\u202Ec')).toBe('a b c')
})

test('a name set while a report is still out goes out right after it', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  let release = () => {}
  await start($, clock)
  w.respond = () => new Promise<HttpResponse>(resolve => { release = () => resolve(OK) })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.settle()
  expect(last(w).name).toBe(null)

  await $.command.run(named('name 联调'))
  w.respond = () => OK
  release()
  await clock.settle()
  expect(last(w).name).toBe('联调')
  expect(last(w).state).toBe('working')
})

test('a name that cannot be kept still applies, and the reply says so', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.stateDeny = 'state is read-only here'
  await start($, clock)
  const ran = await $.command.run(named('name 临时'))
  await clock.settle()
  expect(ran.text).toContain('名称已设为「临时」')
  expect(ran.text).toContain('名称没能保存')
  expect(last(w).name).toBe('临时')
})

test('a name of only hidden characters is cleared, and the reply says why', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  world(on)
  await start($, clock)
  const ran = await $.command.run(named('name \u200b\u202e'))
  expect(ran.text).toContain('名称里没有能显示的字，已清除')
})

const task = (type: string, id = type) => ({ id, type, status: 'running', description: id })
const notified = { text: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } }

test('backgroundDetail names the count and the distinct types, in first-seen order', () => {
  expect(backgroundDetail([task('shell')])).toBe('后台 1 个任务：shell')
  expect(backgroundDetail([task('shell', 'a'), task('subagent'), task('shell', 'b')])).toBe('后台 3 个任务：shell · subagent')
  expect(backgroundDetail([task('a'), task('b'), task('c'), task('d')])).toBe('后台 4 个任务：a · b · c 等')
  expect(backgroundDetail([task('x'.repeat(300))]).length).toBe(200)
})

test('a turn that ends with a background task still running stays working until the task wakes the session', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)

  await clock.advance(1000)
  await $.prompt.submit({ text: 'start the server', origin: COMPOSER } as never)
  await $.turn.start({ text: 'start the server', turnId: 't1' })
  await clock.settle()
  const sinceWorking = last(w).since
  await clock.advance(2000)
  await $.classic.Stop({ background_tasks: [task('shell')] } as never)
  await $.turn.complete({ answer: 'Server is up.', durationMs: 3000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(last(w)).toMatchObject({ state: 'working', detail: '后台 1 个任务：shell', since: sinceWorking })
  expect(last(w).lastAnswer.tail).toEqual(['Server is up.'])

  await clock.advance(5000)
  await $.prompt.submit(notified as never)
  await $.turn.start({ text: notified.text, turnId: 't2' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: null })
  expect(last(w).lastPrompt.text).toBe('start the server')

  await $.classic.Stop({ background_tasks: [] } as never)
  await $.turn.complete({ answer: 'The server exited.', durationMs: 100, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'your-turn', detail: null })
  expect(last(w).lastAnswer.tail).toEqual(['The server exited.'])
})

test('Stop after turn.complete corrects your-turn back to working when tasks are running', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  await $.classic.Stop({ background_tasks: [task('subagent')] } as never)
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: '后台 1 个任务：subagent' })
})

test('only the person\'s own prompts become the last prompt', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)

  for (const kind of ['bridge', 'sdk']) {
    await $.prompt.submit({ text: `from ${kind}`, origin: { kind } } as never)
    await $.turn.start({ text: `from ${kind}`, turnId: kind })
    await clock.settle()
    expect(last(w).lastPrompt.text).toBe(`from ${kind}`)
  }
  for (const kind of ['task-notification', 'peer', 'scheduled-trigger']) {
    await $.prompt.submit({ text: `from ${kind}`, origin: { kind } } as never)
    await $.turn.start({ text: `from ${kind}`, turnId: kind })
    await clock.settle()
    expect(last(w)).toMatchObject({ state: 'working' })
    expect(last(w).lastPrompt.text).toBe('from sdk')
  }
  // The remembered origin is spent: a turn.start with no prompt.submit counts as the person's.
  await $.turn.start({ text: 'typed directly', turnId: 'z' })
  await clock.settle()
  expect(last(w).lastPrompt.text).toBe('typed directly')
})

/** A main-loop turn that ends at the current time with tasks running behind it. */
async function endTurnWithTask($: any, clock: { settle: () => Promise<void> }, tasks = [task('shell')]) {
  await $.turn.start({ text: 'start the server', turnId: 't1' })
  await $.classic.Stop({ background_tasks: tasks } as never)
  await $.turn.complete({ answer: 'Server is up.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
}

test('tasks still running after 3 minutes hand the session back to the person, keeping the detail', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await endTurnWithTask($, clock)

  await clock.advance(175_000)
  expect(last(w)).toMatchObject({ state: 'working', detail: '后台 1 个任务：shell' })
  await clock.advance(5_000)
  await clock.settle()
  expect(last(w)).toMatchObject({
    state: 'your-turn',
    detail: '后台 1 个任务：shell',
    since: new Date(T0 + 180_000).toISOString(),
  })
  expect(last(w).lastAnswer.tail).toEqual(['Server is up.'])

  // The wake still clears the remembered tasks as usual.
  await $.prompt.submit(notified as never)
  await $.turn.start({ text: notified.text, turnId: 't2' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: null })
})

test('a wake before 3 minutes cancels the switch to your-turn', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await endTurnWithTask($, clock)
  await clock.advance(60_000)
  await $.prompt.submit(notified as never)
  await $.turn.start({ text: notified.text, turnId: 't2' })
  await $.classic.Stop({ background_tasks: [] } as never)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  const posts = w.posts.length
  await clock.advance(300_000)
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'your-turn', detail: null, since: new Date(T0 + 60_000).toISOString() })
  expect(new Set(w.posts.slice(posts).map(p => p.body.since)).size).toBe(1)
})

test("a subagent's Stop leaves a session with tasks running alone", BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await endTurnWithTask($, clock)
  await $.classic.Stop({ agent_id: 'a1', background_tasks: [] } as never)
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: '后台 1 个任务：shell' })
})

test('an approval answered while tasks run goes back to working with the tasks shown', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await endTurnWithTask($, clock)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'pnpm test' } })
  await clock.settle()
  expect(last(w).state).toBe('needs-approval')
  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: '后台 1 个任务：shell' })
})

test('turn.complete with tasks running replaces a stuck approval with working', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.classic.Stop({ background_tasks: [task('shell')] } as never)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await clock.settle()
  expect(last(w).state).toBe('needs-approval')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: '后台 1 个任务：shell' })
})

test('/clear forgets the tasks and the remembered prompt origin', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await endTurnWithTask($, clock)
  await $.prompt.submit({ text: 'same', origin: { kind: 'peer' } } as never)
  w.sessionId = 'session-two'
  await $.session.end({ reason: 'clear', sessionId: 'session-one', resume: { id: 'session-one' } })
  await clock.settle()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: null })
  await $.turn.start({ text: 'same', turnId: 't3' })
  await clock.settle()
  expect(last(w).lastPrompt.text).toBe('same')
})

test('a prompt.submit that no turn.start followed does not hide the next typed prompt', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.prompt.submit(notified as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(last(w).lastPrompt.text).toBe('hi')
})

test("the person's prompt while tasks run clears them and becomes the last prompt", BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await endTurnWithTask($, clock)
  await $.prompt.submit({ text: 'stop it', origin: COMPOSER } as never)
  await $.turn.start({ text: 'stop it', turnId: 't2' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: null })
  expect(last(w).lastPrompt.text).toBe('stop it')
})

test('a second Stop with fewer tasks updates the count and stays working', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await endTurnWithTask($, clock, [task('shell', 'a'), task('subagent')])
  expect(last(w).detail).toBe('后台 2 个任务：shell · subagent')
  await $.prompt.submit(notified as never)
  await $.turn.start({ text: notified.text, turnId: 't2' })
  await $.classic.Stop({ background_tasks: [task('subagent')] } as never)
  await $.turn.complete({ answer: 'one left', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'working', detail: '后台 1 个任务：subagent' })
})

test('an approval resolved after the 3 minutes returns to your-turn, not working', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await endTurnWithTask($, clock)
  await clock.advance(180_000)
  await clock.settle()
  expect(last(w).state).toBe('your-turn')

  await $.classic.PermissionRequest({ agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } } as never)
  await clock.settle()
  expect(last(w).state).toBe('needs-approval')
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await clock.settle()
  expect(last(w)).toMatchObject({ state: 'your-turn', detail: '后台 1 个任务：shell' })
})

test('a task notification that arrives between Stop and turn.complete still keeps the last prompt', BOARD, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($, clock)
  await $.prompt.submit({ text: 'start the server', origin: COMPOSER } as never)
  await $.turn.start({ text: 'start the server', turnId: 't1' })
  await $.classic.Stop({ background_tasks: [task('shell')] } as never)
  await $.prompt.submit(notified as never)
  await $.turn.complete({ answer: 'Server is up.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: notified.text, turnId: 't2' })
  await clock.settle()
  expect(last(w).lastPrompt.text).toBe('start the server')
})
