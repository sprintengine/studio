import React from 'react'
import { SpecialistActionIcon, SprintEngineRoleIcon, WorkspaceTypeIcon, resolveEnabledWorkspaceType } from '../AppIcons'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { ChangePulse, FOCUS_RING_CLASS, Popover, StarGlyph, StatusDot, TONE_COLOR_VAR, TONE_SOFT_VAR, Tooltip } from '../ui'
import type { SessionUser } from '../../../../shared/electron-api'
import { hasActiveProPlan } from './workspaceManagerHelpers'
import CliIcon from '../CliIcon'
import SpawnAgentMenu, { AGENT_SPAWN_PERMISSION_OPTIONS, TerminalSessionIcon } from './SpawnAgentMenu'
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
import { getHighlightSwatch, getWorkspaceAccentHex, isStarred } from '../../utils/highlight'
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
  status: 'needs-input' | 'working'
  role: NonNullable<Workspace['sprintEngineState']>['sprintEngineAgents'][string]['role'] | null
  specialistId: SpecialistActionId | null
  multiloopRole: MultiloopRole | null
  taskId: string | null
  sessionId: string
}

// Tab accent comes from the enabled workspace type's accentToken; a disabled
// module, an unknown id, or shell-owned 'standard' falls back to the muted
// default. Matches the prior per-mode mapping for the bundled types while
// degrading disabled-module workspaces to the generic accent (AC4).
function workspaceTabIconClass(mode: Workspace['mode'], moduleOverrides: ModuleEnablementOverrides): string {
  const token = resolveEnabledWorkspaceType(mode, moduleOverrides)?.accentToken ?? '--text-muted'
  return `text-[color:var(${token})]`
}

function sessionAgentTypeLabel(item: SessionItem): string | null {
  if (item.specialistId) return getSpecialistAction(item.specialistId).shortLabel
  if (item.multiloopRole) return getMultiloopRole(item.multiloopRole).shortLabel
  return null
}

function formatShortDate(value: string | null): string {
  if (!value) return 'soon'
  return new Date(value).toLocaleString()
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

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9.25 4.25L9.9 2.9h4.2l.65 1.35a1.8 1.8 0 0 0 2.2.92l1.43-.48 2.1 3.64-1.12 1a1.8 1.8 0 0 0 0 2.68l1.12 1-2.1 3.64-1.43-.48a1.8 1.8 0 0 0-2.2.92l-.65 1.35H9.9l-.65-1.35a1.8 1.8 0 0 0-2.2-.92l-1.43.48-2.1-3.64 1.12-1a1.8 1.8 0 0 0 0-2.68l-1.12-1 2.1-3.64 1.43.48a1.8 1.8 0 0 0 2.2-.92Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11.67" r="3" stroke="currentColor" strokeWidth="1.65" />
    </svg>
  )
}


