import { useMemo } from 'react'

import { selectModuleEnabled } from '../../modules'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { extensionsRowBadge, unreadByExtensionsRow, type ModuleNotificationRows } from '../../utils/railBadges'
import { designSystemNewEntryCount } from '../../../../shared/design-system/arrivals'
import type { RailBadge } from './AppRail'
import { EXTENSIONS_DRAWER_ROW_IDS, isExtensionsDrawerRowId, type ExtensionsDrawerRowId } from './extensionsDrawer'
import { useExtensionsDrawerRows, type ExtensionsDrawerRowView } from './extensionsDrawerRows'
import { useDesignArrivals } from './globalSurface/design/designArrivalsStore'
import {
  doorBadgeModuleFallbackRows,
  doorBadgeSourceRows,
  useDoorBadgeContributions,
  useDoorBadgeWaitingCounts,
} from './useDoorBadges'

/**
 * Every drawer row's count, keyed by row id: the three fixed rows always
 * present, and one key per installed door (its surface id).
 */
export type ExtensionsRowBadges = Readonly<Record<ExtensionsDrawerRowId, RailBadge | null>> &
  Readonly<Partial<Record<string, RailBadge | null>>>

const NO_BADGES: Record<ExtensionsDrawerRowId, null> = Object.fromEntries(
  EXTENSIONS_DRAWER_ROW_IDS.map((row) => [row, null]),
) as Record<ExtensionsDrawerRowId, null>

// A door that names itself through its own nav-entry component may have no
// label; its count still needs a name for the badge's live region, and the
// shell's own fallback for an unlabelled door is its capitalised id.
function rowLabel(row: ExtensionsDrawerRowView): string {
  if (row.label) return row.label
  return row.surfaceId.charAt(0).toUpperCase() + row.surfaceId.slice(1)
}

/**
 * Where module news lands, from the live drawer: each installed door row with
 * the module that owns it, and the row each module's badge claimed for its
 * untargeted news. Shared by the counting below and the reading in
 * `useRailBadges`, so a row counts exactly what opening it reads.
 */
export function useModuleNotificationRows(): ModuleNotificationRows {
  const rows = useExtensionsDrawerRows()
  const doorBadges = useDoorBadgeContributions()
  return useMemo(() => {
    const doors = new Map<string, string>()
    for (const row of rows) {
      if (row.rowId && !isExtensionsDrawerRowId(row.rowId)) doors.set(row.rowId, row.moduleId)
    }
    return { doors, fallbackByModule: doorBadgeModuleFallbackRows(doorBadges) }
  }, [rows, doorBadges])
}

// The count each Extensions drawer row wears (owner, 2026-09-08: "put the
// notification on whatever row it came from"). One hook, read by the drawer
// for its rows and by the rail hook for the square's sum, so the square and
// the rows beneath it are one derivation and cannot disagree.
//
//   Design       — entries arrived in any registered bundle since that bundle
//                  was last shown, by the door's own rule, read from the
//                  arrivals the main process resolves.
//   Plugins,
//   Skills       — their unread bell rows.
//   Module doors — waiting counts from the owning module's door-badge
//                  contribution (`rowId` = the door's surface id), plus the
//                  module's own unread `notify` rows filed under the door.
//
// Reading happens elsewhere: `useRailBadges` marks a row's news read when the
// row's page is on screen, and the Design door stamps the bundle it shows. This
// hook only counts. A row whose module is off is not in the drawer, so it
// counts nothing.
export function useExtensionsRowBadges(): ExtensionsRowBadges {
  const notifications = useNotificationStore((s) => s.notifications)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const designSeen = useWorkspaceStore((s) => s.appSettings.designSystemSeen)
  const designEnabled = selectModuleEnabled(moduleOverrides, 'design')
  const designArrivals = useDesignArrivals(designEnabled)
  const doorBadges = useDoorBadgeContributions()
  const waitingByRow = useDoorBadgeWaitingCounts()
  const sourceRows = useMemo(() => doorBadgeSourceRows(doorBadges), [doorBadges])
  const moduleRows = useModuleNotificationRows()
  const rows = useExtensionsDrawerRows()

  const unread = useMemo(
    () => unreadByExtensionsRow(notifications, sourceRows, moduleRows),
    [notifications, sourceRows, moduleRows],
  )
  const labels = useMemo(() => {
    const byRow: Partial<Record<string, string>> = {}
    for (const row of rows) if (row.rowId) byRow[row.rowId] = rowLabel(row)
    return byRow
  }, [rows])
  const designArrived = useMemo(
    () =>
      designEnabled
        ? designSystemNewEntryCount({ bundles: designArrivals.bundles, seen: designSeen, now: new Date() })
        : 0,
    [designEnabled, designArrivals.bundles, designSeen],
  )

  // An installed door wears only its OWN module's waiting count: a badge
  // another module registered under the door's id is not that door's news.
  const badgeOwnerByRow = useMemo(() => new Map(doorBadges.map((badge) => [badge.rowId, badge.moduleId])), [doorBadges])

  return useMemo(() => {
    const badges: Record<string, RailBadge | null> = { ...NO_BADGES }
    for (const [rowId, label] of Object.entries(labels)) {
      // A row that is not in the drawer counts nothing, whatever its news says:
      // a count with no row to open is a count that can never be read.
      if (!label) continue
      const doorOwner = moduleRows.doors.get(rowId)
      const waiting =
        doorOwner === undefined || badgeOwnerByRow.get(rowId) === doorOwner ? (waitingByRow[rowId] ?? 0) : 0
      badges[rowId] = extensionsRowBadge({
        label,
        unread: unread[rowId] ?? [],
        waiting,
        arrived: rowId === 'design' ? designArrived : 0,
      })
    }
    return badges as ExtensionsRowBadges
  }, [labels, unread, waitingByRow, designArrived, moduleRows, badgeOwnerByRow])
}
