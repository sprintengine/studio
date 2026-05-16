export type SprintEngineTaskRecord = {
  id: string
  role: string
  status: 'todo' | 'changes_requested' | 'in_progress' | 'needs_input' | 'done'
  ownerAgentId: string | null
  dependsOn: string[]
}

export function normalizeSprintEngineTasks(value: unknown): SprintEngineTaskRecord[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((task): SprintEngineTaskRecord[] => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return []
    const record = task as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id.trim()) return []
    if (typeof record.role !== 'string' || !record.role.trim()) return []

    // Folder-store projection records carry the semantic value in `stateStatus`
    // while `status` mirrors the board column ("ready", "changes_requested",
    // etc.). Prefer `stateStatus` so command readiness checks keep the
    // semantic changes_requested status instead of flattening it to ready.
    return [{
      id: record.id,
      role: record.role,
      status: normalizeTaskStatus(record.stateStatus ?? record.status),
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
  if (value === 'changes_requested' || value === 'in_progress' || value === 'needs_input' || value === 'done') return value
  return 'todo'
}
