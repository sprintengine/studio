// The active workspace's control-group cluster — Sessions, View panels,
// Notifications, voice dictation, and the specialist split-button — hoisted out
// of the retired 48px WorkspaceTopBar row into the merged AppTitleBar title
// strip (it fills the title bar's right-cluster-prefix slot, ahead of the
// app-level toggles). The whole cluster opts out of the strip's drag region via
// `app-no-drag` so the window never drags on a control click.
//
// The at-rest control groups are capped at five via `{/* top-bar-group: <name>
// */}` markers asserted by scripts/lint-panel-composition.mjs; keep this file,
// CANONICAL_TOP_BAR_GROUPS, and knowledge/brand/panel-design-system.md TopBar
// inventory in lockstep.

import React from 'react'
import { SpecialistActionIcon, SprintEngineRoleIcon, WorkspaceTypeIcon, resolveEnabledWorkspaceType } from '../AppIcons'
import { Badge, ChangePulse, FOCUS_RING_CLASS, Popover, StarGlyph, StatusDot, Tooltip, TruncatedText } from '../ui'
import {
  groupSessionItems,
  sessionsAttentionTone,
} from './workspaceManagerHelpers'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import CliIcon from '../CliIcon'
import { AGENT_SPAWN_PERMISSION_OPTIONS, TerminalSessionIcon } from './agentComposer/agentSpawnShared'
import AgentComposerPopover from './agentComposer/AgentComposerPopover'
import { type AgentComposerConfirm, type AgentComposerSelection } from './agentComposer/AgentComposer'
import {
  GENERAL_AGENT_ENGINE_KEY,
  getSpecialistAction,
  type SpecialistAction,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AppNotification,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
  Workspace,
} from '../../types/workspace'
import {
  resolveAvailableAgentCli,
  resolveLaunchableAgentCli,
  type AgentCliCatalogOption,
} from './newWorkspace/cliRuntimeOptions'
import { hasComponentTab, toggleComponentTab } from '../../utils/modelRegistry'
import { getWorkspaceAccentHex, isStarred } from '../../utils/highlight'
import { getSprintEngineRoleAccent } from '../../utils/sprintengine'
import { NotificationsPopover, type NotificationRowAction } from './topbar/NotificationsPopover'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import {
  getEffectiveKeybindingLabel,
  getSpecialistCommandId,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'

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
  // 'inferred' = output-timing fallback.
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
    <div className="w-[420px] overflow-hidden p-1">
      <div className="flex h-9 items-center justify-between border-b border-[color:var(--border-default)] px-2.5">
        <span className="text-meta font-semibold text-[color:var(--text-strong)]">
          Sessions
        </span>
        {items.length > 0 ? (
          <span className="rounded bg-[color:var(--bg-hover)] px-1.5 py-0.5 text-micro font-semibold text-[color:var(--text-muted)]">
            {items.length}
          </span>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="px-2.5 py-3 text-body text-[color:var(--text-disabled)]">No sessions</div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto py-1">
          {groups.map((group) => {
            // A detached bucket has no workspace identity to wear: no accent
            // rail, no type icon, no star — the bare label is what distinguishes
            // it from the workspace groups above it.
            const workspace = group.group.kind === 'workspace' ? group.group.workspace : null
            const accent = workspace ? getWorkspaceAccentHex(workspace) : null
            const starred = workspace ? isStarred(workspace.highlight) : false
            const headerColor = accent ?? 'var(--text-subtle)'
            return (
              <div key={group.group.id} className="relative py-1 pl-2">
                {accent ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-2 left-0 w-[2px] rounded-full"
                    style={{ background: accent }}
                  />
                ) : null}
                <div
                  className="flex items-center gap-2 px-2.5 py-1.5 text-meta font-semibold"
                  style={{ color: headerColor }}
                >
                  {workspace ? (
                    <WorkspaceTypeIcon mode={workspace.mode} className="h-3.5 w-3.5 shrink-0" />
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
                    <button
                      type="button"
                      onClick={() => void onStopGroup(group.group, group.items)}
                      className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded border border-transparent px-1.5 text-micro font-medium text-[color:var(--text-subtle)] transition-colors hover:border-[color:var(--tone-error-soft)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)]"
                      aria-label={`Stop all ${group.items.length} sessions in ${group.group.label}`}
                    >
                      <StopIcon className="icon-xs" />
                      Stop all
                    </button>
                  ) : null}
                </div>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const chipStyle = item.role
                      ? {
                          borderColor: getSprintEngineRoleAccent(item.role),
                          color: getSprintEngineRoleAccent(item.role),
                          backgroundColor: `${getSprintEngineRoleAccent(item.role)}14`,
                        }
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
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded px-2.5 py-2 text-body text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)]"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
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
                          <button
                            type="button"
                            onClick={() => void onOpen(item)}
                            className="h-7 rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-2.5 text-meta font-semibold text-[color:var(--text-default)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)]"
                          >
                            Open
                          </button>
                        ) : null}

                        {/* Pause suspends a PTY. A conversation agent has none,
                            so the control is absent for those rows instead of
                            failing quietly against the terminal runtime. */}
                        {item.kind === 'agent'
                        && item.transport === 'terminal'
                        && item.status !== 'failed' ? (
                          <Tooltip content="Pause — suspends the agent to free memory; reopen resumes it">
                            <button
                              type="button"
                              onClick={() => onPause(item)}
                              className="flex h-7 w-7 items-center justify-center rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)]"
                              aria-label={`Pause ${item.label}`}
                            >
                              <PauseIcon className="icon-sm" />
                            </button>
                          </Tooltip>
                        ) : null}

                        {/* A failed session has no process to stop — the action
                            disposes the retained crash row, so it reads as "Dismiss". */}
                        <Tooltip content={item.status === 'failed' ? 'Dismiss' : 'Stop'}>
                          <button
                            type="button"
                            onClick={() => onStop(item)}
                            className="flex h-7 w-7 items-center justify-center rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--tone-error-soft)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)]"
                            aria-label={`${item.status === 'failed' ? 'Dismiss' : 'Stop'} ${item.label}`}
                          >
                            <StopIcon className="icon-sm" />
                          </button>
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
  activeWorkspaceId: string | null
  workspaceActionsEnabled: boolean | null
  /**
   * A door surface owns the content region. Spawning an agent is a thing you do
   * to a WORKSPACE — the agent lands in its layout — so the spawn split-button
   * drops out while a door is open (owner, 2026-07-30) rather than offering to
   * launch a specialist into a page that has no terminals. Sessions,
   * notifications, dictation, and the attention cue all stay: they are
   * cross-workspace, and they are useful from anywhere.
   */
  globalSurfaceActive?: boolean

  sessionsRef: React.RefObject<HTMLDivElement>
  viewMenuRef: React.RefObject<HTMLDivElement>
  notificationsRef: React.RefObject<HTMLDivElement>
  specialistMenuRef: React.RefObject<HTMLDivElement>

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

  specialistMenuOpen: boolean
  setSpecialistMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  selectedSpecialistAction: SpecialistAction
  selectedAgentPermissionOption: typeof AGENT_SPAWN_PERMISSION_OPTIONS[number]
  lastSelectedCli: AgentCli
  // Per-agent CLI choice (e.g. Architect → Codex) used by the split-button
  // trigger's default-spawn icon and CLI badge. The menu reads these from the
  // store itself; the trigger needs them to resolve its default spawn.
  specialistCliDefaults: Partial<Record<SpecialistActionId, AgentCli>>
  // Plugin-aware agent CLI catalog (bundled + configured cliRuntimes). The
  // trigger resolves its default CLI against this list.
  agentCliOptions: AgentCliCatalogOption[]
  agentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  setAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  // Transient Debug Mode toggle, forwarded to the spawn menu's mode row.
  agentSpawnDebugMode: boolean
  setAgentSpawnDebugMode: (next: boolean) => void
  // Primary split-button half: spawn the remembered specialist straight into
  // the active workspace with the trigger CLI.
  addNewSpecialist: (cli: AgentCli) => void | Promise<void>
  // Standard-mode alternative to `addNewSpecialist`: when the remembered
  // top-bar spawn is the General agent (`standardSpawnIsGeneral`), the primary
  // half spawns General with the trigger CLI instead of a specialist.
  addNewGeneralAgent: (cli: AgentCli) => void | Promise<void>
  standardSpawnIsGeneral: boolean
  // The dropdown renders the shared AgentComposerPopover. `conversationAvailable`
  // gates its Conversation row; `composerInitialSelection` preselects the
  // remembered agent; `runComposerSpawn` maps a confirm to the real spawn into
  // the active workspace.
  conversationSpawnAvailable: boolean
  composerInitialSelection: AgentComposerSelection
  runComposerSpawn: (confirm: AgentComposerConfirm) => void
}

