import { atom, read, update } from 'claude-code'
import type { CommandPresentation, EngineInterface, Register, UiOpenResult } from 'claude-code'

import type { LiveProgress, Milestone, PlanProgress, PrdProgress } from '../types'
import { baseName, parseDoneTasks, parseMilestones, parseTasks, parseTitle, resolveLink } from './parse'

const PANE = 'ecc-progress'
const TITLE = 'ECC Progress'
const TITLE_NAME_CHARS = 32
const TOOL = 'mcp__ecc-progress__report'
const REFRESH_MS = 4000
/** The fullscreen layout docks a pane beside the transcript from this width. */
const DOCK_COLUMNS = 110
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

const isArchivedPath = (path: string) => path.includes('/completed/')

/** The plan the PRD points at next: an open plan linked from an in-progress phase, else from a pending one. */
async function nextPlanOf($: $, prd: PrdProgress): Promise<string | undefined> {
  const phases = [
    ...prd.milestones.filter(m => m.status === 'in-progress'),
    ...prd.milestones.filter(m => m.status === 'pending'),
  ]
  const candidates = phases
    .flatMap(m => m.plans.map(target => resolveLink(prd.file, target)))
    .filter(path => !isArchivedPath(path))
  for (const path of candidates) {
    if (await $.fs.exists(path)) return path
  }
  return undefined
}

/**
 * The plan /prp-implement was started on; else what the PRD points at next (the
 * PRD alone when it points at no open plan); without a PRD, the newest open plan,
 * else the newest archived one.
 */
async function locatePlan($: $, live: LiveProgress, prd: PrdProgress | null) {
  if (live.planPath) {
    if (await $.fs.exists(live.planPath)) return { path: live.planPath, isArchived: isArchivedPath(live.planPath) }
    const archived = `${ARCHIVE_DIR}/${baseName(live.planPath)}`
    if (await $.fs.exists(archived)) return { path: archived, isArchived: true }
  }
  if (prd) {
    const next = await nextPlanOf($, prd)
    return next ? { path: next, isArchived: false } : undefined
  }
  const open = await newestFile($, PLAN_DIR, '.plan.md')
  if (open) return { path: open.path, isArchived: false }
  const archived = await newestFile($, ARCHIVE_DIR, '.plan.md')
  return archived ? { path: archived.path, isArchived: true } : undefined
}

async function loadPlan($: $, live: LiveProgress, prd: PrdProgress | null): Promise<PlanProgress | null> {
  const located = await locatePlan($, live, prd)
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
    const running = prd.milestones.filter(m => m.status === 'in-progress').map(m => m.n)
    parts.push(`M${done}/${prd.milestones.length}${running.length > 0 ? ` ▶${running.join(',')}` : ''}`)
  }
  if (plan && plan.tasks.length > 0 && live.isActive) parts.push(`T${live.doneTasks.length}/${plan.tasks.length}`)
  if (live.isActive && live.phase) parts.push(live.phase)
  return parts.length > 0 ? `ECC ${parts.join(' · ')}` : undefined
}

async function refresh($: $) {
  const live = await read($, liveAtom)
  const prd = await loadPrd($)
  const plan = await loadPlan($, live, prd)
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

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Opens the pane, its tab naming the plan shown (else the PRD), so two projects' panes tell apart.
 * Then asks for a drawing: a pane restored on resume can be up before the plugin first drew it,
 * and unchanged progress would never draw it again.
 */
async function openPane($: $): Promise<UiOpenResult> {
  const name = (await read($, planAtom))?.name ?? (await read($, prdAtom))?.title
  const opened = await $.ui.open({ id: PANE, title: name ? `${TITLE} · ${clip(name, TITLE_NAME_CHARS)}` : TITLE })
  if (opened.isPlaced) $.ui.invalidate('ui.render')
  return opened
}

/** The /ecc-progress answer: where the pane went, or why it is not shown. */
function openedText(opened: UiOpenResult, where: CommandPresentation): string {
  if (!opened.isPlaced) return `ECC progress pane not shown: ${opened.reason}`
  if (where.isFullscreen && where.columns >= DOCK_COLUMNS) return 'ECC progress pane opened on the right.'
  const why = where.isFullscreen
    ? `the terminal is ${where.columns} columns`
    : 'this session draws on the main screen (fullscreen layout off, as under tmux)'
  return `ECC progress pane opened above the prompt: ${why}; it docks on the right in the fullscreen layout at ${DOCK_COLUMNS}+ columns.`
}

/**
 * Without a path argument, /prp-implement runs the plan the PRD points at next,
 * else the newest open plan; remember it so its archiving ends the run.
 */
async function startRun($: $, args: string) {
  const prd = await loadPrd($)
  const planPath =
    args.trim().split(/\s+/)[0] ||
    (prd ? await nextPlanOf($, prd) : undefined) ||
    (await newestFile($, PLAN_DIR, '.plan.md'))?.path ||
    null
  await update($, liveAtom, () => ({ ...IDLE, planPath, phase: 'DETECT', isActive: true }))
  await refresh($)
  const opened = await openPane($)
  if (!opened.isPlaced) {
    $.ui.toast(`ECC progress pane not shown (${opened.reason}); type /ecc-progress to open it`)
  }
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
  /** Whether the surface docks panes beside the transcript, as the prompt band's drawing last said. */
  let isFullscreen: boolean | undefined
  /** The session started with work to show; opened on a refresh once the layout is known to dock it. */
  let wantsAutoOpen = false

  /**
   * True once, when the pane should open unasked: only where it becomes a
   * sidebar, since inline on the main screen it would crowd the prompt.
   */
  const takeAutoOpen = () => {
    if (!wantsAutoOpen || isFullscreen !== true) return false
    wantsAutoOpen = false
    return true
  }

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
    $.clock.every(REFRESH_MS, async () => {
      await refresh($)
      if (takeAutoOpen()) await openPane($)
    })
    await refresh($)
    const hasOpenMilestone = (await read($, prdAtom))?.milestones.some(m => UNFINISHED.has(m.status)) ?? false
    wantsAutoOpen = (await read($, liveAtom)).isActive || hasOpenMilestone
    if (takeAutoOpen()) await openPane($)
    return next(e)
  })

  // Draws nothing: `session.start` carries no layout, so the prompt band's drawing reports it.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    isFullscreen = e.viewport?.isFullscreen
    return next(e)
  })

  on('command.run', { command: 'ecc-progress' }, async ($, e) => {
    await refresh($)
    return { text: openedText(await openPane($), e.presentation) }
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
