import { useMemo, useSyncExternalStore } from 'react'

import { getRendererHost, selectModuleEnabled } from '../../modules'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { RegisteredDoorBadge } from '../../modules/renderer-host'
import { isExtensionsDrawerRowId, type ExtensionsDrawerRowId } from './extensionsDrawer'

// Door / nav-entry waiting counts as the host registry, not a module import.
// A module contributes its own numbers through `registerDoorBadge`
// and this hook is the only reader, so the shell never has to know what a
// module counts.

function snapshotWaiting(badges: readonly RegisteredDoorBadge[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const badge of badges) counts[badge.rowId] = badge.getWaitingCount()
  return counts
}

function snapshotKey(counts: Readonly<Record<string, number>>): string {
  return Object.keys(counts)
    .sort()
    .map((rowId) => `${rowId}:${counts[rowId]}`)
    .join('|')
}

export function useDoorBadgeContributions(): readonly RegisteredDoorBadge[] {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  return useMemo(
    () => getRendererHost().getDoorBadges((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    [moduleOverrides],
  )
}

export function useDoorBadgeWaitingCounts(): Readonly<Record<string, number>> {
  const badges = useDoorBadgeContributions()
  const subscribe = useMemo(
    () => (onChange: () => void) => {
      const unsubs = badges.map((badge) => badge.subscribe(onChange))
      return () => {
        for (const unsub of unsubs) unsub()
      }
    },
    [badges],
  )
  const getSnapshot = useMemo(() => {
    let cached: { key: string; value: Readonly<Record<string, number>> } | null = null
    return () => {
      const next = snapshotWaiting(badges)
      const key = snapshotKey(next)
      if (cached && cached.key === key) return cached.value
      cached = { key, value: next }
      return next
    }
  }, [badges])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function doorBadgeSourceRows(
  badges: readonly RegisteredDoorBadge[],
): Readonly<Partial<Record<string, ExtensionsDrawerRowId>>> {
  const rows: Partial<Record<string, ExtensionsDrawerRowId>> = {}
  for (const badge of badges) {
    if (!badge.notificationSource) continue
    if (!isExtensionsDrawerRowId(badge.rowId)) continue
    rows[badge.notificationSource] = badge.rowId
  }
  return rows
}
