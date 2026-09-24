import type { LifecycleState } from '../ui'
import type { WorktreePoolSlotView, WorktreePoolSnapshot } from '../../../../shared/electron-api'

/**
 * What the Worktree manager's Pool section says about a pool and its slots.
 * Pure, so the wording is tested without a window.
 */

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatAgo(at: number | null, now: number): string | null {
  if (!at) return null
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

const HELD_REASON: Record<NonNullable<WorktreePoolSlotView['held']>['reason'], string> = {
  dirty: 'uncommitted changes',
  operation: 'an operation in progress',
  'unexpected-head': 'moved off its base',
  recovery: 'needs checking after a restart',
  error: 'a git step failed',
}

/** The one glyph a slot earns, if any: work in flight, a person needed, or a failed install. */
export function slotGlyph(slot: WorktreePoolSlotView): { state: LifecycleState; label: string; live: boolean } | null {
  if (slot.state === 'held') return { state: 'needs_input', label: 'Held', live: false }
  if (slot.state === 'warm' && slot.depsState === 'failed') {
    return { state: 'failed', label: 'Dependencies failed to install', live: false }
  }
  if (slot.state === 'warm' || slot.state === 'leased') return null
  return { state: 'in_progress', label: slotStateLabel(slot), live: true }
}

export function slotStateLabel(slot: WorktreePoolSlotView): string {
  switch (slot.state) {
    case 'creating':
      return 'creating'
    case 'refreshing':
      return 'refreshing'
    case 'installing':
      return `installing (${slot.installCommand ?? 'dependencies'})`
    case 'warm':
      return 'warm'
    case 'leasing':
      return 'leasing'
    case 'leased':
      return slot.lease?.branch ?? 'leased'
    case 'returning':
      return 'returning'
    case 'held':
      return `held: ${HELD_REASON[slot.held?.reason ?? 'error']}`
    case 'evicting':
      return 'removing'
  }
}

/** The one muted line under a slot's name. */
export function slotMeta(slot: WorktreePoolSlotView, now: number, ownerName: string | null): string {
  const parts: string[] = []
  if (slot.state === 'leased') {
    parts.push(ownerName ? `leased to ${ownerName}` : 'leased')
  } else if (slot.state === 'held') {
    const held = slot.held
    parts.push(slotStateLabel(slot))
    if (held?.changedPaths) parts.push(`${held.changedPaths} changed`)
    if (held?.branch) parts.push(held.branch)
  } else {
    parts.push(slotStateLabel(slot))
  }
  if (slot.state === 'warm' || slot.state === 'leased') {
    if (slot.depsState === 'failed') parts.push(`${slot.installCommand ?? 'install'} failed`)
    const refreshed = formatAgo(slot.refreshedAt, now)
    if (refreshed && slot.state === 'warm') parts.push(`refreshed ${refreshed}`)
  }
  const size = formatBytes(slot.sizeBytes)
  if (size) parts.push(size)
  return parts.join(' · ')
}

/** "2 warm · 1 leased · 1 held" — only the states that have slots in them. */
export function poolSummary(snapshot: WorktreePoolSnapshot): string {
  const count = (predicate: (slot: WorktreePoolSlotView) => boolean) => snapshot.slots.filter(predicate).length
  const warm = count((slot) => slot.state === 'warm')
  const leased = count((slot) => slot.state === 'leased' || slot.state === 'leasing')
  const held = count((slot) => slot.state === 'held')
  const busy = count((slot) => !['warm', 'leased', 'leasing', 'held'].includes(slot.state))
  const parts = [
    warm ? `${warm} warm` : null,
    busy ? `${busy} preparing` : null,
    leased ? `${leased} leased` : null,
    held ? `${held} held` : null,
  ].filter(Boolean)
  if (snapshot.heldByOtherInstance) parts.unshift('in use by another Studio')
  if (snapshot.disabled) parts.unshift('off for this repository')
  return parts.join(' · ') || 'empty'
}
