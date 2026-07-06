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
import { ChangePulse, Popover, StarGlyph, StatusDot, Tooltip, TruncatedText } from '../ui'
import {
  compareSessionItemsByAttention,
  sessionsAttentionTone,
} from './workspaceManagerHelpers'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import CliIcon from '../CliIcon'
import { AGENT_SPAWN_PERMISSION_OPTIONS, TerminalSessionIcon } from './agentComposer/agentSpawnShared'
import AgentComposerPopover from './agentComposer/AgentComposerPopover'
import { type AgentComposerConfirm, type AgentComposerSelection } from './agentComposer/AgentComposer'
import {
  getMultiloopRole,
  getSpecialistAction,
  type MultiloopRoleDescriptor,
  type SpecialistAction,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AppNotification,
  MultiloopRole,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
  Workspace,
} from '../../types/workspace'
import { resolveAvailableAgentCli, type AgentCliCatalogOption } from './newWorkspace/cliRuntimeOptions'
import { hasComponentTab, toggleComponentTab } from '../../utils/modelRegistry'
import { getWorkspaceAccentHex, isStarred } from '../../utils/highlight'
import { getSprintEngineRoleAccent } from '../../utils/sprintengine'
import { NotificationsPopover, type NotificationRowAction } from './topbar/NotificationsPopover'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  getEffectiveKeybindingLabel,
  getSpecialistCommandId,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'

export type SessionItem = {
  workspace: Workspace
  kind: TerminalKind
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
  multiloopRole: MultiloopRole | null
  taskId: string | null
  sessionId: string
}

