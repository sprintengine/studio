export const SWITCHBOARD_TASK_STATUSES = [
  'planning',
  'todo',
  'ready',
  'in_progress',
  'testing',
  'testing_in_progress',
  'review',
  'review_in_progress',
  'done',
  'canceled',
] as const

export const SWITCHBOARD_FOLDER_STATUSES = ['inbox', ...SWITCHBOARD_TASK_STATUSES] as const

export type SwitchboardTaskStatus = (typeof SWITCHBOARD_TASK_STATUSES)[number]
export type SwitchboardFolderStatus = (typeof SWITCHBOARD_FOLDER_STATUSES)[number]

export type SwitchboardAuthorType = 'user' | 'agent' | 'system'
export type SwitchboardCommentKind = 'comment' | 'status_change' | 'claim' | 'evidence' | 'import' | 'triage'
export type SwitchboardSourceType = 'manual' | 'watchtower' | 'github' | 'jira' | 'campaign' | 'sprintengine'

export type SwitchboardAuthor = {
  type: SwitchboardAuthorType
  id?: string | null
  name?: string | null
}

export type SwitchboardComment = {
  id: string
  author: SwitchboardAuthor
  kind: SwitchboardCommentKind
  body: string
  createdAt: string
}

export type SwitchboardSource = {
  type: SwitchboardSourceType
  externalId?: string | null
  externalKey?: string | null
  externalUrl?: string | null
}

export type SwitchboardClaim = {
  owner: string
  sessionId?: string | null
  claimedAt: string
}

export type SwitchboardExecutionAttempt = {
  id: string
  agentId?: string | null
  startedAt: string
  completedAt?: string | null
  summary?: string | null
  worktreePath?: string | null
  worktreeBranch?: string | null
  worktreeState?: string | null
}

export type SwitchboardExecution = {
  attempts: SwitchboardExecutionAttempt[]
  worktreePath: string | null
  worktreeBranch?: string | null
  worktreeState?: string | null
  activeExecutionId?: string | null
  activeProvider?: SwitchboardExecutionProviderKind | null
  activeSessionId: string | null
  providerRef?: SwitchboardExecutionProviderRef | null
}

export type SwitchboardEvidence = {
  summary: string
  artifacts: string[]
  commandsRun: string[]
  touchedFiles: string[]
}

export type SwitchboardTask = {
  schemaVersion: 1
  id: string
  identifier: string
  title: string
  description: string
  priority: number | null
  state: SwitchboardTaskStatus
  branchName: string | null
  url: string | null
  labels: string[]
  blockedBy: string[]
  source: SwitchboardSource
  claim: SwitchboardClaim | null
  execution: SwitchboardExecution
  evidence: SwitchboardEvidence
  comments: SwitchboardComment[]
  createdAt: string
  updatedAt: string
}

export type SwitchboardTaskLocation = {
  folderStatus: SwitchboardFolderStatus
  path: string
}

export type SwitchboardTaskRecord = {
  task: SwitchboardTask
  location: SwitchboardTaskLocation
  warnings: string[]
}

export type SwitchboardFileProblem = {
  path: string
  folderStatus: SwitchboardFolderStatus
  message: string
}

export type SwitchboardLockStatus = {
  folderStatus: SwitchboardFolderStatus
  path: string
  locked: boolean
  stale: boolean
  owner: string | null
  sessionId: string | null
  createdAt: string | null
  heartbeatAt: string | null
  ageSeconds: number | null
}

export type SwitchboardReadAllResult = {
  ok: true
  workspaceRoot: string
  switchboardRoot: string
  tasks: SwitchboardTaskRecord[]
  problems: SwitchboardFileProblem[]
  locks?: SwitchboardLockStatus[]
}

export type SwitchboardInitResult = {
  ok: true
  workspaceRoot: string
  switchboardRoot: string
  folders: string[]
}

export type SwitchboardMutationResult =
  | { ok: true; record: SwitchboardTaskRecord }
  | { ok: false; message: string }

export type SwitchboardReadResult =
  | SwitchboardReadAllResult
  | { ok: false; message: string }

export type SwitchboardInitApiResult =
  | SwitchboardInitResult
  | { ok: false; message: string }

export type WatchtowerRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled'

export type WatchtowerRunAgent = {
  agentId: string
  specialistId: string | null
  status: WatchtowerRunStatus
  outputDir: string
  reportPath: string | null
  executionId?: string | null
  errorMessage?: string | null
  taskIds?: string[]
}

