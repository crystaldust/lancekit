import type { Milestone, MilestoneStatus, PlanTask } from '../types'

const SEPARATOR = /^\|[\s:|-]+\|?$/
const NAME_HEADER = /^(phase|milestone)$/i
const TASK_HEADING = /^###\s+Task\s+(\d+)\s*[:：.\-—]?\s*(.*)$/gim
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
    return rowsAfter(lines, i + 2).map((line, index) => {
      const cells = cellsOf(line)
      return {
        n: numberAt >= 0 ? cells[numberAt] ?? String(index + 1) : String(index + 1),
        name: cells[nameAt] ?? '',
        status: normalizeStatus(cells[statusAt] ?? ''),
      }
    })
  }
  return []
}

export function parseTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)
  return heading?.[1]?.trim() || fallback
}

/** Reads the `### Task N: name` headings of a /prp-plan plan. */
export function parseTasks(markdown: string): PlanTask[] {
  return [...markdown.matchAll(TASK_HEADING)].map(match => ({
    n: Number(match[1]),
    name: (match[2] ?? '').trim(),
  }))
}

/** Reads the `[done] Task N` lines /prp-implement logs as it goes. */
export function parseDoneTasks(text: string): number[] {
  return [...text.matchAll(DONE_LOG)].map(match => Number(match[1]))
}

export const baseName = (path: string): string => path.split('/').pop() ?? path
