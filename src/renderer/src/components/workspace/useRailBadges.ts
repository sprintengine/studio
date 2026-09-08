import { useEffect, useMemo } from 'react'

import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace } from '../../types/workspace'
import {
  AUTOMATIONS_NOTIFICATION_SOURCES,
  EXTENSIONS_NOTIFICATION_SOURCES,
  automationsRailBadge,
  extensionsRailBadge,
  homeRailBadge,
  unreadNotificationsFrom,
  unseenCardCount,
} from '../../utils/railBadges'
import type { RailBadges } from './AppRail'
import type { SidebarSection } from '../../store/slices/settingsSlice'
import { useSprintRunIndex } from './globalSurface/sprints/useSprintRunIndex'
import type { WorkspaceActivity } from './workspaceManagerHelpers'

// The rail's three badges, and what clears them. One hook rather than three
// because the clearing IS the reading: opening a section marks everything its
// square was counting as seen, and the count that comes back on the next
// render is what is still waiting on the person.
//
//   Home         — chats blocked on a prompt, crashed, or finished while you
//                  were away (the sidebar's own unseen-done mark, reported up),
//                  minus the chat on screen. Cleared per chat, by opening it —
//                  the sidebar already owns that, so nothing here writes.
//   Automations  — unread bell rows from the automations source. Cleared by
//                  opening the Automations door.
//   Extensions   — unread bell rows from anything under the glyph, hosted cards
//                  published since the home was last open, and sprints waiting
//                  on an answer. The first two clear on opening the section; a
//                  waiting sprint stays until it is answered.
//
// The section on screen never wears its own read-once count — those rows are
// being marked as the section opens, and drawing them for a frame first would
// flash a badge the click just cleared.
export function useRailBadges(input: {
  workspaces: readonly Workspace[]
  activityByWorkspaceId: Readonly<Record<string, WorkspaceActivity>>
  unseenDoneIds: ReadonlySet<string>
  /** The chat actually on screen, or null while a door holds the card region. */
  onScreenWorkspaceId: string | null
  section: SidebarSection
  activeGlobalSurface: string | null
  sprintsEnabled: boolean
}): RailBadges {
  const { workspaces, activityByWorkspaceId, unseenDoneIds, onScreenWorkspaceId, section, activeGlobalSurface, sprintsEnabled } = input

  const notifications = useNotificationStore((s) => s.notifications)
  const sectionSeenAt = useNotificationStore((s) => s.sectionSeenAt)
  const markReadBySources = useNotificationStore((s) => s.markReadBySources)
  const markSectionSeen = useNotificationStore((s) => s.markSectionSeen)
  const cards = useWorkspaceStore((s) => s.cards)
  const cardFeedStatus = useWorkspaceStore((s) => s.cardFeedStatus)
  // The same shared index the Sprints door and the Extensions home read: one
  // subscription and one coalesced scan per window, however many read it.
  const sprintRuns = useSprintRunIndex()

  const automationsOpen = activeGlobalSurface === 'automations'
  const extensionsOpen = section === 'extensions'

  const unreadAutomations = useMemo(
    () => unreadNotificationsFrom(notifications, AUTOMATIONS_NOTIFICATION_SOURCES),
    [notifications],
  )
  const unreadExtensions = useMemo(
    () => unreadNotificationsFrom(notifications, EXTENSIONS_NOTIFICATION_SOURCES),
    [notifications],
  )
  const extensionsSeenAt = sectionSeenAt.extensions
  const unseenCards = useMemo(() => unseenCardCount(cards, extensionsSeenAt), [cards, extensionsSeenAt])

  // Reading. The Automations door reads its rows; the Extensions section reads
  // its rows and stamps the cards — and keeps doing so while it is open, so a
  // push that lands mid-visit is seen rather than badged behind the person.
  useEffect(() => {
    if (automationsOpen && unreadAutomations.length > 0) markReadBySources(AUTOMATIONS_NOTIFICATION_SOURCES)
  }, [automationsOpen, unreadAutomations, markReadBySources])
  useEffect(() => {
    if (!extensionsOpen) return
    if (unreadExtensions.length > 0) markReadBySources(EXTENSIONS_NOTIFICATION_SOURCES)
    if (unseenCards > 0) markSectionSeen('extensions', new Date().toISOString())
  }, [extensionsOpen, unreadExtensions, unseenCards, markReadBySources, markSectionSeen])
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
    const sprintsWaiting = sprintsEnabled
      ? sprintRuns.runs.filter((run) => run.runtimeState === 'needs_input').length
      : 0
    return {
      home: homeRailBadge({ needsInput, failed, finished }),
      automations: automationsOpen ? null : automationsRailBadge(unreadAutomations),
      extensions: extensionsRailBadge({
        unread: extensionsOpen ? [] : unreadExtensions,
        unseenCards: extensionsOpen ? 0 : unseenCards,
        sprintsWaiting,
      }),
    }
  }, [
    workspaces,
    activityByWorkspaceId,
    unseenDoneIds,
    onScreenWorkspaceId,
    sprintsEnabled,
    sprintRuns.runs,
    automationsOpen,
    extensionsOpen,
    unreadAutomations,
    unreadExtensions,
    unseenCards,
  ])
}