export type WatchtowerRunCounts = {
  valid: number
  invalid: number
  ingested: number
}

export type WatchtowerRun = {
  schemaVersion: 1
  runId: string
  status: WatchtowerRunStatus
  createdAt: string
  completedAt: string | null
  workspaceRoot: string
  preset: string
  agents: WatchtowerRunAgent[]
  counts: WatchtowerRunCounts
}

export type WatchtowerRunCreateInput = {
  workspaceRoot: string
  preset: string
  status?: WatchtowerRunStatus
  agents?: WatchtowerRunAgent[]
}

export type WatchtowerRunResult =
  | { ok: true; run: WatchtowerRun }
  | { ok: false; message: string }

export type WatchtowerRunAgentStatusInput = {
  workspaceRoot: string
  runId: string
  agentId: string
  status: WatchtowerRunStatus
}

export type WatchtowerRunListResult =
  | { ok: true; runs: WatchtowerRun[]; problems?: Array<{ runId: string; path: string; message: string }> }
  | { ok: false; message: string }

export type SwitchboardImportProvider = 'github' | 'jira'

export type SwitchboardImportItem = {
  provider: SwitchboardImportProvider
  externalId?: string | null
  externalKey?: string | null
  externalUrl?: string | null
  identifier?: string | null
  title: string
  description?: string
  labels?: string[]
  priority?: number | null
  updatedAt?: string | null
}

export type SwitchboardImportItemResult = {
  provider: SwitchboardImportProvider
  externalKey?: string | null
  externalUrl?: string | null
  status: 'created' | 'updated' | 'skipped' | 'error'
  taskId?: string | null
  message?: string | null
}

export type SwitchboardImportSummary = {
  created: number
  updated: number
  skipped: number
  errors: number
}

export type SwitchboardImportResult =
  | {
      ok: true
      provider: SwitchboardImportProvider
      summary: SwitchboardImportSummary
      items: SwitchboardImportItemResult[]
      unavailable?: false
    }
  | { ok: false; provider: SwitchboardImportProvider; message: string; unavailable?: boolean }

export type SwitchboardCreateTaskInput = {
  workspaceRoot: string
  origin: 'watchtower' | 'board'
  title: string
  description?: string
  identifier?: string
  priority?: number | null
  labels?: string[]
  source?: Partial<SwitchboardSource>
  comments?: SwitchboardComment[]
}

export type SwitchboardUpdateTaskInput = {
  workspaceRoot: string
  id: string
  updates: Partial<Omit<SwitchboardTask, 'schemaVersion' | 'id' | 'createdAt' | 'updatedAt'>>
}

export type SwitchboardMoveTaskInput = {
  workspaceRoot: string
  id: string
  to: SwitchboardTaskStatus
}

export type SwitchboardPromoteInboxTaskInput = {
  workspaceRoot: string
  id: string
}

export type SwitchboardCancelTaskInput = {
  workspaceRoot: string
  id: string
}

export type SwitchboardAddCommentInput = {
  workspaceRoot: string
  id: string
  body: string
  author?: SwitchboardAuthor
  kind?: SwitchboardCommentKind
}

export type SwitchboardClaimTaskInput = {
  workspaceRoot: string
  from: 'ready' | 'testing' | 'review'
  owner: string
  sessionId?: string | null
}

export type SwitchboardPublishTaskInput = {
  workspaceRoot: string
  id: string
  to?: 'testing' | 'review' | 'done'
  summary?: string
  artifacts?: string[]
  commandsRun?: string[]
  touchedFiles?: string[]
  comment?: string
}

export type SwitchboardClaimTaskResult =
  | { ok: true; record: SwitchboardTaskRecord }
  | { ok: false; message: string }

export type SwitchboardRecoverLockInput = {
  workspaceRoot: string
  status: SwitchboardFolderStatus
}

export type SwitchboardRecoverLockResult =
  | { ok: true; recovered: boolean; lock: SwitchboardLockStatus }
  | { ok: false; message: string }

export type SwitchboardRequeueTaskInput = {
  workspaceRoot: string
  id: string
  reason?: string
}

export type SwitchboardStopExecutionInput = {
  workspaceRoot: string
  executionId: string
  reason?: string
}

