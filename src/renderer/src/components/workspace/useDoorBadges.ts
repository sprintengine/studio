import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { RegisteredDoorBadge } from '../../modules/renderer-host'
import { isExtensionsDrawerRowId, type ExtensionsDrawerRowId } from './extensionsDrawer'
import type { ModuleNotificationRows } from '../../utils/railBadges'

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
  // An installed module registers its badge when its renderer bundle loads,
  // which can land after first render — the same race the drawer rows bump
  // for — so the list is re-read then rather than at the next module toggle.
  const [registryGeneration, setRegistryGeneration] = useState(0)
  useEffect(() => onThirdPartyRendererModulesLoaded(() => setRegistryGeneration((n) => n + 1)), [])
  return useMemo(
    () => getRendererHost().getDoorBadges((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    // registryGeneration is the late-load signal, not an input the body reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [moduleOverrides, registryGeneration],
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

/**
 * Each module's untargeted `notify` rows, by module id, to the door row its
 * badge claimed for them: a badge whose `notificationSource` is its OWN module
 * id. The row still has to be one of that module's doors to count
 * (`extensionsRowOfNotification` checks), so a badge cannot pull news onto a
 * row it does not own.
 */
export function doorBadgeModuleFallbackRows(
  badges: readonly RegisteredDoorBadge[],
): ModuleNotificationRows['fallbackByModule'] {
  const rows: Partial<Record<string, string>> = {}
  for (const badge of badges) {
    if (badge.notificationSource !== badge.moduleId) continue
    rows[badge.moduleId] = badge.rowId
  }
  return rows
}

/** The fixed rows' source map: a bundled door's badge naming the core source its news arrives under. */
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
