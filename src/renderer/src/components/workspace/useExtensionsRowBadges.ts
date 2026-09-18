import { useMemo } from 'react'

import { selectModuleEnabled } from '../../modules'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { extensionsRowBadge, unreadByExtensionsRow } from '../../utils/railBadges'
import { designSystemNewEntryCount } from '../../../../shared/design-system/arrivals'
import type { RailBadge } from './AppRail'
import { EXTENSIONS_DRAWER_ROW_IDS, type ExtensionsDrawerRowId } from './extensionsDrawer'
import { useExtensionsDrawerRows } from './extensionsDrawerRows'
import { useDesignArrivals } from './globalSurface/design/designArrivalsStore'
import { doorBadgeSourceRows, useDoorBadgeContributions, useDoorBadgeWaitingCounts } from './useDoorBadges'

export type ExtensionsRowBadges = Readonly<Record<ExtensionsDrawerRowId, RailBadge | null>>

const NO_BADGES: ExtensionsRowBadges = Object.fromEntries(
  EXTENSIONS_DRAWER_ROW_IDS.map((row) => [row, null]),
) as Record<ExtensionsDrawerRowId, null>

// The count each Extensions drawer row wears (owner, 2026-09-08: "put the
// notification on whatever row it came from"). One hook, read by the drawer
// for its rows and by the rail hook for the square's sum, so the square and
// the rows beneath it are one derivation and cannot disagree.
//
//   Design       — entries arrived in any registered bundle since that bundle
//                  was last shown, by the door's own rule, read from the
//                  arrivals the main process resolves.
//   Plugins,
//   Skills,
//   Agent CLIs   — their unread bell rows.
//   Module doors — waiting counts from the owning module's door-badge
//                  contribution, plus unread bell rows.
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
  const rows = useExtensionsDrawerRows()

  const unread = useMemo(() => unreadByExtensionsRow(notifications, sourceRows), [notifications, sourceRows])
  const labels = useMemo(() => {
    const byRow: Partial<Record<ExtensionsDrawerRowId, string>> = {}
    for (const row of rows) if (row.rowId && row.label) byRow[row.rowId] = row.label
    return byRow
  }, [rows])
  const designArrived = useMemo(
    () =>
      designEnabled
        ? designSystemNewEntryCount({ bundles: designArrivals.bundles, seen: designSeen, now: new Date() })
        : 0,
    [designEnabled, designArrivals.bundles, designSeen],
  )

  return useMemo(() => {
    const badges: Record<ExtensionsDrawerRowId, RailBadge | null> = { ...NO_BADGES }
    for (const rowId of EXTENSIONS_DRAWER_ROW_IDS) {
      // A row that is not in the drawer counts nothing, whatever its news says:
      // a count with no row to open is a count that can never be read.
      const label = labels[rowId]
      if (!label) continue
      badges[rowId] = extensionsRowBadge({
        label,
        unread: unread[rowId],
        waiting: waitingByRow[rowId] ?? 0,
        arrived: rowId === 'design' ? designArrived : 0,
      })
    }
    return badges
  }, [labels, unread, waitingByRow, designArrived])
}
