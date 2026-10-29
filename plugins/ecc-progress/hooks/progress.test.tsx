import { expect, mock, test } from 'claude-code/testing'

import { parseDoneTasks, parseMilestones, parseTasks, parseTitle } from './parse'

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
    { n: '1', name: 'Data model', status: 'complete' },
    { n: '2', name: 'Cart API', status: 'in-progress' },
    { n: '3', name: 'Payments', status: 'pending' },
  ])
  expect(parseTitle(PRP_PRD, 'x')).toBe('Checkout Flow')
})

test('reads the milestone table of a /plan-prd PRD', () => {
  expect(parseMilestones(PLAN_PRD).map(m => m.status)).toEqual(['complete', 'pending'])
})

test('ignores tables without a phase or milestone column', () => {
  expect(parseMilestones('| Section | Status |\n|---|---|\n| A | done |\n')).toEqual([])
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

function mockProject(on: Parameters<Parameters<typeof test>[1]>[1], tree: Tree) {
  const opened: string[] = []
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
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push(String(e.id))
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return { opened }
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

test('a PRD with unfinished phases opens the pane at session start', async ($, on) => {
  const { opened } = mockProject(on, { [PRDS]: { 'checkout.prd.md': PRP_PRD } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(opened).toContain('ecc-progress')
})

test('a PRD with every phase complete leaves the pane closed', async ($, on) => {
  const { opened } = mockProject(on, { [PRDS]: { 'checkout.prd.md': DONE_PRD } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(opened).not.toContain('ecc-progress')
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
  await $.prompt.submit({ text: '/prp-implement', command: { name: 'prp-implement', args: '' } })
  tree[ARCHIVE] = { 'cart-api.plan.md': PLAN, ...tree[ARCHIVE] }
  tree[PLANS] = {}
  await $.tool.call({ tool: 'mcp__ecc-progress__report', phase: 'report' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /3\/3\s+DONE/ })).toBeDefined()
  await ui.unmount()
})