export type SwitchboardRunnerQueue = 'ready' | 'testing' | 'review'
export type SwitchboardExecutionProviderKind = 'local-process' | 'codex-app-server'
export type SwitchboardExecutionStatus = 'active' | 'missing' | 'stale' | 'abandoned' | 'completed' | 'stopped'
export type SwitchboardExecutionProviderRef = Record<string, string | number | boolean | null>

export type SwitchboardRunnerStartInput = {
  workspaceRoot: string
  workspaceId?: string
  queues?: SwitchboardRunnerQueue[]
  maxConcurrency?: number
  cli?: 'codex' | 'claude'
  provider?: SwitchboardExecutionProviderKind
}

export type SwitchboardRunnerExecution = {
  executionId: string
  taskId: string
  role: string
  claimedFrom: SwitchboardRunnerQueue
  claimedStatus: 'in_progress' | 'testing_in_progress' | 'review_in_progress'
  provider: SwitchboardExecutionProviderKind
  providerRef: SwitchboardExecutionProviderRef
  startedAt: string
  lastSeenAt: string
  status?: SwitchboardExecutionStatus
}

export type SwitchboardRunnerState = {
  ok: true
  workspaceRoot: string | null
  enabled: boolean
  running: boolean
  paused: boolean
  provider: SwitchboardExecutionProviderKind
  cli: 'codex' | 'claude'
  maxConcurrency: number
  queues: SwitchboardRunnerQueue[]
  activeExecutions: SwitchboardRunnerExecution[]
  lastError: string | null
  updatedAt: string | null
}

export type SwitchboardRunnerResult =
  | SwitchboardRunnerState
  | { ok: false; message: string }

export type SwitchboardStopExecutionResult =
  | {
      ok: true
      executionId: string
      taskId?: string | null
      status: SwitchboardExecutionStatus
      terminated: boolean
      worktreeState?: string | null
    }
  | { ok: false; message: string }

