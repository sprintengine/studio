// The schedules a person used last, newest first, for `/schedule` to offer
// before anything is typed. Per window's storage and best-effort: a private
// window, blocked storage or a corrupt entry reads as no recents, never as an
// error.

import { parseCronSchedule } from '../../../../../../shared/cron'

const STORAGE_KEY = 'sprintengine.scheduledAgents.recentSchedules'
const MAX_RECENTS = 5

export function readRecentSchedules(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && parseCronSchedule(entry).ok)
  } catch {
    return []
  }
}

export function rememberSchedule(cron: string): void {
  const trimmed = cron.trim()
  if (!parseCronSchedule(trimmed).ok) return
  try {
    const next = [trimmed, ...readRecentSchedules().filter((entry) => entry !== trimmed)].slice(0, MAX_RECENTS)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage refused: the schedule is saved either way; only the shortcut is lost.
  }
}
