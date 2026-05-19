import type { Tone } from '../../ui'
import type {
  MultiloopMilestone,
  MultiloopMilestoneReviewVerdict,
  MultiloopMilestoneStatus,
  MultiloopStateDisplayError,
  MultiloopTask,
  MultiloopTaskStatus,
  SprintEngineCliPermissionPreset,
  SprintEngineRole,
  SprintEngineState,
} from '../../../types/workspace'
import type { MultiloopRole } from '../../../specialists/specialistActions'
import type { MultiloopExecutionReadiness } from '../../../utils/multiloop'

export type ReadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: MultiloopStateDisplayError }

export type RoleLaunchState =
  | { status: 'idle' }
  | { status: 'loading'; role: MultiloopRole }
  | { status: 'error'; role: MultiloopRole; message: string }

export type LinkedExecutionReadState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'error'; path: string; message: string }

type TaskGroupKey = MultiloopTaskStatus

type TaskGroup = {
  key: TaskGroupKey
  label: string
  tone: Tone
}

export const TASK_GROUPS: TaskGroup[] = [
  { key: 'in_progress', label: 'In progress', tone: 'accent' },
  { key: 'ready', label: 'Ready', tone: 'good' },
  { key: 'needs_input', label: 'Needs input', tone: 'warn' },
  { key: 'blocked', label: 'Blocked', tone: 'warn' },
  { key: 'todo', label: 'Todo', tone: 'neutral' },
  { key: 'done', label: 'Done', tone: 'neutral' },
]

export const milestoneStatusLabels: Record<MultiloopMilestoneStatus, string> = {
  accepted: 'Accepted',
  active: 'Active',
  blocked: 'Blocked',
  planned: 'Planned',
}

export const milestoneStatusTone: Record<MultiloopMilestoneStatus, Tone> = {
  accepted: 'good',
  active: 'accent',
  blocked: 'warn',
  planned: 'neutral',
}

export const taskStatusLabels: Record<MultiloopTaskStatus, string> = {
  blocked: 'Blocked',
  done: 'Done',
  in_progress: 'In progress',
  needs_input: 'Needs input',
  ready: 'Ready',
  todo: 'Todo',
}

export const taskStatusTone: Record<MultiloopTaskStatus, Tone> = {
  blocked: 'warn',
  done: 'good',
  in_progress: 'accent',
  needs_input: 'warn',
  ready: 'good',
  todo: 'neutral',
}

export const verdictTone: Record<MultiloopMilestoneReviewVerdict['verdict'], Tone> = {
  accepted: 'good',
  needs_follow_up: 'warn',
  blocked: 'error',
  revise_scope: 'accent',
}

export const multiloopCliPermissionOptions: Array<{
  value: SprintEngineCliPermissionPreset
  label: string
  title: string
}> = [
  { value: 'default', label: 'Default permissions', title: 'Use the CLI default permission behavior.' },
  { value: 'auto_workspace', label: 'Auto in workspace', title: 'Reduce prompts while keeping workspace-scoped guardrails where the CLI supports them.' },
  { value: 'bypass_all', label: 'Bypass permissions', title: 'Skip CLI permission prompts. Use only in repos and environments you trust.' },
]

export const TERMINAL_GROUPS: Array<{ label: string; roles: MultiloopRole[] }> = [
  { label: 'Coordinator', roles: ['coordinator'] },
  { label: 'Workers', roles: ['architect', 'developer', 'frontend'] },
  { label: 'Reviewers', roles: ['product', 'tester', 'security', 'code_reviewer', 'performance'] },
]

export type LinkedSprintEngineRole = Extract<SprintEngineRole, MultiloopRole>

export function hasEvidence(task: MultiloopTask): boolean {
  return Boolean(
    task.evidence.summary.trim()
    || task.evidence.touchedFiles.length
    || task.evidence.commandsRan.length
    || task.evidence.results.length
  )
}

export function formatCount(count: number, noun: string): string {
  return String(count) + ' ' + noun + (count === 1 ? '' : 's')
}

export function formatDate(value: string | null): string {
  if (!value) return 'No timestamp'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function isModernVerdict(
  verdict: MultiloopMilestone['reviewVerdicts'][number]
): verdict is MultiloopMilestoneReviewVerdict {
  return verdict.role !== 'legacy'
}

export function verdictTitle(verdict: MultiloopMilestone['reviewVerdicts'][number]): string {
  return isModernVerdict(verdict) ? verdict.verdict.replace(/_/g, ' ') : 'Legacy verdict'
}

export function toProjectRelativePath(path: string | null | undefined, workspaceRoot: string | null | undefined): string {
  if (!path) return 'No state path recorded'
  if (!workspaceRoot) return path
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/')
  const normalizedPath = path.replace(/\\/g, '/')
  if (normalizedPath === normalizedRoot) return '.'
  if (normalizedPath.startsWith(normalizedRoot + '/')) return normalizedPath.slice(normalizedRoot.length + 1)
  return path
}

export function isSprintEngineRole(role: MultiloopRole): role is LinkedSprintEngineRole {
  return role !== 'coordinator'
}

export function getLinkedSprintEngineAgentId(role: LinkedSprintEngineRole, linkedState: SprintEngineState | null): string {
  if (!linkedState) return role
  const agentEntry = Object.entries(linkedState.sprintEngineAgents).find(([, candidate]) => candidate.role === role)
  return agentEntry?.[0] ?? role
}

export function readinessLabel(readiness: MultiloopExecutionReadiness): string {
  switch (readiness) {
    case 'ready':
      return 'Ready'
    case 'blocked':
      return 'Blocked'
    case 'needs_input':
      return 'Needs input'
    case 'all_done':
      return 'All done'
    case 'loading_execution':
      return 'Sprint Engine loading'
    case 'execution_unavailable':
      return 'Execution unavailable'
    case 'no_tasks':
      return 'Sprint Engine no tasks'
    case 'multiloop_no_tasks':
      return 'Multiloop no tasks'
    case 'no_active_milestone':
      return 'No active milestone'
  }
}

export function readinessTone(readiness: MultiloopExecutionReadiness): Tone {
  if (readiness === 'ready' || readiness === 'all_done') return 'good'
  if (readiness === 'blocked' || readiness === 'needs_input') return 'warn'
  if (readiness === 'execution_unavailable') return 'error'
  return 'neutral'
}

export function getOwnershipLabel(milestone: MultiloopMilestone | null, linkedExecutionReadState: LinkedExecutionReadState): string {
  if (!milestone?.sprintEngine) return 'Multiloop'
  if (linkedExecutionReadState.status === 'loading') return 'Sprint Engine (loading)'
  if (linkedExecutionReadState.status === 'error') return 'Sprint Engine (unavailable)'
  return 'Sprint Engine'
}

export function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-[11px] text-[color:var(--text-muted)]">{title}</div>
      {items.length === 0 ? (
        <p className="mt-1 text-[12px] text-[color:var(--text-muted)]">None recorded.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((item) => (
            <li key={item} className="flex gap-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
              <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[color:var(--accent-primary)]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
