export type MilestoneStatus = 'pending' | 'in-progress' | 'complete' | 'unknown'
/** `plans`: the `.plan.md` targets the row's plan cell links, as written (relative to the PRD). */
export type Milestone = { n: string; name: string; status: MilestoneStatus; plans: string[] }
export type PrdProgress = { file: string; title: string; milestones: Milestone[] }
export type PlanTask = { n: number; name: string }
export type PlanProgress = {
  file: string
  name: string
  tasks: PlanTask[]
  isArchived: boolean
}
export type LiveProgress = {
  planPath: string | null
  doneTasks: number[]
  currentTask: number | null
  phase: string | null
  isActive: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'ecc-progress': {
      prd: PrdProgress | null
      plan: PlanProgress | null
      live: LiveProgress
    }
  }
}
