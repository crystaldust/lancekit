import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { CommandPresentation, On, UiOpenResult } from 'claude-code'

import { parseDoneTasks, parseMilestones, parseTasks, parseTitle, planTargets, resolveLink } from './parse'

const PRP_PRD = `# Checkout Flow

## Implementation Phases

| # | Phase | Description | Status | Parallel | Depends | PRP Plan |
|---|-------|-------------|--------|----------|---------|----------|
| 1 | Data model | tables | complete | - | - | plans/a.plan.md |
| 2 | Cart API | endpoints | in-progress | - | 1 | - |
| 3 | Payments | stripe | pending | - | 2 | - |
`

const PLAN_PRD = `| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | Login | users sign in | \`complete\` | — |
| 2 | Billing | invoices | pending | — |
`

const PLAN = `# Feature: Cart API

## Step-by-Step Tasks

### Task 1: Create CartService
### Task 2: Add routes
### Task 3 — Wire validation
`

test('reads the phase table of a /prp-prd PRD', () => {
  expect(parseMilestones(PRP_PRD)).toEqual([
    { n: '1', name: 'Data model', status: 'complete', plans: ['plans/a.plan.md'] },
    { n: '2', name: 'Cart API', status: 'in-progress', plans: [] },
    { n: '3', name: 'Payments', status: 'pending', plans: [] },
  ])
  expect(parseTitle(PRP_PRD, 'x')).toBe('Checkout Flow')
})

test('reads the milestone table of a /plan-prd PRD', () => {
  expect(parseMilestones(PLAN_PRD).map(m => m.status)).toEqual(['complete', 'pending'])
})

test('ignores tables without a phase or milestone column', () => {
  expect(parseMilestones('| Section | Status |\n|---|---|\n| A | done |\n')).toEqual([])
})

test('a plan cell may link several plans, resolved from the PRD folder', () => {
  const cell = '[4a 编排](../plans/completed/a.plan.md) · [4b 界面](../plans/b.plan.md#tasks) · [sub](x.prd.md)'
  expect(planTargets(cell)).toEqual(['../plans/completed/a.plan.md', '../plans/b.plan.md'])
  expect(planTargets('.claude/PRPs/plans/c.plan.md')).toEqual(['.claude/PRPs/plans/c.plan.md'])
  expect(planTargets('-')).toEqual([])
  expect(resolveLink('.claude/PRPs/prds/x.prd.md', '../plans/b.plan.md')).toBe('.claude/PRPs/plans/b.plan.md')
  expect(resolveLink('.claude/PRPs/prds/x.prd.md', '.claude/PRPs/plans/c.plan.md')).toBe('.claude/PRPs/plans/c.plan.md')
})

test('reads plan tasks and the [done] log lines', () => {
  expect(parseTasks(PLAN).map(t => `${t.n}:${t.name}`)).toEqual([
    '1:Create CartService',
    '2:Add routes',
    '3:Wire validation',
  ])
  expect(parseDoneTasks('[done] Task 1: x — complete\n[done] Task 2: y')).toEqual([1, 2])
})

const PANE = {
  plugin: 'ecc-progress',
  component: 'Pane',
  requestId: 'ecc-progress',
  props: {
    title: 'ECC Progress',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the pane shows a hint before any PRD or plan exists, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'ecc-progress' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ecc-progress__report' } }))
  on('fs.exists', () => ({ value: false }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /No PRD or plan/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a report from the model marks plan tasks in the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'ecc-progress' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ecc-progress__report' } }))
  on('fs.exists', (_, e) => ({ value: String(e.path).endsWith('.claude/PRPs/plans') }))
  on('fs.list', () => ({
    value: [{ name: 'cart-api.plan.md', kind: 'file', size: 1, mtimeMs: 1, isLink: false }],
  }))
  on('fs.read', () => ({ value: PLAN }))
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ecc-progress__report', phase: 'execute', task: 1, taskStatus: 'done' })
  await $.tool.call({ tool: 'mcp__ecc-progress__report', task: 2, taskStatus: 'started' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /T1 / }))?.text).toBe('✓ T1 Create CartService')
    expect((await ui.find({ type: 'Text', text: /T2 / }))?.text).toBe('▶ T2 Add routes')
    expect(await ui.find({ type: 'Text', text: /1\/3\s+EXECUTE/ })).toBeDefined()
    await ui.unmount()
  }
})

