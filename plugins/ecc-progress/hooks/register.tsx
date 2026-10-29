import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LiveProgress, Milestone, PlanProgress, PrdProgress } from '../types'
import { baseName, parseDoneTasks, parseMilestones, parseTasks, parseTitle } from './parse'

const PANE = 'ecc-progress'
const TITLE = 'ECC Progress'
const TOOL = 'mcp__ecc-progress__report'
const REFRESH_MS = 4000
const PRD_DIRS = ['.claude/PRPs/prds', '.claude/prds']
const PLAN_DIR = '.claude/PRPs/plans'
const ARCHIVE_DIR = `${PLAN_DIR}/completed`
const IMPLEMENT = /(^|:)prp-implement$/
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash'])

const IDLE: LiveProgress = {
  planPath: null,
  doneTasks: [],
  currentTask: null,
  phase: null,
  isActive: false,
}

const prdAtom = atom({ plugin: 'ecc-progress', key: 'prd' } as const, null)
const planAtom = atom({ plugin: 'ecc-progress', key: 'plan' } as const, null)
const liveAtom = atom({ plugin: 'ecc-progress', key: 'live' } as const, IDLE)

const GUIDE = [
  'ECC progress pane: while executing an ECC /prp-implement plan, call',
  `${TOOL} to keep the person's progress pane current — with {phase} when`,
  'entering each phase (DETECT, LOAD, PREPARE, EXECUTE, VALIDATE, REPORT,',
  'OUTPUT), with {task, taskStatus:"started"} before each plan task and',
  '{task, taskStatus:"done"} right after it. It is cheap; do not skip it.',
].join(' ')

type $ = EngineInterface

async function newestFile($: $, dir: string, suffix: string) {
  if (!(await $.fs.exists(dir))) return undefined
  const entries = await $.fs.list(dir)
  return entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith(suffix))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(entry => ({ path: `${dir}/${entry.name}`, mtimeMs: entry.mtimeMs }))[0]
}

