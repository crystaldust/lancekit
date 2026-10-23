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