const PLANS = '/.claude/PRPs/plans'
const ARCHIVE = `${PLANS}/completed`
const PRDS = '/.claude/PRPs/prds'

/** A project tree: each directory's files (newest first) and their text. */
type Tree = Record<string, Record<string, string>>

/** The engine resolves the plugin's relative paths against the session cwd; keep the project-relative tail. */
const absolute = (path: unknown) => {
  const text = String(path)
  return text.slice(Math.max(0, text.indexOf('/.claude')))
}
const split = (path: string) => [path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1)] as const

const PLACED: UiOpenResult = { isPlaced: true }

function mockProject(on: On, tree: Tree, placed: UiOpenResult = PLACED) {
  const opened: string[] = []
  const titles: string[] = []
  const toasts: string[] = []
  const fileText = (path: string) => {
    const [dir, name] = split(path)
    return tree[dir]?.[name]
  }
  on('command.register', () => ({ value: { command: 'ecc-progress' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ecc-progress__report' } }))
  on('fs.exists', (_, e) => {
    const path = absolute(e.path)
    return { value: path in tree || fileText(path) !== undefined }
  })
  on('fs.list', (_, e) => {
    const names = Object.keys(tree[absolute(e.path)] ?? {})
    return {
      value: names.map((name, index) => ({ name, kind: 'file', size: 1, mtimeMs: names.length - index, isLink: false })),
    }
  })
  on('fs.read', (_, e) => ({ value: fileText(absolute(e.path)) ?? '' }))
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    opened.push(String(e.id))
    titles.push(String(e.title))
    return { value: placed }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { opened, titles, toasts, clock }
}

const ABOVE_PROMPT = {
  plugin: 'ecc-progress',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

const COMPOSER = { kind: 'composer' } as const
const IMPLEMENT_PROMPT = {
  text: '/prp-implement',
  command: { name: 'prp-implement', args: '' },
  origin: COMPOSER,
  wait: false,
}
const DOCKED: CommandPresentation = { isFullscreen: true, columns: 160 }
const MAIN_SCREEN: CommandPresentation = { isFullscreen: false, columns: 200 }
const NARROW: CommandPresentation = { isFullscreen: true, columns: 96 }

/** `/ecc-progress` as the person types it, in the given layout. */
const eccProgress = (presentation: CommandPresentation) => ({
  command: 'ecc-progress',
  args: '',
  origin: COMPOSER,
  presentation,
})

/** Draws the prompt band once, so the plugin learns whether this terminal docks panes. */
async function seeLayout($: Engine, isFullscreen: boolean) {
  const ui = await $.ui.mount({ ...ABOVE_PROMPT, surface: 'terminal', viewport: { columns: 160, rows: 40, isFullscreen } })
  await ui.unmount()
}

const DONE_PRD = PRP_PRD.replace(/in-progress|pending/g, 'complete')

test('with every plan archived, the pane shows the newest archived plan', async ($, on) => {
  mockProject(on, {
    [PLANS]: {},
    [ARCHIVE]: { 'cart-api.plan.md': PLAN, 'older.plan.md': '# Plan: Older\n### Task 1: Old' },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Plan Feature: Cart API \(archived\)/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /T2 / }))?.text).toBe('✓ T2 Add routes')
  await ui.unmount()
})

test('a PRD with unfinished phases opens the pane once the layout docks panes', async ($, on) => {
  const { opened, clock } = mockProject(on, { [PRDS]: { 'checkout.prd.md': PRP_PRD } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).not.toContain('ecc-progress')
  await seeLayout($, true)
  await clock.advance(4000)

  expect(opened).toContain('ecc-progress')
})

test('on the main screen a PRD with unfinished phases leaves the pane closed', async ($, on) => {
  const { opened, clock } = mockProject(on, { [PRDS]: { 'checkout.prd.md': PRP_PRD } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await seeLayout($, false)
  await clock.advance(4000)

  expect(opened).not.toContain('ecc-progress')
})

test('a PRD with every phase complete leaves the pane closed', async ($, on) => {
  const { opened, clock } = mockProject(on, { [PRDS]: { 'checkout.prd.md': DONE_PRD } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await seeLayout($, true)
  await clock.advance(4000)

  expect(opened).not.toContain('ecc-progress')
})

const LINKED_PRD = PRP_PRD.replace(
  '| 2 | Cart API | endpoints | in-progress | - | 1 | - |',
  '| 2 | Cart API | endpoints | in-progress | - | 1 | [2a](../plans/completed/old.plan.md) · [2b](../plans/cart-api.plan.md) |',
)

test('idle, the pane shows the open plan of the in-progress phase, not the newest edited plan', async ($, on) => {
  mockProject(on, {
    [PRDS]: { 'checkout.prd.md': LINKED_PRD },
    [PLANS]: { 'payments.plan.md': '# Plan: Payments\n### Task 1: Stripe', 'cart-api.plan.md': PLAN },
    [ARCHIVE]: { 'old.plan.md': '# Plan: Old\n### Task 1: Old' },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Plan Feature: Cart API$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Payments$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Plan Plan: Payments/ })).toBeUndefined()
  await ui.unmount()
})

test('idle, a PRD that links no open plan shows its phases alone', async ($, on) => {
  mockProject(on, {
    [PRDS]: { 'checkout.prd.md': PRP_PRD },
    [PLANS]: { 'payments.plan.md': '# Plan: Payments\n### Task 1: Stripe' },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^PRD Checkout Flow$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Plan / })).toBeUndefined()
  await ui.unmount()
})

test('/ecc-progress says why the pane is not shown', async ($, on) => {
  mockProject(on, { [PRDS]: { 'checkout.prd.md': PRP_PRD } }, { isPlaced: false, reason: 'no-surface' })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run(eccProgress(DOCKED))

  expect(ran.text).toBe('ECC progress pane not shown: no-surface')
})

test('/ecc-progress says where the pane went: docked, or above the prompt and why', async ($, on) => {
  mockProject(on, { [PRDS]: { 'checkout.prd.md': PRP_PRD } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run(eccProgress(DOCKED))).text).toBe('ECC progress pane opened on the right.')
  expect((await $.command.run(eccProgress(NARROW))).text).toBe(
    'ECC progress pane opened above the prompt: the terminal is 96 columns; it docks on the right in the fullscreen layout at 110+ columns.',
  )
  expect((await $.command.run(eccProgress(MAIN_SCREEN))).text).toMatch(/^ECC progress pane opened above the prompt: this session draws on the main screen/)
})

test('a run whose pane is not shown says so in a toast', async ($, on) => {
  const { toasts } = mockProject(
    on,
    { [PLANS]: { 'cart-api.plan.md': PLAN } },
    { isPlaced: false, reason: 'unasked panes need 144 columns; the terminal has 96' },
  )

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(IMPLEMENT_PROMPT)

  expect(toasts).toEqual([
    'ECC progress pane not shown (unasked panes need 144 columns; the terminal has 96); type /ecc-progress to open it',
  ])
})

test('the pane title names the plan it shows', async ($, on) => {
  const { titles } = mockProject(on, { [PLANS]: { 'cart-api.plan.md': PLAN } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(eccProgress(DOCKED))

  expect(titles).toEqual(['ECC Progress · Feature: Cart API'])
})

test('a plan without task headings says so instead of an empty 0/0', async ($, on) => {
  mockProject(on, { [PLANS]: { 'lite.plan.md': '# Plan: Lite\n\n## Files to Change\n' } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No `### Task N:` headings/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\/0/ })).toBeUndefined()
  await ui.unmount()
})

test('a run started without a plan path follows the newest open plan into the archive', async ($, on) => {
  const tree: Tree = {
    [PLANS]: { 'cart-api.plan.md': PLAN },
    [ARCHIVE]: { 'older.plan.md': '# Plan: Older\n### Task 1: Old' },
  }
  mockProject(on, tree)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(IMPLEMENT_PROMPT)
  tree[ARCHIVE] = { 'cart-api.plan.md': PLAN, ...tree[ARCHIVE] }
  tree[PLANS] = {}
  await $.tool.call({ tool: 'mcp__ecc-progress__report', phase: 'report' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /3\/3\s+DONE/ })).toBeDefined()
  await ui.unmount()
})
