// The active workspace's control-group cluster — Sessions, View panels,
// Notifications and voice dictation — hoisted out of the retired 48px
// WorkspaceTopBar row into the merged AppTitleBar title strip (it fills the title bar's right-cluster-prefix slot, ahead of the
// app-level toggles). The whole cluster opts out of the strip's drag region via
// `app-no-drag` so the window never drags on a control click.
//
// The at-rest control groups are capped at five via `{/* top-bar-group: <name>
// */}` markers asserted by scripts/lint-panel-composition.mjs; keep this file
// and CANONICAL_TOP_BAR_GROUPS (the TopBar inventory) in lockstep.

import React from 'react'
import { CheckIcon, RemoteMachineGlyph, SpecialistActionIcon, SprintEngineRoleIcon, WorkspaceTypeIcon, resolveEnabledWorkspaceType } from '../AppIcons'
import {
  Badge,
  ChangePulse,
  EmptyState,
  FOCUS_RING_CLASS,
  IconButton,
  MENU_GROUP_LABEL_CLASS,
  MENU_LIST_CLASS,
  MenuItem,
  OutlineButton,
  PanelHeader,
  Popover,
  roveMenuFocus,
  StarGlyph,
  StatusDot,
  Tooltip,
  TruncatedText,
} from '../ui'
import {
  groupSessionItems,
  sessionsAttentionTone,
} from './workspaceManagerHelpers'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import CliIcon from '../CliIcon'
import { TerminalSessionIcon } from './agentComposer/agentSpawnShared'
import { getSpecialistAction } from '../../specialists/specialistActions'
import type {
  AgentCli,
  AppNotification,
  SpecialistActionId,
  Workspace,
} from '../../types/workspace'
import { hasComponentTab, toggleComponentTab } from '../../utils/modelRegistry'
import { getWorkspaceAccentHex, isStarred } from '../../utils/highlight'
import { getSprintEngineRoleAccent } from '../../utils/sprintengine'
import type { NotificationRowAction } from './topbar/NotificationsPopover'
import { remoteGlyphState, remoteGlyphToneClass, remoteGlyphTooltip, useOpenRemoteSettings } from './topbar/remoteGlyph'
import { useTailnetPresence } from './topbar/useTailnetPresence'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getRendererHost, selectModuleEnabled } from '../../modules'

// The two title-bar popovers' bodies. Both hang off a glyph in this cluster and
// neither is rendered until that glyph is pressed — the Remote list of machines
// and pair-request cards, and the notification reports with their per-report
// actions — so they are fetched at open time rather than carried through boot
// (bundle-budget ratchet; same shape as the Settings / New sprint surfaces in
// WorkspaceManager). The glyphs themselves, and the state they wear, stay eager:
// `remoteGlyph.ts` holds that half.
const RemotePopover = React.lazy(() =>
  import('./topbar/RemotePopover').then((m) => ({ default: m.RemotePopover })),
)
const NotificationsPopover = React.lazy(() =>
  import('./topbar/NotificationsPopover').then((m) => ({ default: m.NotificationsPopover })),
)

// The bucket a session row is listed under. Almost every session belongs to a
// resident workspace. One keyed to an id no workspace row claims — a review
// guide (keyed to the review id), a door surface, an agent still running in a
// workspace that was closed — is `detached`: it gets its own labeled bucket so
// it stays visible and stoppable instead of vanishing from the list.
export type SessionGroup =
  | { kind: 'workspace'; id: string; label: string; workspace: Workspace }
  | { kind: 'detached'; id: string; label: string }

export type SessionItem = {
  group: SessionGroup
  kind: TerminalKind
  // Which runtime owns the process behind `sessionId`. Conversation agents have
  // no PTY, so stopping and suspending them go through the conversation runtime
  // rather than the terminal one.
  transport: 'terminal' | 'conversation'
  agentId: string | null
  terminalId: string | null
  label: string
  cli: AgentCli
  status: 'needs-input' | 'working' | 'idle' | 'failed'
  // Provenance of `status`: 'hook' = authoritative lifecycle-hook frame,
  // 'inferred' = a lifecycle stamp (spawn `starting`, watchdog `stalled`,
  // pty `exited`/`failed`) — never an output-timing guess.
  source: AgentStateSource
  // When the current status began (ms epoch); drives "active 2m" / "waiting 4m".
  activitySince: number
  // Most recent real activity (max of last output/input), for "idle · 12m".
  lastActivityAt: number | null
  // Exit code when `status === 'failed'`, else null.
  exitCode: number | null
  role: NonNullable<Workspace['sprintEngineState']>['sprintEngineAgents'][string]['role'] | null
  specialistId: SpecialistActionId | null
  taskId: string | null
  sessionId: string
}

