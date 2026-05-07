export type SwarmTaskRecord = {
  id: string
  role: string
  status: 'todo' | 'in_progress' | 'needs_input' | 'done'
  ownerAgentId: string | null
  dependsOn: string[]
}

export function normalizeSwarmTasks(value: unknown): SwarmTaskRecord[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((task): SwarmTaskRecord[] => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return []
    const record = task as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id.trim()) return []
    if (typeof record.role !== 'string' || !record.role.trim()) return []

    return [{
      id: record.id,
      role: record.role,
      status: normalizeTaskStatus(record.status),
      ownerAgentId: typeof record.ownerAgentId === 'string' && record.ownerAgentId.trim()
        ? record.ownerAgentId
        : null,
      dependsOn: Array.isArray(record.dependsOn)
        ? record.dependsOn.filter((dependency): dependency is string => typeof dependency === 'string')
        : [],
    }]
  })
}

function normalizeTaskStatus(value: unknown): SwarmTaskRecord['status'] {
  if (value === 'in_progress' || value === 'needs_input' || value === 'done') return value
  return 'todo'
}