async function loadPrd($: $): Promise<PrdProgress | null> {
  const found = await Promise.all(PRD_DIRS.map(dir => newestFile($, dir, '.prd.md')))
  const newest = found
    .filter(entry => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (!newest) return null
  const text = await $.fs.read(newest.path)
  return {
    file: newest.path,
    title: parseTitle(text, baseName(newest.path)),
    milestones: parseMilestones(text),
  }
}

/** The plan /prp-implement was started on, else the newest open plan, else the newest archived one. */
async function locatePlan($: $, live: LiveProgress) {
  if (live.planPath) {
    if (await $.fs.exists(live.planPath)) return { path: live.planPath, isArchived: false }
    const archived = `${ARCHIVE_DIR}/${baseName(live.planPath)}`
    if (await $.fs.exists(archived)) return { path: archived, isArchived: true }
  }
  const open = await newestFile($, PLAN_DIR, '.plan.md')
  if (open) return { path: open.path, isArchived: false }
  const archived = await newestFile($, ARCHIVE_DIR, '.plan.md')
  return archived ? { path: archived.path, isArchived: true } : undefined
}

async function loadPlan($: $, live: LiveProgress): Promise<PlanProgress | null> {
  const located = await locatePlan($, live)
  if (!located) return null
  const text = await $.fs.read(located.path)
  return {
    file: located.path,
    name: parseTitle(text, baseName(located.path)),
    tasks: parseTasks(text),
    isArchived: located.isArchived,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function statusText(prd: PrdProgress | null, plan: PlanProgress | null, live: LiveProgress) {
  const parts: string[] = []
  if (prd && prd.milestones.length > 0) {
    const done = prd.milestones.filter(m => m.status === 'complete').length
    parts.push(`M${done}/${prd.milestones.length}`)
  }
  if (plan && plan.tasks.length > 0 && live.isActive) parts.push(`T${live.doneTasks.length}/${plan.tasks.length}`)
  if (live.isActive && live.phase) parts.push(live.phase)
  return parts.length > 0 ? `ECC ${parts.join(' · ')}` : undefined
}

async function refresh($: $) {
  const live = await read($, liveAtom)
  const [prd, plan] = await Promise.all([loadPrd($), loadPlan($, live)])
  if (!same(prd, await read($, prdAtom))) await update($, prdAtom, () => prd)
  if (!same(plan, await read($, planAtom))) await update($, planAtom, () => plan)
  // Only the run's own plan reaching the archive ends the run, not an older archived plan.
  const isRunPlan = live.planPath !== null && plan !== null && baseName(plan.file) === baseName(live.planPath)
  if (live.isActive && plan?.isArchived && isRunPlan) {
    await update($, liveAtom, now => ({
      ...now,
      doneTasks: plan.tasks.map(task => task.n),
      currentTask: null,
      phase: 'DONE',
      isActive: false,
    }))
  }
  $.ui.status(statusText(prd, plan, await read($, liveAtom)))
}

/** Without a path argument, /prp-implement runs the newest open plan; remember it so its archiving ends the run. */
async function startRun($: $, args: string) {
  const planPath = args.trim().split(/\s+/)[0] || (await newestFile($, PLAN_DIR, '.plan.md'))?.path || null
  await update($, liveAtom, () => ({ ...IDLE, planPath, phase: 'DETECT', isActive: true }))
  await refresh($)
  void $.ui.open({ id: PANE, title: TITLE })
}

async function markDone($: $, tasks: number[]) {
  if (tasks.length === 0) return
  await update($, liveAtom, live => ({
    ...live,
    doneTasks: [...new Set([...live.doneTasks, ...tasks])].sort((a, b) => a - b),
    currentTask: tasks.includes(live.currentTask ?? -1) ? null : live.currentTask,
  }))
}

type Report = { phase?: unknown; task?: unknown; taskStatus?: unknown }

async function applyReport($: $, report: Report) {
  const task = typeof report.task === 'number' ? report.task : undefined
  if (task !== undefined && report.taskStatus === 'done') await markDone($, [task])
  await update($, liveAtom, live => ({
    ...live,
    isActive: true,
    phase: typeof report.phase === 'string' ? report.phase.toUpperCase() : live.phase,
    currentTask: task !== undefined && report.taskStatus !== 'done' ? task : live.currentTask,
  }))
  await refresh($)
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map(block => (block && block.type === 'text' ? String(block.text) : ''))
          .join('\n')
      : ''

const MARK = { complete: '✓', 'in-progress': '▶', pending: '·', unknown: '?' } as const
const COLOR = { complete: 'green', 'in-progress': 'yellow', pending: undefined, unknown: undefined } as const
const UNFINISHED = new Set<Milestone['status']>(['pending', 'in-progress'])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ecc-progress',
      description: 'Open the ECC progress pane (PRD milestones + /prp-implement tasks)',
    })
    await $.tool.register({
      name: 'report',
      description:
        'Report /prp-implement progress to the ECC progress pane: the phase entered, or a plan task started or done.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          phase: { type: 'string', description: 'Phase name, e.g. EXECUTE' },
          task: { type: 'integer', description: 'Task number from the plan (### Task N)' },
          taskStatus: { type: 'string', enum: ['started', 'done'] },
        },
      },
    })
    $.clock.every(REFRESH_MS, () => void refresh($))
    await refresh($)
    const hasOpenMilestone = (await read($, prdAtom))?.milestones.some(m => UNFINISHED.has(m.status)) ?? false
    if ((await read($, liveAtom)).isActive || hasOpenMilestone) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'ecc-progress' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'ECC progress pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command && IMPLEMENT.test(e.command.name)) await startRun($, e.command.args)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (IMPLEMENT.test(e.skill)) await startRun($, e.args ?? '')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    await applyReport($, e as Report)
    return { result: 'ok' }
  }).catch(() => ({ deny: 'ecc-progress: the progress report was not recorded' }))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (FILE_TOOLS.has(String(e.tool))) await refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'response' }, async ($, e, next) => {
    if ((await read($, liveAtom)).isActive) await markDone($, parseDoneTasks(textOf(e.message.content)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [...composed.sections, { id: 'ecc-progress', text: GUIDE, scope: 'session' }],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [prd, plan, live] = await Promise.all([
      read($, prdAtom),
      read($, planAtom),
      read($, liveAtom),
    ])
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - 2)
    const bar = (done: number, total: number) => {
      const size = Math.max(4, Math.min(20, width - 12))
      const filled = total === 0 ? 0 : Math.round((done / total) * size)
      return `${'█'.repeat(filled)}${'░'.repeat(size - filled)} ${done}/${total}`
    }
    const milestoneRow = (m: Milestone) => (
      <Text color={COLOR[m.status]} dimColor={m.status === 'pending'} wrap="truncate-end">
        {MARK[m.status]} {m.n} {m.name}
      </Text>
    )
    const doneSet = new Set(live.doneTasks)
    const taskMark = (n: number) =>
      doneSet.has(n) || plan?.isArchived ? '✓' : live.currentTask === n ? '▶' : '·'
    const tasksDone = plan ? plan.tasks.filter(t => taskMark(t.n) === '✓').length : 0

    return (
      <Box flexDirection="column">
        {!prd && !plan && (
          <Text dimColor>No PRD or plan under .claude/PRPs yet. Run /plan-prd or /prp-plan.</Text>
        )}
        {prd && (
          <Box flexDirection="column">
            <Text bold wrap="truncate-end">PRD {prd.title}</Text>
            <Text dimColor>
              {bar(prd.milestones.filter(m => m.status === 'complete').length, prd.milestones.length)}
            </Text>
            {prd.milestones.map(milestoneRow)}
          </Box>
        )}
        {plan && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold wrap="truncate-end">
              Plan {plan.name}
              {plan.isArchived ? ' (archived)' : ''}
            </Text>
            {plan.tasks.length > 0 ? (
              <Text dimColor>
                {bar(tasksDone, plan.tasks.length)}
                {live.phase ? `  ${live.phase}` : ''}
              </Text>
            ) : (
              <Text dimColor>
                No `### Task N:` headings in this plan{live.phase ? `  ${live.phase}` : ''}
              </Text>
            )}
            {plan.tasks.map(task => (
              <Text
                color={taskMark(task.n) === '✓' ? 'green' : taskMark(task.n) === '▶' ? 'yellow' : undefined}
                dimColor={taskMark(task.n) === '·'}
                wrap="truncate-end"
              >
                {taskMark(task.n)} T{task.n} {task.name}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
