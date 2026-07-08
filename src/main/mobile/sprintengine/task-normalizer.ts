export type SprintEngineTaskRecord = {
  id: string
  role: string
  status: 'todo' | 'in_progress' | 'review' | 'needs_input' | 'done' | 'canceled'
  ownerAgentId: string | null
  dependsOn: string[]
}

// The one status-field precedence the mobile snapshot and the command-readiness
// reader must agree on, so they can never drift. Folder-store projection records
// carry the semantic value in `stateStatus` while `status` mirrors the board
// column ("ready", "review", etc.); run.yaml records carry the semantic value in
// `status` and have no `stateStatus`. So the semantic status source is
// `stateStatus ?? status`, and the board lane is `boardColumn`. This shares the
// *field selection* only — each caller normalizes the sources against its own
// status vocabulary (the snapshot keeps the wide board-aware union; command
// readiness keeps the narrow semantic union that collapses board-only values to
// `todo`), so neither caller's behaviour changes.
export type TaskStatusSources = {
  status: unknown
  boardColumn: unknown
}

export function selectTaskStatusSources(record: Record<string, unknown>): TaskStatusSources {
  return {
    status: record.stateStatus ?? record.status,
    boardColumn: record.boardColumn,
  }
}

export function normalizeSprintEngineTasks(value: unknown): SprintEngineTaskRecord[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((task): SprintEngineTaskRecord[] => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return []
    const record = task as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id.trim()) return []
    if (typeof record.role !== 'string' || !record.role.trim()) return []

    // Command readiness only needs the semantic status, not the board lane
    // (folder-store records mirror the board column into `status`).
    return [{
      id: record.id,
      role: record.role,
      status: normalizeTaskStatus(selectTaskStatusSources(record).status),
      ownerAgentId: typeof record.ownerAgentId === 'string' && record.ownerAgentId.trim()
        ? record.ownerAgentId
        : null,
      dependsOn: Array.isArray(record.dependsOn)
        ? record.dependsOn.filter((dependency): dependency is string => typeof dependency === 'string')
        : [],
    }]
  })
}

function normalizeTaskStatus(value: unknown): SprintEngineTaskRecord['status'] {
  if (value === 'in_progress' || value === 'review' || value === 'needs_input' || value === 'done' || value === 'canceled') return value
  return 'todo'
}
