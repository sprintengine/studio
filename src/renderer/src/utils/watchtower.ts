import type { SwitchboardTaskRecord } from '../../../shared/switchboard'

export function filterInboxTasks(tasks: SwitchboardTaskRecord[]): SwitchboardTaskRecord[] {
  return tasks
    .filter((record) => record.location.folderStatus === 'inbox')
    .sort(byCreatedDescending)
}

function byCreatedDescending(a: SwitchboardTaskRecord, b: SwitchboardTaskRecord): number {
  const aTime = Date.parse(a.task.createdAt) || 0
  const bTime = Date.parse(b.task.createdAt) || 0
  return bTime - aTime
}