// Branch-fork glyph for the header identity cluster. Stroke idiom matches the
// Git panel's local icons (1.3px round strokes on a 16px box) so the two Git
// surfaces read as one family.
export function GitBranchGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <circle cx="5" cy="3.6" r="1.55" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5" cy="12.4" r="1.55" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11" cy="4.2" r="1.55" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 5.15v5.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M11 5.75v.7a3.1 3.1 0 0 1-3.1 3.1H6.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function WorkspaceActions({
  workspaces,
  activeWorkspace,
  activeWorkspaceId,
  workspaceActionsEnabled,
  globalSurfaceActive = false,
  sessionsRef,
  viewMenuRef,
  notificationsRef,
  specialistMenuRef,
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
  specialistMenuOpen,
  setSpecialistMenuOpen,
  selectedSpecialistAction,
  selectedAgentPermissionOption,
  lastSelectedCli,
  specialistCliDefaults,
  agentCliOptions,
  agentSpawnPermissionPreset,
  setAgentSpawnPermissionPreset,
  agentSpawnDebugMode,
  setAgentSpawnDebugMode,
  addNewSpecialist,
  addNewGeneralAgent,
  standardSpawnIsGeneral,
  conversationSpawnAvailable,
  composerInitialSelection,
  runComposerSpawn,
}: WorkspaceActionsProps) {
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  // Module-contributed top-bar controls, gated on live enablement so a module
  // toggle adds/removes its control without a reload (registry references are
  // stable; the memo recomputes only when enablement changes).
  const moduleTopBarItems = React.useMemo(
    () => getRendererHost().getTopBarItems((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    [moduleOverrides],
  )
  // The active workspace type's top-bar view set, from the registry and gated by
  // module enablement (was VIEWS_FOR_MODE). getWorkspaceType returns a stable
  // reference, so this memo only recomputes when the mode or enablement changes;
  // null means no switcher (most types, or a disabled module).
  const activeWorkspaceViews = React.useMemo(
    () => (activeWorkspace ? resolveEnabledWorkspaceType(activeWorkspace.mode, moduleOverrides)?.topBarViews ?? null : null),
    [activeWorkspace, moduleOverrides],
  )
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const shortcutFor = React.useCallback((commandId: string): string | null => (
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform)
  ), [keybindingPlatform, keybindingSettings])
  const withShortcut = React.useCallback((label: string, shortcut: string | null): string => (
    shortcut ? `${label} (${shortcut})` : label
  ), [])
  // Resolve a human label for any CLI from the plugin-aware catalog, so pinned
  // opencode/custom agents read correctly instead of falling back to "Claude Code".
  const cliLabelFor = (cli: AgentCli): string =>
    agentCliOptions.find((option) => option.value === cli)?.label ?? cli
  return (
      <div className="app-no-drag flex shrink-0 items-center gap-1.5">
        {/*
         * WorkspaceActions at-rest control inventory — capped at five groups.
         * The Git change-count badge migrated to the PanelRail Git icon, so
         * `workspace-context` retired and the row carries four canonical
         * groups; adding a sixth top-bar-group marker fails
         * scripts/lint-panel-composition.mjs. Documented in
         * knowledge/brand/panel-design-system.md (TopBar inventory).
         */}
        {/* top-bar-group: activity-and-views */}
        {workspaces.length > 0 ? (
          <div ref={sessionsRef} className="relative inline-flex">
            <Popover
              open={sessionsOpen}
              onOpenChange={(next) => {
                setSessionsOpen(next)
                if (next) {
                  setSpecialistMenuOpen(false)
                  setNotificationsOpen(false)
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
                  <button
                    ref={ref}
                    type="button"
                    onClick={togglePopover}
                    className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${FOCUS_RING_CLASS} ${
                      sessionsOpen
                        ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                        : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                    }`}
                    aria-label="Sessions"
                    {...triggerProps}
                  >
                    <ChangePulse value={sessions.length} mode="increase" tint={`var(--tone-${sessionsTone})`} className="inline-flex">
                      <SessionsIcon className="size-icon-md" />
                    </ChangePulse>
                    {sessions.length > 0 ? (
                      <Badge corner decorative tone={sessionsTone} count={sessions.length} max={99} />
                    ) : null}
                  </button>
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
                  setSpecialistMenuOpen(false)
                  setNotificationsOpen(false)
                }
              }}
              ariaLabel={`${activeWorkspaceViews?.label ?? 'View'} panels`}
              popupRole="menu"
              placement="bottom-end"
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
                    className={`inline-flex h-8 w-8 items-center justify-center gap-1.5 rounded-md border transition-colors min-[1000px]:w-auto min-[1000px]:justify-start min-[1000px]:px-2.5 ${
                      viewMenuOpen
                        ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                        : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
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
              <div className="w-60 overflow-hidden p-1">
                <div className="px-2.5 pb-1 pt-1 text-micro font-medium text-[color:var(--text-muted)]">
                  {activeWorkspaceViews?.label ?? 'View'} panels
                </div>
                {(activeWorkspaceViews?.views ?? []).map((view) => {
                  void viewMenuTick
                  const checked = hasComponentTab(activeWorkspace.id, view.component)
                  return (
                    <button
                      key={view.component}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      onClick={() => {
                        toggleComponentTab(activeWorkspace.id, view.component, view.name)
                        setViewMenuTick((tick) => tick + 1)
                      }}
                      className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-body text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked
                            // On-accent ink, not the app canvas: the two are the
                            // same colour on the dark default and diverge
                            // everywhere else, which is where the tick vanished
                            // inside its own fill (MC-2113).
                            ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
                            : 'border-[color:var(--color-6)] bg-transparent text-transparent'
                        }`}
                        aria-hidden="true"
                      >
                        <svg className="icon-xs" viewBox="0 0 20 20" fill="none">
                          <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <TruncatedText as="span" text={view.name} className="min-w-0 flex-1" />
                    </button>
                  )
                })}
              </div>
            </Popover>
          </div>
        ) : null}

        {/* top-bar-group: communication */}
        <div ref={notificationsRef} className="relative inline-flex">
          <Popover
            open={notificationsOpen}
            onOpenChange={(next) => {
              setNotificationsOpen(next)
              if (next) {
                setSessionsOpen(false)
                setSpecialistMenuOpen(false)
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
                <button
                  ref={ref}
                  type="button"
                  onClick={togglePopover}
                  className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${FOCUS_RING_CLASS} ${
                    notificationsOpen
                      ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                      : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                  }`}
                  aria-label="Notifications"
                  {...triggerProps}
                >
                  <ChangePulse value={unreadErrorCount} mode="increase" tint="var(--tone-error)" className="inline-flex">
                    <NotificationBellIcon className="size-icon-md" />
                  </ChangePulse>
                  {unreadErrorCount > 0 ? (
                    <Badge corner decorative tone="error" count={unreadErrorCount} max={99} />
                  ) : null}
                </button>
              </Tooltip>
            )}
          >
            <NotificationsPopover
              notifications={notifications}
              onMarkRead={markNotificationRead}
              onMarkAllRead={markAllNotificationsRead}
              onClear={clearNotifications}
              onOpenLogs={() => void window.api.openDiagnosticsLogsFolder()}
              resolveActions={resolveNotificationActions}
            />
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

        {/* top-bar-group: agent-spawn */}
        {workspaceActionsEnabled && !globalSurfaceActive ? (() => {
          // Constrain a remembered CLI to one that is actually installed. When
          // the catalog is empty (registry still loading or no agent plugins)
          // this preserves the passed id rather than throwing on an empty list.
          const resolvePickerCli = (cli: AgentCli): AgentCli =>
            resolveAvailableAgentCli(cli, agentCliOptions, agentCliOptions[0]?.value ?? cli)
          const rememberedCli: AgentCli = standardSpawnIsGeneral
            ? (specialistCliDefaults[GENERAL_AGENT_ENGINE_KEY] ?? lastSelectedCli)
            : (specialistCliDefaults[selectedSpecialistAction.id] ?? lastSelectedCli)
          // The one-click half spawns without opening the picker, so it needs the
          // honest answer rather than the display default: on a machine with no
          // agent CLI there is nothing to launch and the button says so by being
          // inert (MC-2093). The chevron still opens the picker, which carries
          // the install route.
          const launchableCli = resolveLaunchableAgentCli(rememberedCli, agentCliOptions)
          const triggerCli: AgentCli = resolvePickerCli(rememberedCli)
          const triggerCliOption =
            agentCliOptions.find((option) => option.value === triggerCli)
            ?? { value: triggerCli, label: cliLabelFor(triggerCli) }
          return (
          <div ref={specialistMenuRef} className="relative inline-flex">
            {/*
             * Split-button frame: rounded border, no overflow-hidden. The Popover
             * surface anchors to the chevron and must escape this frame — clipping
             * here would hide the entire spawn-agent menu. Inner buttons round
             * their own outer corners so the hover background still follows the
             * frame's rounded corner.
             */}
            <div className="inline-flex rounded-md border border-[color:var(--color-6)] bg-[color:var(--bg-hover)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.025)]">
              <Tooltip
                placement="bottom"
                content={
                  !launchableCli
                    ? 'No agent CLI is installed — install one from the spawn menu'
                    : standardSpawnIsGeneral
                    ? `Spawn an agent with ${triggerCliOption.label}, ${selectedAgentPermissionOption.label}`
                    : withShortcut(
                        `Spawn ${selectedSpecialistAction.label} specialist with ${triggerCliOption.label}, ${selectedAgentPermissionOption.label}`,
                        getSpecialistCommandId(selectedSpecialistAction.id)
                          ? shortcutFor(getSpecialistCommandId(selectedSpecialistAction.id)!)
                          : null,
                      )
                }
              >
                <button
                  onClick={() => {
                    if (!launchableCli) return
                    if (standardSpawnIsGeneral) {
                      void addNewGeneralAgent(launchableCli)
                    } else {
                      void addNewSpecialist(launchableCli)
                    }
                  }}
                  disabled={!activeWorkspaceId || !launchableCli}
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-l-[5px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-selected)] hover:text-[color:var(--text-strong)] disabled:opacity-40 disabled:hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
                  aria-label={
                    // The roleless spawn has no role to name it, so its
                    // accessible name is the engine it launches — which is also
                    // the glyph on the button, and how the composer's own
                    // roleless row reads.
                    standardSpawnIsGeneral
                      ? `Spawn an agent with ${triggerCliOption.label}`
                      : `Spawn ${selectedSpecialistAction.label} specialist`
                  }
                >
                  {standardSpawnIsGeneral ? (
                    // A roleless agent has no specialist glyph; mirror the
                    // composer's roleless row, which wears its bound CLI icon.
                    <CliIcon cli={triggerCli} className="size-icon-md" />
                  ) : (
                    <SpecialistActionIcon
                      icon={selectedSpecialistAction.icon}
                      className="size-icon-md"
                    />
                  )}
                </button>
              </Tooltip>
              <span
                className="inline-flex h-8 items-center border-l border-[color:var(--color-6)] px-1.5 text-[color:var(--text-strong)]"
                aria-hidden="true"
                // design-tokens-allow: non-interactive identity badge span; aria-hidden so hover affordance is documented decoration, not an interactive control
                title={`Default CLI: ${triggerCliOption.label}`}
              >
                <CliIcon cli={triggerCli} className="icon-sm" />
              </span>
              <Popover
                open={specialistMenuOpen}
                onOpenChange={(next) => setSpecialistMenuOpen(next)}
                ariaLabel="Spawn agent"
                popupRole="menu"
                placement="bottom-end"
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <Tooltip content="Spawn agent" placement="bottom">
                    <button
                      ref={ref}
                      onClick={togglePopover}
                      disabled={!activeWorkspaceId}
                      className={`inline-flex h-8 w-6 items-center justify-center rounded-r-[5px] border-l border-[color:var(--color-6)] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-selected)] hover:text-[color:var(--text-strong)] disabled:opacity-40 disabled:hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
                      aria-label="Spawn agent"
                      {...triggerProps}
                    >
                      <svg className={`icon-sm transition-transform ${specialistMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </Tooltip>
                )}
              >
                <AgentComposerPopover
                  conversationAvailable={conversationSpawnAvailable}
                  initialSelection={composerInitialSelection}
                  action={{
                    kind: 'spawn',
                    onSpawn: runComposerSpawn,
                    permissionPreset: agentSpawnPermissionPreset,
                    onChangePermissionPreset: setAgentSpawnPermissionPreset,
                    debugMode: agentSpawnDebugMode,
                    onChangeDebugMode: setAgentSpawnDebugMode,
                  }}
                  onClose={() => setSpecialistMenuOpen(false)}
                />
              </Popover>
            </div>
          </div>
          )
        })() : null}
        {/* Account + Settings relocated to the sidebar bottom (SidebarAccountBar,
            Cursor-parity). The former `account-and-settings` top-bar group is
            retired; see knowledge/brand/panel-design-system.md TopBar inventory. */}
      </div>
  )
}
