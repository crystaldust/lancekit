export type MilestoneStatus = 'pending' | 'in-progress' | 'complete' | 'unknown'
export type Milestone = { n: string; name: string; status: MilestoneStatus }
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
