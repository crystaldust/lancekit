// The report body of docs/session-board-contract.md (v1), and what goes into it. Pure.

import { clip } from './status'
import type { Status } from './status'

export const CONTRACT_VERSION = 1
const TITLE_CHARS = 200
const PHASE_CHARS = 32
const MILESTONE_CHARS = 16
const MAX_MILESTONES = 64
const HOST_CHARS = 64
const CWD_CHARS = 512
const PROJECT_CHARS = 128

// The shapes ecc-progress keeps in $.state (plugins/ecc-progress/types/index.d.ts), read-only here.
export type EccMilestone = { n: string; status: string }
export type EccPrd = { title: string; milestones: EccMilestone[] }
export type EccPlan = { name: string; tasks: unknown[]; isArchived: boolean }
export type EccLive = { doneTasks: unknown[]; phase: string | null; isActive: boolean }

export type EccSummary = {
  prd: { title: string; done: number; total: number; inProgress: string[] } | null
  plan: { name: string; done: number; total: number; isArchived: boolean } | null
  phase: string | null
  isActive: boolean
}

/** The same figures ecc-progress puts on its status line; null when there is no PRD or plan. */
export function eccSummary(prd: EccPrd | null | undefined, plan: EccPlan | null | undefined, live: EccLive | null | undefined): EccSummary | null {
  const isActive = live?.isActive === true
  const prdPart = prd && prd.milestones.length > 0
    ? {
        title: clip(prd.title, TITLE_CHARS),
        done: prd.milestones.filter(m => m.status === 'complete').length,
        total: prd.milestones.length,
        inProgress: prd.milestones
          .filter(m => m.status === 'in-progress')
          .map(m => clip(m.n, MILESTONE_CHARS))
          .filter(n => n !== '')
          .slice(0, MAX_MILESTONES),
      }
    : null
  const planPart = plan && plan.tasks.length > 0
    ? {
        name: clip(plan.name, TITLE_CHARS),
        done: plan.isArchived ? plan.tasks.length : isActive ? Math.min(live?.doneTasks.length ?? 0, plan.tasks.length) : 0,
        total: plan.tasks.length,
        isArchived: plan.isArchived,
      }
    : null
  if (prdPart === null && planPart === null) return null
  return { prd: prdPart, plan: planPart, phase: isActive && live?.phase ? clip(live.phase, PHASE_CHARS) : null, isActive }
}

export type Board = { base: string; token: string }

/**
 * The board's base URL and token from the settings. The whole link board.py prints
 * (`http://host:7777/?token=…`) works as the URL; a token set on its own wins.
 */
export function parseBoardUrl(raw: string, token: string): Board | null {
  const text = raw.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const fromUrl = url.searchParams.get('token') ?? ''
  const path = url.pathname.replace(/\/+$/, '')
  return { base: `${url.protocol}//${url.host}${path}`, token: token.trim() || fromUrl }
}

export function sessionUrl(board: Board, sessionId: string): string {
  return `${board.base}/api/sessions/${encodeURIComponent(sessionId)}`
}

/** A session id the board accepts ([A-Za-z0-9._-]{1,128}); others are reduced to it. */
export function boardSessionId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128)
  return cleaned === '' ? 'session' : cleaned
}

export const iso = (ms: number) => new Date(ms).toISOString()

export function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return clip(parts[parts.length - 1] || cwd || 'unknown', PROJECT_CHARS)
}

export type Where = { host: string; cwd: string }

export function buildReport(status: Status, where: Where, ecc: EccSummary | null, now: number) {
  return {
    v: CONTRACT_VERSION,
    host: clip(where.host || 'unknown', HOST_CHARS),
    cwd: clip(where.cwd, CWD_CHARS),
    project: projectName(where.cwd),
    state: status.state,
    since: iso(Math.min(status.since, now)),
    sentAt: iso(now),
    detail: status.detail,
    lastPrompt: status.lastPrompt && { text: status.lastPrompt.text, at: iso(status.lastPrompt.at) },
    lastAnswer: status.lastAnswer && { tail: status.lastAnswer.tail, at: iso(status.lastAnswer.at) },
    ecc,
  }
}