export const SWITCHBOARD_STATUS_LABELS: Record<SwitchboardFolderStatus, string> = {
  inbox: 'Inbox',
  planning: 'Planning',
  todo: 'Todo',
  ready: 'Ready',
  in_progress: 'In Progress',
  testing: 'Testing',
  testing_in_progress: 'Testing In Progress',
  review: 'Review',
  review_in_progress: 'Review In Progress',
  done: 'Done',
  canceled: 'Canceled',
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function isSwitchboardTaskStatus(value: unknown): value is SwitchboardTaskStatus {
  return typeof value === 'string' && (SWITCHBOARD_TASK_STATUSES as readonly string[]).includes(value)
}

export function isSwitchboardFolderStatus(value: unknown): value is SwitchboardFolderStatus {
  return typeof value === 'string' && (SWITCHBOARD_FOLDER_STATUSES as readonly string[]).includes(value)
}

export function isSwitchboardTaskId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function getSwitchboardTaskFolder(status: SwitchboardTaskStatus): string {
  return `tasks/${status}`
}

export function getSwitchboardFolderRelativePath(status: SwitchboardFolderStatus): string {
  return status === 'inbox' ? 'inbox' : getSwitchboardTaskFolder(status)
}

export function getSwitchboardMoveTarget(
  from: SwitchboardFolderStatus,
  to: SwitchboardTaskStatus
): SwitchboardTaskStatus | null {
  if (to === 'canceled') return 'canceled'
  if (from === 'inbox') return to === 'todo' ? 'todo' : null
  if (from === to) return to

  const legalTransitions: Record<SwitchboardTaskStatus, SwitchboardTaskStatus[]> = {
    planning: ['todo'],
    todo: ['planning', 'ready'],
    ready: ['todo', 'in_progress'],
    in_progress: ['ready', 'testing'],
    testing: ['in_progress', 'testing_in_progress'],
    testing_in_progress: ['testing', 'review'],
    review: ['testing', 'review_in_progress'],
    review_in_progress: ['review', 'done'],
    done: ['review'],
    canceled: [],
  }

  return legalTransitions[from]?.includes(to) ? to : null
}

export function validateSwitchboardTaskShape(task: unknown): string[] {
  const errors: string[] = []
  if (!task || typeof task !== 'object' || Array.isArray(task)) return ['Task file must contain a JSON object.']
  const record = task as Partial<SwitchboardTask>

  if (record.schemaVersion !== 1) errors.push('schemaVersion must be 1.')
  if (!isSwitchboardTaskId(record.id)) errors.push('id must be a UUID.')
  if (typeof record.identifier !== 'string' || !record.identifier.trim()) errors.push('identifier is required.')
  if (typeof record.title !== 'string' || !record.title.trim()) errors.push('title is required.')
  if (typeof record.description !== 'string') errors.push('description must be a string.')
  if (record.priority !== null && typeof record.priority !== 'number') errors.push('priority must be a number or null.')
  if (!isSwitchboardTaskStatus(record.state)) errors.push('state must be a valid task status.')
  if (record.branchName !== null && typeof record.branchName !== 'string') errors.push('branchName must be a string or null.')
  if (record.url !== null && typeof record.url !== 'string') errors.push('url must be a string or null.')
  if (!Array.isArray(record.labels) || !record.labels.every((label) => typeof label === 'string')) {
    errors.push('labels must be a string array.')
  }
  if (!Array.isArray(record.blockedBy) || !record.blockedBy.every((blocker) => typeof blocker === 'string')) {
    errors.push('blockedBy must be a string array.')
  }
  if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) {
    errors.push('source must be an object.')
  } else if (
    typeof record.source.type !== 'string'
    || !(['manual', 'watchtower', 'github', 'jira', 'campaign', 'sprintengine'] as string[]).includes(record.source.type)
  ) {
    errors.push('source.type must be valid.')
  }
  if (!record.execution || typeof record.execution !== 'object' || Array.isArray(record.execution)) {
    errors.push('execution must be an object.')
  } else {
    if (!Array.isArray(record.execution.attempts)) errors.push('execution.attempts must be an array.')
    if (record.execution.worktreePath !== null && typeof record.execution.worktreePath !== 'string') {
      errors.push('execution.worktreePath must be a string or null.')
    }
    if (record.execution.worktreeBranch !== undefined && record.execution.worktreeBranch !== null && typeof record.execution.worktreeBranch !== 'string') {
      errors.push('execution.worktreeBranch must be a string or null.')
    }
    if (record.execution.worktreeState !== undefined && record.execution.worktreeState !== null && typeof record.execution.worktreeState !== 'string') {
      errors.push('execution.worktreeState must be a string or null.')
    }
    if (record.execution.activeSessionId !== null && typeof record.execution.activeSessionId !== 'string') {
      errors.push('execution.activeSessionId must be a string or null.')
    }
  }
  if (!record.evidence || typeof record.evidence !== 'object' || Array.isArray(record.evidence)) {
    errors.push('evidence must be an object.')
  } else {
    if (typeof record.evidence.summary !== 'string') errors.push('evidence.summary must be a string.')
    if (!Array.isArray(record.evidence.artifacts) || !record.evidence.artifacts.every((item) => typeof item === 'string')) {
      errors.push('evidence.artifacts must be a string array.')
    }
    if (!Array.isArray(record.evidence.commandsRun) || !record.evidence.commandsRun.every((item) => typeof item === 'string')) {
      errors.push('evidence.commandsRun must be a string array.')
    }
    if (!Array.isArray(record.evidence.touchedFiles) || !record.evidence.touchedFiles.every((item) => typeof item === 'string')) {
      errors.push('evidence.touchedFiles must be a string array.')
    }
  }
  if (!Array.isArray(record.comments)) {
    errors.push('comments must be an array.')
  } else {
    for (const comment of record.comments) {
      if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
        errors.push('comments must contain objects.')
        break
      }
      if (typeof comment.id !== 'string' || !comment.id) errors.push('comment.id is required.')
      if (typeof comment.body !== 'string') errors.push('comment.body must be a string.')
      if (typeof comment.createdAt !== 'string' || !comment.createdAt) errors.push('comment.createdAt is required.')
      if (!(['comment', 'status_change', 'claim', 'evidence', 'import'] as string[]).includes(comment.kind)) {
        errors.push('comment.kind must be valid.')
      }
      if (!comment.author || typeof comment.author !== 'object' || Array.isArray(comment.author)) {
        errors.push('comment.author must be an object.')
      } else if (!(['user', 'agent', 'system'] as string[]).includes(comment.author.type)) {
        errors.push('comment.author.type must be valid.')
      }
    }
  }
  if (typeof record.createdAt !== 'string' || !record.createdAt) errors.push('createdAt is required.')
  if (typeof record.updatedAt !== 'string' || !record.updatedAt) errors.push('updatedAt is required.')

  return errors
}