function sessionAgentTypeLabel(item: SessionItem): string | null {
  if (item.specialistId) return getSpecialistAction(item.specialistId).shortLabel
  return null
}

function SessionAgentIcon({ item, className }: { item: SessionItem; className?: string }) {
  if (item.specialistId) {
    const action = getSpecialistAction(item.specialistId)
    return <SpecialistActionIcon icon={action.icon} className={className} />
  }
  if (item.role) {
    return <SprintEngineRoleIcon role={item.role} className={className} />
  }
  if (item.kind === 'terminal') {
    return <TerminalSessionIcon className={className} />
  }
  return <CliIcon cli={item.cli} className={className} />
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.5" y="3.75" width="2.2" height="8.5" rx="0.9" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.3" y="3.75" width="2.2" height="8.5" rx="0.9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function SessionsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5" width="16" height="12.5" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7.5 9.25L10.25 12L7.5 14.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 14.75H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 20H15.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function NotificationBellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18.25 10.75V9.5a6.25 6.25 0 0 0-12.5 0v1.25c0 2.3-.8 3.6-1.55 4.38a1.24 1.24 0 0 0 .88 2.12h13.84a1.24 1.24 0 0 0 .88-2.12c-.75-.78-1.55-2.08-1.55-4.38Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.75 19.25a2.35 2.35 0 0 0 4.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

// Earned status dot: idle rows get no dot at all — a "working" indicator must be
// earned, not the default for every live row. Live attention states pulse; a
// crashed session shows a steady error dot.
function sessionStatusDot(
  status: SessionItem['status'],
): { tone: 'warn' | 'good' | 'error'; pulse: boolean } | null {
  switch (status) {
    case 'needs-input':
      return { tone: 'warn', pulse: true }
    case 'working':
      return { tone: 'good', pulse: true }
    case 'failed':
      return { tone: 'error', pulse: false }
    case 'idle':
      return null
  }
}

// Honest status + recency, e.g. "Needs input · waiting 4m", "Working · 2m",
// "idle · 18m", "Exit 1 · 8m ago". Carries the truth in text so the dot can stay
// decorative and idle rows can drop it entirely.
function sessionStatusMeta(item: SessionItem, now: number): string {
  switch (item.status) {
    case 'needs-input': {
      const rel = formatRelativeMs(item.activitySince, now)
      return rel ? `Needs input · waiting ${rel}` : 'Needs input'
    }
    case 'working': {
      const rel = formatRelativeMs(item.activitySince, now)
      return rel ? `Working · ${rel}` : 'Working'
    }
    case 'failed':
      return `Exit ${item.exitCode ?? 1} · ${formatRelativeMsAgo(item.activitySince, now)}`
    case 'idle': {
      const rel = formatRelativeMs(item.lastActivityAt ?? item.activitySince, now)
      return rel ? `idle · ${rel}` : 'idle'
    }
  }
}

function SessionsPopover({
  items,
  workspaceOrder,
  onOpen,
  onPause,
  onStop,
  onStopGroup,
}: {
  items: SessionItem[]
  workspaceOrder: Map<string, number>
  onOpen: (item: SessionItem) => void | Promise<void>
  onPause: (item: SessionItem) => void
  onStop: (item: SessionItem) => void
  onStopGroup: (group: SessionGroup, items: SessionItem[]) => void | Promise<void>
}) {
  // Re-render every 30s so relative times ("idle · 12m") stay fresh while open.
  const now = useRelativeNow(30_000)
  const groups = groupSessionItems(items, workspaceOrder)

  return (
    <div className="w-[420px] overflow-hidden">
      <PanelHeader title="Sessions" count={items.length > 0 ? items.length : undefined} />

      {groups.length === 0 ? (
        <EmptyState density="list" title="No sessions" />
      ) : (
        <div className="max-h-[420px] overflow-y-auto p-1">
          {groups.map((group) => {
            // A detached bucket has no workspace identity to wear: no type
            // icon, no star — the bare label is what distinguishes it from the
            // workspace groups above it. The group label carries the grouping
            // on its own; the per-group accent bar it used to sit beside was a
            // second left-bar idiom in the app (audit ruling 10).
            const workspace = group.group.kind === 'workspace' ? group.group.workspace : null
            const accent = workspace ? getWorkspaceAccentHex(workspace) : null
            const starred = workspace ? isStarred(workspace.highlight) : false
            const headerColor = accent ?? 'var(--text-subtle)'
            return (
              <div key={group.group.id} className="py-1">
                <div
                  className="flex items-center gap-2 px-2.5 py-1.5 text-meta font-semibold"
                  style={{ color: headerColor }}
                >
                  {workspace ? (
                    <WorkspaceTypeIcon mode={workspace.mode} className="size-icon-xs shrink-0" />
                  ) : null}
                  <TruncatedText as="span" text={group.group.label} className="min-w-0" />
                  {starred ? (
                    <StarGlyph
                      filled
                      className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
                      label="Starred workspace"
                    />
                  ) : null}
                  {group.items.length > 1 ? (
                    // Destructive stays ink: the outline's danger tone recolours
                    // the label on hover and never fills the button with the
                    // error hue (button/component.md).
                    <OutlineButton
                      size="xs"
                      tone="danger"
                      onClick={() => void onStopGroup(group.group, group.items)}
                      className="ml-auto shrink-0"
                      aria-label={`Stop all ${group.items.length} sessions in ${group.group.label}`}
                    >
                      <StopIcon className="icon-xs" />
                      Stop all
                    </OutlineButton>
                  ) : null}
                </div>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    // The role hue is identity ink on the glyph only — no tinted
                    // fill behind it (the fill was a hex-alpha written into
                    // `style`, invisible to the token guard).
                    const chipStyle = item.role
                      ? { color: getSprintEngineRoleAccent(item.role) }
                      : undefined
                    const typeLabel = sessionAgentTypeLabel(item)
                    const identityParts = item.kind === 'terminal'
                      ? [item.label.toLowerCase()]
                      : [typeLabel, item.taskId, item.cli].filter((value): value is string => Boolean(value))
                    // Lead the subline with honest status + recency, then identity.
                    const subline = [sessionStatusMeta(item, now), ...identityParts]
                      .filter(Boolean)
                      .join(' · ') || item.cli
                    const dot = sessionStatusDot(item.status)
                    return (
                      <div
                        key={`${item.group.id}:${item.agentId ?? item.terminalId ?? item.sessionId}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-2.5 py-2 text-body text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)]"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="flex size-control-xs shrink-0 items-center justify-center rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
                            style={chipStyle}
                          >
                            <SessionAgentIcon item={item} className="size-icon-md" />
                          </span>
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <TruncatedText
                                as="span"
                                text={item.label}
                                className="min-w-0 font-medium text-[color:var(--text-strong)]"
                              />
                              {dot ? (
                                <StatusDot tone={dot.tone} pulse={dot.pulse} />
                              ) : null}
                            </span>
                            <TruncatedText
                              as="span"
                              text={subline}
                              className="mt-0.5 block text-micro text-[color:var(--text-subtle)]"
                            />
                          </span>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                        {/* Open activates the row's workspace and focuses its
                            pane. A detached session has no workspace to activate,
                            so the button is absent rather than present-and-inert;
                            Pause and Stop act on the process and still work. */}
                        {item.group.kind === 'workspace' ? (
                          <OutlineButton size="xs" onClick={() => void onOpen(item)}>
                            Open
                          </OutlineButton>
                        ) : null}

                        {/* Pause suspends a PTY. A conversation agent has none,
                            so the control is absent for those rows instead of
                            failing quietly against the terminal runtime. */}
                        {item.kind === 'agent'
                        && item.transport === 'terminal'
                        && item.status !== 'failed' ? (
                          <Tooltip content="Pause — suspends the agent to free memory; reopen resumes it">
                            <IconButton onClick={() => onPause(item)} aria-label={`Pause ${item.label}`}>
                              <PauseIcon className="icon-sm" />
                            </IconButton>
                          </Tooltip>
                        ) : null}

                        {/* A failed session has no process to stop — the action
                            disposes the retained crash row, so it reads as "Dismiss".
                            Neutral ink at rest: the tooltip and name say what it
                            does, and a status hue as a button ground is not a
                            button variant the system has. */}
                        <Tooltip content={item.status === 'failed' ? 'Dismiss' : 'Stop'}>
                          <IconButton
                            onClick={() => onStop(item)}
                            aria-label={`${item.status === 'failed' ? 'Dismiss' : 'Stop'} ${item.label}`}
                          >
                            <StopIcon className="icon-sm" />
                          </IconButton>
                        </Tooltip>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export type WorkspaceActionsProps = {
  workspaces: Workspace[]
  activeWorkspace: Workspace | null
  workspaceActionsEnabled: boolean | null

  sessionsRef: React.RefObject<HTMLDivElement>
  viewMenuRef: React.RefObject<HTMLDivElement>
  notificationsRef: React.RefObject<HTMLDivElement>

  sessions: SessionItem[]
  sidebarWorkspaceOrder: Map<string, number>
  sessionsOpen: boolean
  setSessionsOpen: React.Dispatch<React.SetStateAction<boolean>>
  openSession: (item: SessionItem) => void | Promise<void>
  pauseSession: (item: SessionItem) => void
  stopSession: (item: SessionItem) => void
  stopSessionGroup: (group: SessionGroup, items: SessionItem[]) => void | Promise<void>

  viewMenuOpen: boolean
  setViewMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  viewMenuTick: number
  setViewMenuTick: React.Dispatch<React.SetStateAction<number>>

  notifications: AppNotification[]
  /** Unread *error*-level notifications only — the bell badge is an error counter. */
  unreadErrorCount: number
  notificationsOpen: boolean
  setNotificationsOpen: React.Dispatch<React.SetStateAction<boolean>>
  markNotificationRead: (id: string) => void
  markAllNotificationsRead: () => void
  clearNotifications: () => void
  /** Resolve a notification's Open action(s); empty when no deep-link or reveal is possible. */
  resolveNotificationActions: (notification: AppNotification) => NotificationRowAction[]

}

// The shared AppIcons branch fork (mirrored in
// design-system/glyphs/git-branch.svg since remote-sessions-ux /
// two-line-session-rows). This file drew its own; the tab popover, the
// layout header, and the sidebar rows now share the single export.
export { GitBranchGlyph } from '../AppIcons'

export function WorkspaceActions({
  workspaces,
  activeWorkspace,
  workspaceActionsEnabled,
  sessionsRef,
  viewMenuRef,
  notificationsRef,
  sessions,
  sidebarWorkspaceOrder,
  sessionsOpen,
  setSessionsOpen,
  openSession,
  pauseSession,
  stopSession,
  stopSessionGroup,
  viewMenuOpen,
  setViewMenuOpen,
  viewMenuTick,
  setViewMenuTick,
  notifications,
  unreadErrorCount,
  notificationsOpen,
  setNotificationsOpen,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
  resolveNotificationActions,
}: WorkspaceActionsProps) {
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  // Module-contributed top-bar controls, gated on live enablement so a module
  // toggle adds/removes its control without a reload (registry references are
  // stable; the memo recomputes only when enablement changes).
  const moduleTopBarItems = React.useMemo(
    () => getRendererHost().getTopBarItems((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    [moduleOverrides],
  )
  // Remote presence (remote-sessions-ux / remote-glyph-topbar): pushed, never
  // polled. Open-state lives here with its two neighbours so the three
  // popovers stay mutually exclusive.
  const remotePresence = useTailnetPresence()
  const remoteState = remoteGlyphState(remotePresence)
  const [remoteOpen, setRemoteOpen] = React.useState(false)
  const openRemoteSettings = useOpenRemoteSettings()
  // An OS notification about a pair request or a machine's answer was
  // clicked (pair-from-the-scan-and-stay-paired, phase 3): main brought the
  // window forward; this opens the surface the banner pointed at.
  React.useEffect(() => {
    if (typeof window.api.onRemoteOpenRequested !== 'function') return
    return window.api.onRemoteOpenRequested(() => {
      setSessionsOpen(false)
      setNotificationsOpen(false)
      setRemoteOpen(true)
    })
  }, [])
  // The active workspace type's top-bar view set, from the registry and gated by
  // module enablement (was VIEWS_FOR_MODE). getWorkspaceType returns a stable
  // reference, so this memo only recomputes when the mode or enablement changes;
  // null means no switcher (most types, or a disabled module).
  const activeWorkspaceViews = React.useMemo(
    () => (activeWorkspace ? resolveEnabledWorkspaceType(activeWorkspace.mode, moduleOverrides)?.topBarViews ?? null : null),
    [activeWorkspace, moduleOverrides],
  )
  // The view-panels menu surface, so its rows rove with the arrow keys the way
  // every other menu in the app does (menu/component.md → Accessibility).
  const viewMenuSurfaceRef = React.useRef<HTMLElement | null>(null)
  // Stable identity: `Popover`'s auto-focus effect is keyed on this callback, so
  // an inline arrow function would re-run it on every render and yank the
  // keyboard position back to row 1 while the menu is open (toggling a row bumps
  // `viewMenuTick`, which re-renders). See ui/FilterMenu.tsx for the same shape.
  const focusFirstViewMenuItem = React.useCallback((surface: HTMLElement) => {
    viewMenuSurfaceRef.current = surface
    surface.querySelector<HTMLElement>('[data-menu-item="true"]:not([disabled])')?.focus()
  }, [])
  return (
      <div className="app-no-drag flex shrink-0 items-center gap-1.5">
        {/*
         * WorkspaceActions at-rest control inventory — capped at five groups.
         * The Git change-count badge migrated to the PanelRail Git icon
         * (`workspace-context` retired) and the specialist split-button was
         * deleted with MC-2222 (`agent-spawn` retired: spawning is New chat's
         * and the tab strip's job), so the row carries two canonical groups;
         * adding a sixth top-bar-group marker fails
         * scripts/lint-panel-composition.mjs, which holds the canonical
         * TopBar inventory.
         */}
        {/* top-bar-group: activity-and-views */}
        {workspaces.length > 0 ? (
          <div ref={sessionsRef} className="relative inline-flex">
            <Popover
              open={sessionsOpen}
              onOpenChange={(next) => {
                setSessionsOpen(next)
                if (next) {
                  setNotificationsOpen(false)
                  setRemoteOpen(false)
                }
              }}
              ariaLabel="Sessions"
              popupRole="menu"
              placement="bottom-end"
              renderTrigger={({ ref, triggerProps, togglePopover }) => {
                // Badge tone reflects attention: warn if any session needs the
                // user, error if any crashed, else good — never a flat "all fine".
                const sessionsTone = sessionsAttentionTone(sessions)
                return (
                <Tooltip content="Sessions" placement="bottom">
                  {/* The kit's icon button at its `md` step: the open state is the
                      neutral selection fill, not a border lift (the lift read
                      `--color-5`, a flexlayout-private alias that resolved to
                      currentColor out here). */}
                  <IconButton
                    ref={ref}
                    size="md"
                    onClick={togglePopover}
                    pressed={sessionsOpen}
                    className="relative"
                    aria-label="Sessions"
                    {...triggerProps}
                  >
                    <ChangePulse value={sessions.length} mode="increase" tint={`var(--tone-${sessionsTone})`} className="inline-flex">
                      <SessionsIcon className="size-icon-md" />
                    </ChangePulse>
                    {sessions.length > 0 ? (
                      <Badge corner decorative tone={sessionsTone} count={sessions.length} max={99} />
                    ) : null}
                  </IconButton>
                </Tooltip>
                )
              }}
            >
              <SessionsPopover
                items={sessions}
                workspaceOrder={sidebarWorkspaceOrder}
                onOpen={openSession}
                onPause={pauseSession}
                onStop={stopSession}
                onStopGroup={stopSessionGroup}
              />
            </Popover>
          </div>
        ) : null}

        {workspaceActionsEnabled && activeWorkspace && activeWorkspaceViews ? (
          <div ref={viewMenuRef} className="relative inline-flex">
            <Popover
              open={viewMenuOpen}
              onOpenChange={(next) => {
                setViewMenuOpen(next)
                if (next) {
                  setViewMenuTick((tick) => tick + 1)
                  setSessionsOpen(false)
                  setNotificationsOpen(false)
                }
              }}
              ariaLabel={`${activeWorkspaceViews?.label ?? 'View'} panels`}
              popupRole="menu"
              placement="bottom-end"
              surfaceClassName={`w-60 ${MENU_LIST_CLASS}`}
              onOpenAutoFocus={focusFirstViewMenuItem}
              renderTrigger={({ ref, triggerProps, togglePopover }) => (
                <Tooltip content={`${activeWorkspaceViews?.label ?? 'View'} panels`} placement="bottom">
                  <button
                    ref={ref}
                    type="button"
                    onClick={togglePopover}
                    /*
                     * Condenses to an icon-only 32px square below ~1000px so the
                     * right cluster gives way before the hoisted workspace name is
                     * squeezed out at narrow widths (the label + chevron re-appear
                     * at >= 1000px). The tooltip + aria-label carry the meaning, so
                     * the icon-only state stays accessible.
                     */
                    className={`interactive inline-flex size-control-sm items-center justify-center gap-1.5 rounded-sm border transition-colors min-[1000px]:w-auto min-[1000px]:justify-start min-[1000px]:px-2.5 ${FOCUS_RING_CLASS} ${
                      viewMenuOpen
                        ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                        : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                    }`}
                    aria-label="Toggle workspace panels"
                    {...triggerProps}
                  >
                    <svg className="size-icon-xs shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="2" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.4" />
                      <rect x="9" y="2" width="5" height="6" rx="1" stroke="currentColor" strokeWidth="1.4" />
                      <rect x="9" y="10" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                    <span className="hidden text-meta font-semibold min-[1000px]:inline">{activeWorkspaceViews?.label ?? 'View'}</span>
                    <svg className={`hidden icon-xs transition-transform min-[1000px]:block ${viewMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </Tooltip>
              )}
            >
              {/* The shared menu rows: `MenuItem` carries the `menuitemcheckbox`
                  role, `aria-checked`, the inset ring and the hover fill, and
                  the surface roves the arrow keys. The tick is a neutral glyph
                  in a fixed leading slot — selection in a menu is the checked
                  state, never an accent-filled box per row. */}
              <div onKeyDown={(event) => roveMenuFocus(event, viewMenuSurfaceRef.current)}>
                <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1`}>
                  {activeWorkspaceViews?.label ?? 'View'} panels
                </div>
                {(activeWorkspaceViews?.views ?? []).map((view) => {
                  void viewMenuTick
                  const checked = hasComponentTab(activeWorkspace.id, view.component)
                  return (
                    <MenuItem
                      key={view.component}
                      checked={checked}
                      onClick={() => {
                        toggleComponentTab(activeWorkspace.id, view.component, view.name)
                        setViewMenuTick((tick) => tick + 1)
                      }}
                      icon={
                        <CheckIcon className={`icon-xs shrink-0 ${checked ? '' : 'invisible'}`} />
                      }
                    >
                      {view.name}
                    </MenuItem>
                  )
                })}
              </div>
            </Popover>
          </div>
        ) : null}

        {/* top-bar-group: communication */}
        {/* The Remote glyph (remote-sessions-ux / remote-glyph-topbar):
            presence for both directions of the tailnet — who is driving this
            machine, and the machines this Studio drives. Consciously
            supersedes the Fleet "no rail glyph" ruling for the TOP BAR (epic
            decision 5); commandRegistry's fleet comment records the same.
            Hidden while the feature is off and no machine is paired — absent,
            not present-but-empty. */}
        {remoteState.visible ? (
          <div className="relative inline-flex">
            <Popover
              open={remoteOpen}
              onOpenChange={(next) => {
                setRemoteOpen(next)
                if (next) {
                  setSessionsOpen(false)
                  setNotificationsOpen(false)
                }
              }}
              ariaLabel="Remote"
              // Rows carry their own buttons (Revoke, Review) — a dialog, not
              // a menu, same ruling as the notifications popover (MC-2138).
              popupRole="dialog"
              placement="bottom-end"
              renderTrigger={({ ref, triggerProps, togglePopover }) => (
                <Tooltip
                  content={remoteGlyphTooltip(remoteState)}
                  placement="bottom"
                >
                  <IconButton
                    ref={ref}
                    size="md"
                    onClick={togglePopover}
                    pressed={remoteOpen}
                    className="relative"
                    aria-label="Remote"
                    {...triggerProps}
                  >
                    {/* The GLYPH carries the state, and nothing sits in the
                        corner beside it (owner ruling 2026-09-05: one
                        indicator, not two on a 16px mark). Green while this
                        Studio is serving or something is connected; pulsing
                        amber only when something wants a person — a waiting
                        pair request, or a machine that stopped answering; the
                        default ink when remote is idle. A phone driving a
                        terminal is the feature working, not a summons, so it
                        is green like any other connection. */}
                    <ChangePulse
                      value={remoteState.requestCount}
                      mode="increase"
                      tint="var(--tone-warn)"
                      className="inline-flex"
                    >
                      <RemoteMachineGlyph className={`size-icon-md ${remoteGlyphToneClass(remoteState)}`} />
                    </ChangePulse>
                    {/* The count the glyph wears (owner ruling 2026-09-05):
                        machines answering right now, the way the terminal
                        glyph counts open sessions. A waiting pair request
                        outranks it — that one asks for a person. */}
                    {remoteState.requestCount > 0 ? (
                      <Badge corner decorative tone="warn" count={remoteState.requestCount} max={9} />
                    ) : remoteState.answering > 0 ? (
                      <Badge corner decorative tone="good" count={remoteState.answering} max={9} />
                    ) : null}
                  </IconButton>
                </Tooltip>
              )}
            >
              <React.Suspense fallback={null}>
                <RemotePopover
                  presence={remotePresence}
                  onOpenRemoteSettings={() => {
                    setRemoteOpen(false)
                    openRemoteSettings()
                  }}
                />
              </React.Suspense>
            </Popover>
          </div>
        ) : null}
        <div ref={notificationsRef} className="relative inline-flex">
          <Popover
            open={notificationsOpen}
            onOpenChange={(next) => {
              setNotificationsOpen(next)
              if (next) {
                setSessionsOpen(false)
                setRemoteOpen(false)
              }
            }}
            ariaLabel="Notifications"
            // A list of reports, each with its own buttons — not a menu. It
            // carried `role="menu"` with `role="menuitem"` on the report blocks,
            // which announced rows that could not be activated (MC-2138).
            popupRole="dialog"
            placement="bottom-end"
            renderTrigger={({ ref, triggerProps, togglePopover }) => (
              <Tooltip content="Notifications" placement="bottom">
                <IconButton
                  ref={ref}
                  size="md"
                  onClick={togglePopover}
                  pressed={notificationsOpen}
                  className="relative"
                  aria-label="Notifications"
                  {...triggerProps}
                >
                  <ChangePulse value={unreadErrorCount} mode="increase" tint="var(--tone-error)" className="inline-flex">
                    <NotificationBellIcon className="size-icon-md" />
                  </ChangePulse>
                  {unreadErrorCount > 0 ? (
                    <Badge corner decorative tone="error" count={unreadErrorCount} max={99} />
                  ) : null}
                </IconButton>
              </Tooltip>
            )}
          >
            <React.Suspense fallback={null}>
              <NotificationsPopover
                notifications={notifications}
                onMarkRead={markNotificationRead}
                onMarkAllRead={markAllNotificationsRead}
                onClear={clearNotifications}
                onOpenLogs={() => void window.api.openDiagnosticsLogsFolder()}
                resolveActions={resolveNotificationActions}
              />
            </React.Suspense>
          </Popover>
        </div>

        {/* Module-contributed top-bar controls (registerTopBarItem): the mic
          * button and its siblings render here, in the communication cluster's
          * module slot. Enablement-filtered above, so a module toggle
          * adds/removes its control live. */}
        {moduleTopBarItems.map((item) => (
          <React.Suspense key={item.id} fallback={null}>
            <item.Component />
          </React.Suspense>
        ))}

        {/* Account + Settings relocated to the sidebar bottom (SidebarAccountBar,
            Cursor-parity). The former `account-and-settings` top-bar group is
            retired; see CANONICAL_TOP_BAR_GROUPS in
            scripts/lint-panel-composition.mjs for the TopBar inventory. */}
      </div>
  )
}