function SessionsPopover({
  items,
  workspaceOrder,
  onOpen,
  onStop,
  onStopWorkspace,
}: {
  items: SessionItem[]
  workspaceOrder: Map<string, number>
  onOpen: (item: SessionItem) => void | Promise<void>
  onStop: (item: SessionItem) => void
  onStopWorkspace: (workspace: Workspace, items: SessionItem[]) => void | Promise<void>
}) {
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
                  <span className="min-w-0 truncate">{group.workspace.name}</span>
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
                  {group.items.map((item) => {
                    const chipStyle = item.role
                      ? {
                          borderColor: getSprintEngineRoleAccent(item.role),
                          color: getSprintEngineRoleAccent(item.role),
                          backgroundColor: `${getSprintEngineRoleAccent(item.role)}14`,
                        }
                      : undefined
                    const typeLabel = sessionAgentTypeLabel(item)
                    const sublineParts = item.kind === 'terminal'
                      ? [item.label.toLowerCase()]
                      : [typeLabel, item.taskId, item.cli].filter((value): value is string => Boolean(value))
                    const subline = sublineParts.join(' · ') || item.cli
                    return (
                      <div
                        key={`${item.workspace.id}:${item.agentId ?? item.terminalId ?? item.sessionId}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded px-2.5 py-2 text-[13px] text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)]"
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
                              <span className="truncate font-medium text-[color:var(--text-strong)]">{item.label}</span>
                              <StatusDot
                                tone={item.status === 'needs-input' ? 'warn' : 'good'}
                                pulse
                                label={item.status === 'needs-input' ? 'Needs input' : 'Working'}
                              />
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-[color:var(--text-subtle)]">
                              {subline}
                            </span>
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => void onOpen(item)}
                          className="h-7 rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-2.5 text-[12px] font-semibold text-[color:var(--text-default)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)]"
                        >
                          Open
                        </button>

                        <Tooltip content="Stop">
                          <button
                            type="button"
                            onClick={() => onStop(item)}
                            className="flex h-7 w-7 items-center justify-center rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--tone-error-soft)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)]"
                            aria-label={`Stop ${item.label}`}
                          >
                            <StopIcon className="icon-sm" />
                          </button>
                        </Tooltip>
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

function accountInitials(user: SessionUser | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || ''
  if (!source) return '?'
  const words = source.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return source[0].toUpperCase()
}

type AccountTier = 'free' | 'pro'

// Tier drives the colour of the account glyph: gold for an active Pro plan,
// green otherwise (free, trial, or entitlements not yet resolved).
function accountTier(authState: MulticodeAuthState): AccountTier {
  return hasActiveProPlan(authState) ? 'pro' : 'free'
}

const ACCOUNT_TIER_STYLE: Record<AccountTier, { color: string; soft: string; label: string }> = {
  free: { color: TONE_COLOR_VAR.good, soft: TONE_SOFT_VAR.good, label: 'Free' },
  pro: { color: TONE_COLOR_VAR.warn, soft: TONE_SOFT_VAR.warn, label: 'Pro' },
}

// Neutral person glyph shown when no display name/email initials are available,
// so a signed-in account still reads as a coloured tier badge rather than a "?".
function AccountUserGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.4" r="3.5" stroke="currentColor" strokeWidth={1.7} />
      <path
        d="M5.6 19c0-3.3 2.9-5.4 6.4-5.4s6.4 2.1 6.4 5.4"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
    </svg>
  )
}

function sentenceCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1).replace(/_/g, ' ') : value
}

function AccountMenuItem({ onSelect, children }: { onSelect: () => void; children: React.ReactNode }) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const surface = event.currentTarget.closest('[data-account-menu="true"]')
    if (!surface) return
    const items = Array.from(surface.querySelectorAll<HTMLButtonElement>('[data-account-item="true"]'))
    if (items.length === 0) return
    const idx = items.indexOf(event.currentTarget)
    const next = event.key === 'Home'
      ? items[0]
      : event.key === 'End'
        ? items[items.length - 1]
        : items[(idx + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
  }
  return (
    <button
      type="button"
      role="menuitem"
      data-account-item="true"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
    >
      {children}
    </button>
  )
}

function AccountPopover({
  authState,
  message,
  onCheckAccess,
  onLogout,
  onUpgrade,
}: {
  authState: MulticodeAuthState
  message: string | null
  onCheckAccess: () => void
  onLogout: () => void
  onUpgrade: () => void
}) {
  const plan = authState.entitlements?.plan ?? null
  const planLabel = plan
    ? plan.status === 'active' ? `${sentenceCase(plan.code)} plan` : sentenceCase(plan.status)
    : null
  const metaLine = [planLabel, authState.selectedOrganization?.name]
    .filter(Boolean)
    .join(' · ')
  const primaryLine = authState.user?.displayName ?? authState.user?.email ?? 'Multicode account'
  const email = authState.user?.displayName ? authState.user?.email : null
  const accessStale = Boolean(message) || authState.entitlementStatus !== 'fresh'

  return (
    <div data-account-menu="true" className="w-64 overflow-hidden">
      <div className="px-3 pb-2.5 pt-3">
        <div className="truncate text-[13px] font-medium text-[color:var(--text-strong)]">{primaryLine}</div>
        {email ? (
          <div className="mt-0.5 truncate text-[12px] text-[color:var(--text-muted)]">{email}</div>
        ) : null}
        {metaLine ? (
          <div className="mt-1 truncate text-[11px] text-[color:var(--text-subtle)]">{metaLine}</div>
        ) : null}
      </div>

      {message || authState.entitlementStatus === 'offline_grace' ? (
        <div className="border-t border-[color:var(--border-subtle)] px-3 py-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
          {message ?? `Offline access expires ${formatShortDate(authState.graceExpiresAt)}.`}
        </div>
      ) : null}

      {!hasActiveProPlan(authState) || accessStale ? (
        <div className="border-t border-[color:var(--border-subtle)] py-1">
          {!hasActiveProPlan(authState) ? (
            <AccountMenuItem onSelect={onUpgrade}>Upgrade to Pro</AccountMenuItem>
          ) : null}
          {accessStale ? (
            <AccountMenuItem onSelect={onCheckAccess}>Check access again</AccountMenuItem>
          ) : null}
        </div>
      ) : null}
      <div className="border-t border-[color:var(--border-subtle)] py-1">
        <AccountMenuItem onSelect={onLogout}>Sign out</AccountMenuItem>
      </div>
    </div>
  )
}

export type WorkspaceTopBarProps = {
  workspaces: Workspace[]
  activeWorkspace: Workspace | null
  activeWorkspaceId: string | null
  workspaceActionsEnabled: boolean | null

  sessionsRef: React.RefObject<HTMLDivElement>
  viewMenuRef: React.RefObject<HTMLDivElement>
  notificationsRef: React.RefObject<HTMLDivElement>
  specialistMenuRef: React.RefObject<HTMLDivElement>
  accountRef: React.RefObject<HTMLDivElement>

  sessions: SessionItem[]
  sidebarWorkspaceOrder: Map<string, number>
  sessionsOpen: boolean
  setSessionsOpen: React.Dispatch<React.SetStateAction<boolean>>
  openSession: (item: SessionItem) => void | Promise<void>
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
  handleSelectSpecialist: (id: SpecialistActionId, cli: AgentCli) => void
  handleSelectMultiloopRole: (role: MultiloopRole, cli: AgentCli) => void
  addNewSpecialist: (cli: AgentCli) => void | Promise<void>
  addNewMultiloopAgent: (cli: AgentCli) => void | Promise<void>
  addNewCliAgent: (cli: AgentCli, label: string) => void
  addNewTerminal: () => void
  // Conversation runtime spawn collapses to one entry: the model is picked in
  // the chat composer, so the menu only needs to know whether a default
  // provider/model is available and how to open it.
  conversationSpawnAvailable: boolean
  onSpawnConversationAgent: () => void
  // Open-in-new-chat: spawn the row's agent in a fresh workspace (inheriting the
  // current folder) instead of the active one. Surfaced in each row's flyout.
  onOpenTerminalInNewChat: () => void
  onOpenGeneralInNewChat: (cli: AgentCli) => void
  onOpenConversationInNewChat: () => void
  onOpenSpecialistInNewChat: (id: SpecialistActionId, cli: AgentCli) => void

  openSettings: (checkForUpdates?: boolean, targetTab?: string | null) => void
  settingsOpen: boolean

  accountOpen: boolean
  setAccountOpen: React.Dispatch<React.SetStateAction<boolean>>
  authState: MulticodeAuthState
  authMessage: string | null
  startLogin: () => void | Promise<void>
  refreshAuthState: () => void | Promise<void>
  logout: () => void | Promise<void>
}

export default function WorkspaceTopBar({
  workspaces,
  activeWorkspace,
  activeWorkspaceId,
  workspaceActionsEnabled,
  sessionsRef,
  viewMenuRef,
  notificationsRef,
  specialistMenuRef,
  accountRef,
  sessions,
  sidebarWorkspaceOrder,
  sessionsOpen,
  setSessionsOpen,
  openSession,
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
  handleSelectSpecialist,
  handleSelectMultiloopRole,
  addNewSpecialist,
  addNewMultiloopAgent,
  addNewCliAgent,
  addNewTerminal,
  conversationSpawnAvailable,
  onSpawnConversationAgent,
  onOpenTerminalInNewChat,
  onOpenGeneralInNewChat,
  onOpenConversationInNewChat,
  onOpenSpecialistInNewChat,
  openSettings,
  settingsOpen,
  accountOpen,
  setAccountOpen,
  authState,
  authMessage,
  startLogin,
  refreshAuthState,
  logout,
}: WorkspaceTopBarProps) {
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
      <div
        className="flex h-[48px] shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] px-3 transition-colors"
        style={
          activeWorkspace?.highlight?.color
            ? { borderBottomColor: getHighlightSwatch(activeWorkspace.highlight.color).ringRgba(0.18) }
            : undefined
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {activeWorkspace ? (
            <>
              <span
                className={`shrink-0 ${activeWorkspace.highlight?.color ? '' : workspaceTabIconClass(activeWorkspace.mode, moduleOverrides)}`}
                style={{
                  color: activeWorkspace.highlight?.color
                    ? getHighlightSwatch(activeWorkspace.highlight.color).hex
                    : undefined,
                }}
              >
                <WorkspaceTypeIcon
                  mode={activeWorkspace.mode}
                  moduleOverrides={moduleOverrides}
                  className="icon-sm"
                />
              </span>
              {activeWorkspace.highlight?.starred ? (
                <StarGlyph
                  filled
                  className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
                  label="Starred workspace"
                />
              ) : null}
              <span className="min-w-0 truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
                {activeWorkspace.name}
              </span>
              {activeWorkspace.folderPath ? (
                <span className="hidden min-w-0 truncate text-[12px] text-[color:var(--text-disabled)] md:inline">
                  · {activeWorkspace.folderPath}
                </span>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/*
           * WorkspaceTopBar at-rest control inventory — capped at five groups.
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
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
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
                      <ChangePulse value={sessions.length} mode="increase" tint="var(--tone-good)" className="inline-flex">
                        <SessionsIcon className="h-[18px] w-[18px]" />
                      </ChangePulse>
                      {sessions.length > 0 ? (
                        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[color:var(--bg-app)] bg-[color:var(--tone-good)] px-1 text-[10px] font-bold leading-none tabular-nums text-[color:var(--bg-app)]">
                          {sessions.length > 99 ? '99+' : sessions.length}
                        </span>
                      ) : null}
                    </button>
                  </Tooltip>
                )}
              >
                <SessionsPopover
                  items={sessions}
                  workspaceOrder={sidebarWorkspaceOrder}
                  onOpen={openSession}
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
                    setAccountOpen(false)
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
                        <span className="min-w-0 flex-1 truncate">{view.name}</span>
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
                  setAccountOpen(false)
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
                  <SpawnAgentMenu
                    multiloopLaunchMenu={multiloopLaunchMenu}
                    conversationSpawnAvailable={conversationSpawnAvailable}
                    agentSpawnPermissionPreset={agentSpawnPermissionPreset}
                    onChangeAgentSpawnPermissionPreset={setAgentSpawnPermissionPreset}
                    onSpawnTerminal={addNewTerminal}
                    onSpawnGeneral={(cli) => addNewCliAgent(cli, 'General Agent')}
                    onSpawnConversation={onSpawnConversationAgent}
                    onSpawnSpecialist={handleSelectSpecialist}
                    onSpawnMultiloopRole={handleSelectMultiloopRole}
                    showOpenInNewChat
                    onOpenTerminalInNewChat={onOpenTerminalInNewChat}
                    onOpenGeneralInNewChat={onOpenGeneralInNewChat}
                    onOpenConversationInNewChat={onOpenConversationInNewChat}
                    onOpenSpecialistInNewChat={onOpenSpecialistInNewChat}
                    onClose={() => setSpecialistMenuOpen(false)}
                  />
                </Popover>
              </div>
            </div>
            )
          })() : null}

          {/* top-bar-group: account-and-settings */}
          <div ref={accountRef} className="relative inline-flex">
            {authState.authenticated ? (
              <Popover
                open={accountOpen}
                onOpenChange={(next) => {
                  setAccountOpen(next)
                  if (next) {
                    setSessionsOpen(false)
                    setSpecialistMenuOpen(false)
                    setNotificationsOpen(false)
                  }
                }}
                ariaLabel="Account"
                popupRole="menu"
                placement="bottom-end"
                onOpenAutoFocus={(surface) => {
                  surface.querySelector<HTMLButtonElement>('[data-account-item="true"]')?.focus()
                }}
                renderTrigger={({ ref, triggerProps, togglePopover }) => {
                  const tier = accountTier(authState)
                  const tierStyle = ACCOUNT_TIER_STYLE[tier]
                  const initials = accountInitials(authState.user)
                  return (
                    <Tooltip content={`Account · ${tierStyle.label}`} placement="bottom">
                      <button
                        ref={ref}
                        type="button"
                        onClick={togglePopover}
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                          accountOpen
                            ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)]'
                            : 'border-transparent hover:bg-[color:var(--bg-hover)]'
                        }`}
                        aria-label={`Account · ${tierStyle.label} plan`}
                        {...triggerProps}
                      >
                        <span
                          aria-hidden="true"
                          className="flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold"
                          style={{
                            borderColor: tierStyle.color,
                            backgroundColor: tierStyle.soft,
                            color: tierStyle.color,
                          }}
                        >
                          {initials === '?' ? <AccountUserGlyph className="icon-sm" /> : initials}
                        </span>
                      </button>
                    </Tooltip>
                  )
                }}
              >
                <AccountPopover
                  authState={authState}
                  message={authMessage}
                  onCheckAccess={() => void refreshAuthState()}
                  onLogout={() => void logout()}
                  onUpgrade={() => {
                    setAccountOpen(false)
                    void window.api.authOpenUpgrade('sprintengine')
                  }}
                />
              </Popover>
            ) : (
              <button
                type="button"
                onClick={() => void startLogin()}
                disabled={authState.status === 'checking'}
                className="inline-flex h-8 items-center rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-3 text-[12px] font-semibold text-[color:var(--text-default)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[color:var(--bg-selected)] disabled:hover:bg-[color:var(--bg-surface-raised)] disabled:hover:text-[color:var(--text-default)]"
                aria-busy={authState.status === 'checking'}
              >
                Sign in
              </button>
            )}
          </div>

          <Tooltip content={withShortcut('Settings', shortcutFor('app.settings.open'))} placement="bottom">
            <button
              type="button"
              onClick={() => openSettings(false)}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                settingsOpen
                  ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                  : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
              }`}
              aria-label="Settings"
              aria-pressed={settingsOpen}
            >
              <GearIcon className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
        </div>
      </div>
  )
}
