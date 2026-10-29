import type { Milestone, MilestoneStatus, PlanTask } from '../types'

const SEPARATOR = /^\|[\s:|-]+\|?$/
const NAME_HEADER = /^(phase|milestone)$/i
const PLAN_HEADER = /^(prp\s+)?plan$/i
const LINK_TARGET = /\]\(([^)\s]+)\)/g
const BARE_PLAN = /[^\s|()[\]]+\.plan\.md/g
const TASK_HEADING = /^###\s+Task\s+(\d+)(?:\s*[–-]\s*(\d+))?\s*[:：.\-—]?\s*(.*)$/gim
const DONE_LOG = /\[done\]\s*Task\s+(\d+)/gi

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())

export function normalizeStatus(raw: string): MilestoneStatus {
  const text = raw.replace(/[`*_]/g, '').toLowerCase()
  if (/complete|done/.test(text)) return 'complete'
  if (/progress/.test(text)) return 'in-progress'
  if (/pending|todo/.test(text)) return 'pending'
  return 'unknown'
}

function rowsAfter(lines: string[], start: number): string[] {
  const rows: string[] = []
  for (const line of lines.slice(start)) {
    if (!line.trim().startsWith('|')) break
    rows.push(line)
  }
  return rows
}

/** Reads the milestone / phase table of a PRD written by /plan-prd or /prp-prd. */
export function parseMilestones(markdown: string): Milestone[] {
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] ?? ''
    if (!line.trim().startsWith('|') || !SEPARATOR.test((lines[i + 1] ?? '').trim())) continue
    const header = cellsOf(line)
    const statusAt = header.findIndex(cell => /^status$/i.test(cell))
    const nameAt = header.findIndex(cell => NAME_HEADER.test(cell))
    if (statusAt < 0 || nameAt < 0) continue
    const numberAt = header.findIndex(cell => cell === '#')
    const planAt = header.findIndex(cell => PLAN_HEADER.test(cell))
    return rowsAfter(lines, i + 2).map((line, index) => {
      const cells = cellsOf(line)
      return {
        n: numberAt >= 0 ? cells[numberAt] ?? String(index + 1) : String(index + 1),
        name: cells[nameAt] ?? '',
        status: normalizeStatus(cells[statusAt] ?? ''),
        plans: planAt >= 0 ? planTargets(cells[planAt] ?? '') : [],
      }
    })
  }
  return []
}

/** The plans a PRD row's plan cell names: Markdown links (`[4a](…) · [4b](…)`) or bare paths. */
export function planTargets(cell: string): string[] {
  const linked = [...cell.matchAll(LINK_TARGET)].map(match => (match[1] ?? '').replace(/#.*$/, ''))
  const targets = linked.length > 0 ? linked : [...cell.matchAll(BARE_PLAN)].map(match => match[0])
  return targets.filter(target => target.endsWith('.plan.md'))
}

/** A link target written in the file at `fromFile`, as a path from the project root. */
export function resolveLink(fromFile: string, target: string): string {
  if (target.startsWith('/') || target.startsWith('.claude/')) return target
  return target
    .split('/')
    .reduce<string[]>(
      (parts, part) => (part === '..' ? parts.slice(0, -1) : part === '.' || part === '' ? parts : [...parts, part]),
      fromFile.split('/').slice(0, -1),
    )
    .join('/')
}

export function parseTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)
  return heading?.[1]?.trim() || fallback
}

/** Reads the `### Task N: name` headings of a /prp-plan plan; `### Task 5–12: name` is tasks 5 to 12. */
export function parseTasks(markdown: string): PlanTask[] {
  return [...markdown.matchAll(TASK_HEADING)].flatMap(match => {
    const first = Number(match[1])
    const last = Math.max(first, Number(match[2] ?? first))
    const name = (match[3] ?? '').trim()
    return Array.from({ length: last - first + 1 }, (_, i) => ({ n: first + i, name }))
  })
}

/** Reads the `[done] Task N` lines /prp-implement logs as it goes. */
export function parseDoneTasks(text: string): number[] {
  return [...text.matchAll(DONE_LOG)].map(match => Number(match[1]))
}

export const baseName = (path: string): string => path.split('/').pop() ?? path
