import { useEffect, useMemo } from 'react'

import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace } from '../../types/workspace'
import {
  AUTOMATIONS_NOTIFICATION_SOURCES,
  automationsRailBadge,
  extensionsRailBadge,
  extensionsRowOfNotification,
  homeRailBadge,
  unreadNotificationsFrom,
  unseenCardCount,
} from '../../utils/railBadges'
import type { RailBadges } from './AppRail'
import { openExtensionsDrawerRow } from './extensionsDrawer'
import { useSurfaceView } from './surfaceView'
import { useExtensionsRowBadges } from './useExtensionsRowBadges'
import type { WorkspaceActivity } from './workspaceManagerHelpers'

// The rail's three badges, and what clears them. One hook rather than three
// because the clearing IS the reading: opening a place marks everything its
// count was counting as seen, and the count that comes back on the next
// render is what is still waiting on the person.
//
//   Home         — chats blocked on a prompt, crashed, or finished while you
//                  were away (the sidebar's own unseen-done mark, reported up),
//                  minus the chat on screen. Cleared per chat, by opening it —
//                  the sidebar already owns that, so nothing here writes.
//   Automations  — unread bell rows from the automations source. Cleared by
//                  opening the Automations door.
//   Extensions   — the sum of its drawer rows (`useExtensionsRowBadges`), plus
//                  the hosted cards published since the home was last open.
//                  Opening the SECTION reads nothing (owner, 2026-09-08): a row
//                  reads its own news when its page is on screen — that is what
//                  this hook writes — and the home stamps the cards itself as
//                  it mounts, marking the new ones on the way. A run waiting on
//                  an answer stays counted until it is answered.
//
// Nothing here hides a count while its place is on screen: the reading lands a
// frame after the page does, and a count that was already showing going out one
// frame later is not a flash. Forcing it to zero in the same render used to be
// how the section read its rows, and that is the behaviour being retired.
export function useRailBadges(input: {
  workspaces: readonly Workspace[]
  activityByWorkspaceId: Readonly<Record<string, WorkspaceActivity>>
  unseenDoneIds: ReadonlySet<string>
  /** The chat actually on screen, or null while a door holds the card region. */
  onScreenWorkspaceId: string | null
  activeGlobalSurface: string | null
}): RailBadges {
  const { workspaces, activityByWorkspaceId, unseenDoneIds, onScreenWorkspaceId, activeGlobalSurface } = input

  const notifications = useNotificationStore((s) => s.notifications)
  const sectionSeenAt = useNotificationStore((s) => s.sectionSeenAt)
  const markReadBySources = useNotificationStore((s) => s.markReadBySources)
  const markReadWhere = useNotificationStore((s) => s.markReadWhere)
  const markSectionSeen = useNotificationStore((s) => s.markSectionSeen)
  const cards = useWorkspaceStore((s) => s.cards)
  const cardFeedStatus = useWorkspaceStore((s) => s.cardFeedStatus)
  const rowBadges = useExtensionsRowBadges()

  const automationsOpen = activeGlobalSurface === 'automations'
  // The drawer row whose page is on screen — for the three rows that are views
  // of one surface, the view it stands on, so opening Plugins reads Plugins
  // and not the Skills news beside it.
  const activeView = useSurfaceView(activeGlobalSurface ?? '')
  const openRow = openExtensionsDrawerRow(activeGlobalSurface, activeView)

  const unreadAutomations = useMemo(
    () => unreadNotificationsFrom(notifications, AUTOMATIONS_NOTIFICATION_SOURCES),
    [notifications],
  )
  const extensionsSeenAt = sectionSeenAt.extensions
  const unseenCards = useMemo(() => unseenCardCount(cards, extensionsSeenAt), [cards, extensionsSeenAt])
  const openRowHasUnread = useMemo(
    () =>
      openRow !== null &&
      notifications.some((notification) => !notification.read && extensionsRowOfNotification(notification) === openRow),
    [notifications, openRow],
  )

  // Reading. The Automations door reads its rows; an open drawer row reads its
  // own — and keeps doing so while it is open, so a push that lands mid-visit
  // is seen rather than badged behind the person.
  useEffect(() => {
    if (automationsOpen && unreadAutomations.length > 0) markReadBySources(AUTOMATIONS_NOTIFICATION_SOURCES)
  }, [automationsOpen, unreadAutomations, markReadBySources])
  useEffect(() => {
    if (openRow === null || !openRowHasUnread) return
    markReadWhere((notification) => extensionsRowOfNotification(notification) === openRow)
  }, [openRow, openRowHasUnread, markReadWhere])
  // A fresh install: the first feed that lands is the baseline, not news. Only
  // cards published after this moment will ever count.
  useEffect(() => {
    if (extensionsSeenAt === undefined && cardFeedStatus === 'ready') {
      markSectionSeen('extensions', new Date().toISOString())
    }
  }, [extensionsSeenAt, cardFeedStatus, markSectionSeen])

  return useMemo<RailBadges>(() => {
    let needsInput = 0
    let failed = 0
    let finished = 0
    for (const workspace of workspaces) {
      if (workspace.id === onScreenWorkspaceId) continue
      const activity = activityByWorkspaceId[workspace.id] ?? 'idle'
      if (activity === 'needs-input') needsInput += 1
      else if (activity === 'failed') failed += 1
      else if (unseenDoneIds.has(workspace.id)) finished += 1
    }
    return {
      home: homeRailBadge({ needsInput, failed, finished }),
      automations: automationsOpen ? null : automationsRailBadge(unreadAutomations),
      extensions: extensionsRailBadge({ rows: rowBadges, unseenCards }),
    }
  }, [
    workspaces,
    activityByWorkspaceId,
    unseenDoneIds,
    onScreenWorkspaceId,
    automationsOpen,
    rowBadges,
    unreadAutomations,
    unseenCards,
  ])
}