function sessionAgentTypeLabel(item: SessionItem): string | null {
  if (item.specialistId) return getSpecialistAction(item.specialistId).shortLabel
  if (item.multiloopRole) return getMultiloopRole(item.multiloopRole).shortLabel
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
  if (item.multiloopRole) {
    const descriptor = getMultiloopRole(item.multiloopRole)
    return <SpecialistActionIcon icon={descriptor.icon} className={className} />
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

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3.25" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.75 11.5a6.25 6.25 0 0 0 12.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 17.75V20.5M8.75 20.5h6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
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
  onStopWorkspace,
}: {
  items: SessionItem[]
  workspaceOrder: Map<string, number>
  onOpen: (item: SessionItem) => void | Promise<void>
  onPause: (item: SessionItem) => void
  onStop: (item: SessionItem) => void
  onStopWorkspace: (workspace: Workspace, items: SessionItem[]) => void | Promise<void>
}) {
  // Re-render every 30s so relative times ("idle · 12m") stay fresh while open.
  const now = useRelativeNow(30_000)
  const groups = items
    .reduce<Array<{ workspace: Workspace; items: SessionItem[] }>>((acc, item) => {
      const group = acc.find((candidate) => candidate.workspace.id === item.workspace.id)
      if (group) {
        group.items.push(item)
      } else {
        acc.push({ workspace: item.workspace, items: [item] })
      }
      return acc
    }, [])
    .sort((a, b) => {
      const aIdx = workspaceOrder.get(a.workspace.id) ?? Number.MAX_SAFE_INTEGER
      const bIdx = workspaceOrder.get(b.workspace.id) ?? Number.MAX_SAFE_INTEGER
      return aIdx - bIdx
    })

  return (
    <div className="w-[420px] overflow-hidden p-1">
      <div className="flex h-9 items-center justify-between border-b border-[color:var(--border-default)] px-2.5">
        <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">
          Sessions
        </span>
        {items.length > 0 ? (
          <span className="rounded bg-[color:var(--bg-hover)] px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--text-muted)]">
            {items.length}
          </span>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="px-2.5 py-3 text-[13px] text-[color:var(--text-disabled)]">No sessions</div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto py-1">
          {groups.map((group) => {
            const accent = getWorkspaceAccentHex(group.workspace)
            const starred = isStarred(group.workspace.highlight)
            const headerColor = accent ?? 'var(--text-subtle)'
            return (
              <div key={group.workspace.id} className="relative py-1 pl-2">
                {accent ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-2 left-0 w-[2px] rounded-full"
                    style={{ background: accent }}
                  />
                ) : null}
                <div
                  className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] font-semibold"
                  style={{ color: headerColor }}
                >
                  <WorkspaceTypeIcon mode={group.workspace.mode} className="h-3.5 w-3.5 shrink-0" />
                  <TruncatedText as="span" text={group.workspace.name} className="min-w-0" />
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
                      onClick={() => void onStopWorkspace(group.workspace, group.items)}
                      className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded border border-transparent px-1.5 text-[11px] font-medium text-[color:var(--text-subtle)] transition-colors hover:border-[color:var(--tone-error-soft)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)]"
                      aria-label={`Stop all ${group.items.length} sessions in ${group.workspace.name}`}
                    >
                      <StopIcon className="icon-xs" />
                      Stop all
                    </button>
                  ) : null}
                </div>
                <div className="space-y-1">
                  {group.items.slice().sort(compareSessionItemsByAttention).map((item) => {
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
                        key={`${item.workspace.id}:${item.agentId ?? item.terminalId ?? item.sessionId}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded px-2.5 py-2 text-[13px] text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)]"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
                            style={chipStyle}
                          >
                            <SessionAgentIcon item={item} className="h-[17px] w-[17px]" />
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
                              className="mt-0.5 block text-[11px] text-[color:var(--text-subtle)]"
                            />
                          </span>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void onOpen(item)}
                          className="h-7 rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-2.5 text-[12px] font-semibold text-[color:var(--text-default)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)]"
                        >
                          Open
                        </button>

                        {item.kind === 'agent' && item.status !== 'failed' ? (
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
  stopWorkspaceSessions: (workspace: Workspace, items: SessionItem[]) => void | Promise<void>

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

  /** Voice dictation (gated on the voice-dictation module). */
  voiceDictationEnabled: boolean
  voiceRecording: boolean
  voiceTranscribing: boolean
  toggleVoiceDictation: () => void

  specialistMenuOpen: boolean
  setSpecialistMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  multiloopLaunchMenu: boolean
  selectedSpecialistAction: SpecialistAction
  selectedMultiloopRoleDescriptor: MultiloopRoleDescriptor
  selectedAgentPermissionOption: typeof AGENT_SPAWN_PERMISSION_OPTIONS[number]
  lastSelectedCli: AgentCli
  // Per-agent CLI choice (e.g. Architect → Codex) used by the split-button
  // trigger's default-spawn icon and CLI badge. The menu reads these from the
  // store itself; the trigger needs them to resolve its default spawn.
  specialistCliDefaults: Partial<Record<SpecialistActionId, AgentCli>>
  multiloopRoleCliDefaults: Partial<Record<MultiloopRole, AgentCli>>
  // Plugin-aware agent CLI catalog (bundled + configured cliRuntimes). The
  // trigger resolves its default CLI against this list.
  agentCliOptions: AgentCliCatalogOption[]
  agentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  setAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  // Transient Debug Mode toggle, forwarded to the spawn menu's mode row.
  agentSpawnDebugMode: boolean
  setAgentSpawnDebugMode: (next: boolean) => void
  // Primary split-button half: spawn the remembered specialist / multiloop role
  // straight into the active workspace with the trigger CLI.
  addNewSpecialist: (cli: AgentCli) => void | Promise<void>
  addNewMultiloopAgent: (cli: AgentCli) => void | Promise<void>
  // The dropdown renders the shared AgentComposerPopover. `conversationAvailable`
  // gates its Conversation row; `composerInitialSelection` preselects the
  // remembered agent; `runComposerSpawn` maps a confirm to the real spawn into
  // the active workspace.
  conversationSpawnAvailable: boolean
  composerInitialSelection: AgentComposerSelection
  runComposerSpawn: (confirm: AgentComposerConfirm) => void
}

export function WorkspaceActions({
  workspaces,
  activeWorkspace,
  activeWorkspaceId,
  workspaceActionsEnabled,
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
  stopWorkspaceSessions,
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
  voiceDictationEnabled,
  voiceRecording,
  voiceTranscribing,
  toggleVoiceDictation,
  specialistMenuOpen,
  setSpecialistMenuOpen,
  multiloopLaunchMenu,
  selectedSpecialistAction,
  selectedMultiloopRoleDescriptor,
  selectedAgentPermissionOption,
  lastSelectedCli,
  specialistCliDefaults,
  multiloopRoleCliDefaults,
  agentCliOptions,
  agentSpawnPermissionPreset,
  setAgentSpawnPermissionPreset,
  agentSpawnDebugMode,
  setAgentSpawnDebugMode,
  addNewSpecialist,
  addNewMultiloopAgent,
  conversationSpawnAvailable,
  composerInitialSelection,
  runComposerSpawn,
}: WorkspaceActionsProps) {
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
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
                    className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                      sessionsOpen
                        ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                        : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                    }`}
                    aria-label="Sessions"
                    {...triggerProps}
                  >
                    <ChangePulse value={sessions.length} mode="increase" tint={`var(--tone-${sessionsTone})`} className="inline-flex">
                      <SessionsIcon className="h-[18px] w-[18px]" />
                    </ChangePulse>
                    {sessions.length > 0 ? (
                      <span
                        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[color:var(--bg-app)] px-1 text-[10px] font-bold leading-none tabular-nums text-[color:var(--bg-app)]"
                        style={{ backgroundColor: `var(--tone-${sessionsTone})` }}
                      >
                        {sessions.length > 99 ? '99+' : sessions.length}
                      </span>
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
                onStopWorkspace={stopWorkspaceSessions}
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
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 transition-colors ${
                      viewMenuOpen
                        ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                        : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                    }`}
                    aria-label="Toggle workspace panels"
                    {...triggerProps}
                  >
                    <svg className="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="2" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.4" />
                      <rect x="9" y="2" width="5" height="6" rx="1" stroke="currentColor" strokeWidth="1.4" />
                      <rect x="9" y="10" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                    <span className="text-[12px] font-semibold">{activeWorkspaceViews?.label ?? 'View'}</span>
                    <svg className={`icon-xs transition-transform ${viewMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </Tooltip>
              )}
            >
              <div className="w-60 overflow-hidden p-1">
                <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-[color:var(--text-muted)]">
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
                      className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-[13px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked
                            ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--bg-app)]'
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
            popupRole="menu"
            placement="bottom-end"
            renderTrigger={({ ref, triggerProps, togglePopover }) => (
              <Tooltip content="Notifications" placement="bottom">
                <button
                  ref={ref}
                  type="button"
                  onClick={togglePopover}
                  className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                    notificationsOpen
                      ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                      : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                  }`}
                  aria-label="Notifications"
                  {...triggerProps}
                >
                  <ChangePulse value={unreadErrorCount} mode="increase" tint="var(--tone-error)" className="inline-flex">
                    <NotificationBellIcon className="h-[18px] w-[18px]" />
                  </ChangePulse>
                  {unreadErrorCount > 0 ? (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[color:var(--bg-app)] bg-[color:var(--tone-error)] px-1 text-[10px] font-bold leading-none tabular-nums text-[color:var(--bg-app)]">
                      {unreadErrorCount > 99 ? '99+' : unreadErrorCount}
                    </span>
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

        {voiceDictationEnabled ? (
          <Tooltip
            content={
              voiceRecording
                ? withShortcut('Stop voice transcription', shortcutFor('voice.toggle'))
                : voiceTranscribing
                  ? 'Transcribing…'
                  : withShortcut('Start voice transcription', shortcutFor('voice.toggle'))
            }
            placement="bottom"
          >
            <button
              type="button"
              onClick={toggleVoiceDictation}
              disabled={voiceTranscribing}
              aria-label={voiceRecording ? 'Stop voice transcription' : 'Start voice transcription'}
              aria-pressed={voiceRecording}
              className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:opacity-60 ${
                voiceRecording
                  ? 'border-[color:var(--tone-error)] bg-[color:var(--bg-hover)] text-[color:var(--tone-error)]'
                  : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
              }`}
            >
              <MicIcon className="h-[18px] w-[18px]" />
              {voiceRecording ? (
                <span className="absolute -right-1 -top-1">
                  <StatusDot tone="error" pulse label="Recording" />
                </span>
              ) : null}
            </button>
          </Tooltip>
        ) : null}

        {/* top-bar-group: agent-spawn */}
        {workspaceActionsEnabled ? (() => {
          // Constrain a remembered CLI to one that is actually installed. When
          // the catalog is empty (registry still loading or no agent plugins)
          // this preserves the passed id rather than throwing on an empty list.
          const resolvePickerCli = (cli: AgentCli): AgentCli =>
            resolveAvailableAgentCli(cli, agentCliOptions, agentCliOptions[0]?.value ?? cli)
          const triggerCli: AgentCli = resolvePickerCli(
            multiloopLaunchMenu
              ? (multiloopRoleCliDefaults[selectedMultiloopRoleDescriptor.role] ?? lastSelectedCli)
              : (specialistCliDefaults[selectedSpecialistAction.id] ?? lastSelectedCli)
          )
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
                  multiloopLaunchMenu
                    ? `Spawn Multiloop ${selectedMultiloopRoleDescriptor.label} with ${triggerCliOption.label}, ${selectedAgentPermissionOption.label}`
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
                    if (multiloopLaunchMenu) {
                      void addNewMultiloopAgent(triggerCliOption.value)
                    } else {
                      void addNewSpecialist(triggerCliOption.value)
                    }
                  }}
                  disabled={!activeWorkspaceId}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-l-[5px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-selected)] hover:text-[color:var(--text-strong)] disabled:opacity-40 disabled:hover:bg-[color:var(--bg-hover)]"
                  aria-label={
                    multiloopLaunchMenu
                      ? `Spawn Multiloop ${selectedMultiloopRoleDescriptor.label}`
                      : `Spawn ${selectedSpecialistAction.label} specialist`
                  }
                >
                  <SpecialistActionIcon
                    icon={multiloopLaunchMenu ? selectedMultiloopRoleDescriptor.icon : selectedSpecialistAction.icon}
                    className="h-[18px] w-[18px]"
                  />
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
                      className="inline-flex h-8 w-6 items-center justify-center rounded-r-[5px] border-l border-[color:var(--color-6)] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-selected)] hover:text-[color:var(--text-strong)] disabled:opacity-40 disabled:hover:bg-[color:var(--bg-hover)]"
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
                  roster={multiloopLaunchMenu ? 'multiloop' : 'specialist'}
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
