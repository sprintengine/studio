import React from 'react'
import { SpecialistActionIcon, SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import { Popover, StatusDot, Tooltip } from '../ui'
import CliIcon from '../CliIcon'
import {
  MULTILOOP_ROLES,
  SPECIALIST_ACTIONS,
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
import { hasComponentTab, toggleComponentTab } from '../../utils/modelRegistry'
import { getHighlightSwatch, getWorkspaceAccentHex, isStarred } from '../../utils/highlight'
import { getSprintEngineRoleAccent } from '../../utils/sprintengine'
import { NotificationsPopover } from './topbar/NotificationsPopover'
import WorkspaceGitStatusButton from './WorkspaceGitStatusButton'

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

export type ChipPopoverForRole =
  | { kind: 'specialist'; id: SpecialistActionId }
  | { kind: 'multiloop'; role: MultiloopRole }
  | null

type ViewItem = { component: string; name: string }
// Sprint Engine intentionally has no entry: Inbox / Roster / Tasks render as
// an icon-led sub-nav at the top of the SprintEngineBoardPanel (Linear-style
// underline-on-active), not as workspace top-bar chrome or FlexLayout tabs.
const VIEWS_FOR_MODE: Record<string, { label: string; views: ViewItem[] }> = {
  multiloop: {
    label: 'Multiloop',
    views: [
      { component: 'multiloop-board', name: 'Multiloop' },
    ],
  },
}

export const AGENT_SPAWN_CLI_OPTIONS: Array<{ value: AgentCli; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
]
export const AGENT_SPAWN_PERMISSION_OPTIONS: Array<{
  value: SprintEngineCliPermissionPreset
  label: string
  title: string
}> = [
  {
    value: 'default',
    label: 'Default permissions',
    title: 'Use the CLI default permission behavior.',
  },
  {
    value: 'auto_workspace',
    label: 'Auto in workspace',
    title: 'Reduce prompts while keeping workspace-scoped guardrails where the CLI supports them.',
  },
  {
    value: 'bypass_all',
    label: 'Bypass permissions',
    title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
]

function shortcutLabel(shortcut: string): string {
  if (window.api.platform !== 'darwin') return shortcut
  return shortcut
    .replace(/\bCtrl\b/g, 'Cmd')
    .replace(/\bAlt\b/g, 'Option')
}

function workspaceTabIconClass(mode: Workspace['mode']): string {
  if (mode === 'sprintengine') return 'text-[color:var(--tool-sprintengine)]'
  if (mode === 'switchboard') return 'text-[color:var(--tool-switchboard)]'
  if (mode === 'guided-brief') return 'text-[color:var(--accent-primary)]'
  return 'text-[color:var(--text-muted)]'
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

function TerminalSessionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7.25 10L10 12.5L7.25 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
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

function MemoryGraphIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M19.95 11.3c0-4.05-3.1-6.95-7.35-6.95-3.55 0-6.25 1.82-6.85 4.62-1.4.76-2.15 2.08-2.15 3.62 0 2.45 1.92 4.32 4.62 4.32h1.88c.92 0 1.66.74 1.66 1.66v1.1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19.95 11.3c0 1.42-.62 2.65-1.76 3.45-.72.5-1.08 1.08-1.08 1.82v.92"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.38 9.35c.5-1.28 1.72-2 3.02-1.78M10.4 7.57c.7-1.04 2.18-1.48 3.38-.85M13.78 6.72c1.32-.3 2.72.42 3.28 1.62"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.1 12.18c.7-1.1 2.18-1.42 3.28-.7M9.38 11.48c.66-.9 2.02-1.12 3-.48M12.38 11c.84-.92 2.38-.9 3.35.04"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.22 14.68c1.08-.48 2.48-.18 3.18.7M10.4 15.38c.84-.62 2.08-.52 2.82.26M13.22 15.64c.8-.62 1.98-.58 2.68.08"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function AccountIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 12.25a4.25 4.25 0 1 0 0-8.5a4.25 4.25 0 0 0 0 8.5Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.75 20.25c.72-3.1 3.38-5.25 7.25-5.25s6.53 2.15 7.25 5.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
}: {
  items: SessionItem[]
  workspaceOrder: Map<string, number>
  onOpen: (item: SessionItem) => void | Promise<void>
  onStop: (item: SessionItem) => void
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
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
                      aria-label="Starred workspace"
                    >
                      <path d="M8 1.5L9.95 5.7L14.5 6.3L11.2 9.55L12 14.1L8 11.95L4 14.1L4.8 9.55L1.5 6.3L6.05 5.7L8 1.5Z" />
                    </svg>
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

function AccountPopover({
  authState,
  message,
  onRefresh,
  onLogout,
  onSwitchOrganization,
  onUpgrade,
}: {
  authState: MulticodeAuthState
  message: string | null
  onRefresh: () => void
  onLogout: () => void
  onSwitchOrganization: () => void
  onUpgrade: () => void
}) {
  const planLabel = authState.entitlements?.plan.status === 'active'
    ? authState.entitlements.plan.code
    : authState.entitlementStatus === 'offline_grace'
      ? 'offline grace'
      : authState.entitlements?.plan.status ?? null

  return (
    <div className="w-72 overflow-hidden p-3">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[color:var(--text-strong)]">
              {authState.user?.displayName ?? authState.user?.email ?? 'Multicode account'}
            </div>
            <div className="mt-1 truncate text-[12px] text-[color:var(--text-muted)]">
              {authState.selectedOrganization?.name ?? 'No organization selected'}
            </div>
          </div>
          {planLabel ? (
            <span className="shrink-0 rounded border border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-[11px] font-semibold text-[color:var(--text-default)]">
              {planLabel}
            </span>
          ) : null}
        </div>

        {message || authState.entitlementStatus === 'offline_grace' ? (
          <div className="rounded border border-[color:var(--tone-warn-soft)] bg-[color:var(--bg-hover)] px-2.5 py-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
            {message ?? `Offline grace expires ${formatShortDate(authState.graceExpiresAt)}.`}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={onRefresh}
            className="h-8 rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-hover)] px-3 text-[12px] font-semibold text-[color:var(--text-default)] hover:bg-[color:var(--border-default)]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onSwitchOrganization}
            className="h-8 rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)] px-3 text-[12px] font-semibold text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
          >
            Switch org
          </button>
          <button
            type="button"
            onClick={onUpgrade}
            className="h-8 rounded-md border border-[color:var(--text-strong)] bg-[color:var(--text-strong)] px-3 text-[12px] font-semibold text-[color:var(--bg-app)] hover:bg-white"
          >
            Upgrade
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="h-8 rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] px-3 text-[12px] font-semibold text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]"
          >
            Sign out
          </button>
        </div>
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
  agentMenuSearchRef: React.RefObject<HTMLInputElement>

  sessions: SessionItem[]
  sidebarWorkspaceOrder: Map<string, number>
  sessionsOpen: boolean
  setSessionsOpen: React.Dispatch<React.SetStateAction<boolean>>
  openSession: (item: SessionItem) => void | Promise<void>
  stopSession: (item: SessionItem) => void

  viewMenuOpen: boolean
  setViewMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  viewMenuTick: number
  setViewMenuTick: React.Dispatch<React.SetStateAction<number>>

  notifications: AppNotification[]
  unreadNotificationCount: number
  notificationsOpen: boolean
  setNotificationsOpen: React.Dispatch<React.SetStateAction<boolean>>
  markNotificationRead: (id: string) => void
  markAllNotificationsRead: () => void
  clearNotifications: () => void

  specialistMenuOpen: boolean
  setSpecialistMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  agentMenuQuery: string
  setAgentMenuQuery: React.Dispatch<React.SetStateAction<string>>
  agentMenuHighlight: number
  setAgentMenuHighlight: React.Dispatch<React.SetStateAction<number>>
  chipPopoverForRole: ChipPopoverForRole
  setChipPopoverForRole: React.Dispatch<React.SetStateAction<ChipPopoverForRole>>
  multiloopLaunchMenu: boolean
  selectedSpecialistAction: SpecialistAction
  selectedMultiloopRoleDescriptor: MultiloopRoleDescriptor
  selectedAgentPermissionOption: typeof AGENT_SPAWN_PERMISSION_OPTIONS[number]
  lastSelectedCli: AgentCli
  specialistCliDefaults: Partial<Record<SpecialistActionId, AgentCli>>
  multiloopRoleCliDefaults: Partial<Record<MultiloopRole, AgentCli>>
  setSpecialistCliDefault: (id: SpecialistActionId, cli: AgentCli | null) => void
  setMultiloopRoleCliDefault: (role: MultiloopRole, cli: AgentCli | null) => void
  agentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  setAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  handleSelectSpecialist: (id: SpecialistActionId) => void
  handleSelectMultiloopRole: (role: MultiloopRole) => void
  addNewSpecialist: () => void | Promise<void>
  addNewMultiloopAgent: () => void | Promise<void>
  addNewCliAgent: (cli: AgentCli, label: string) => void
  addNewTerminal: () => void

  openMemoryGraph: () => void
  openHandoffDialog: () => void
  openSettings: (checkForUpdates?: boolean, targetTab?: string | null) => void
  settingsOpen: boolean

  accountOpen: boolean
  setAccountOpen: React.Dispatch<React.SetStateAction<boolean>>
  authState: MulticodeAuthState
  authMessage: string | null
  proAccount: boolean
  startLogin: () => void | Promise<void>
  refreshAuthState: () => void | Promise<void>
  logout: () => void | Promise<void>
  switchOrganization: () => void | Promise<void>
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
  agentMenuSearchRef,
  sessions,
  sidebarWorkspaceOrder,
  sessionsOpen,
  setSessionsOpen,
  openSession,
  stopSession,
  viewMenuOpen,
  setViewMenuOpen,
  viewMenuTick,
  setViewMenuTick,
  notifications,
  unreadNotificationCount,
  notificationsOpen,
  setNotificationsOpen,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
  specialistMenuOpen,
  setSpecialistMenuOpen,
  agentMenuQuery,
  setAgentMenuQuery,
  agentMenuHighlight,
  setAgentMenuHighlight,
  chipPopoverForRole,
  setChipPopoverForRole,
  multiloopLaunchMenu,
  selectedSpecialistAction,
  selectedMultiloopRoleDescriptor,
  selectedAgentPermissionOption,
  lastSelectedCli,
  specialistCliDefaults,
  multiloopRoleCliDefaults,
  setSpecialistCliDefault,
  setMultiloopRoleCliDefault,
  agentSpawnPermissionPreset,
  setAgentSpawnPermissionPreset,
  handleSelectSpecialist,
  handleSelectMultiloopRole,
  addNewSpecialist,
  addNewMultiloopAgent,
  addNewCliAgent,
  addNewTerminal,
  openMemoryGraph,
  openHandoffDialog,
  openSettings,
  settingsOpen,
  accountOpen,
  setAccountOpen,
  authState,
  authMessage,
  proAccount,
  startLogin,
  refreshAuthState,
  logout,
  switchOrganization,
}: WorkspaceTopBarProps) {
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
                className={`shrink-0 ${activeWorkspace.highlight?.color ? '' : workspaceTabIconClass(activeWorkspace.mode)}`}
                style={{
                  color: activeWorkspace.highlight?.color
                    ? getHighlightSwatch(activeWorkspace.highlight.color).hex
                    : undefined,
                }}
              >
                <WorkspaceTypeIcon
                  mode={activeWorkspace.mode}
                  className="icon-sm"
                />
              </span>
              {activeWorkspace.highlight?.starred ? (
                <svg
                  className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-label="Starred workspace"
                >
                  <title>Starred workspace</title>
                  <path d="M8 1.5L9.95 5.7L14.5 6.3L11.2 9.55L12 14.1L8 11.95L4 14.1L4.8 9.55L1.5 6.3L6.05 5.7L8 1.5Z" />
                </svg>
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
           * Adding a sixth top-bar-group marker fails scripts/lint-panel-composition.mjs.
           * Documented in knowledge/brand/panel-design-system.md (TopBar inventory).
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
                      <SessionsIcon className="h-[18px] w-[18px]" />
                      {sessions.length > 0 ? (
                        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[color:var(--bg-app)] bg-[color:var(--tone-good)] px-1 text-[10px] font-bold leading-none text-[color:var(--bg-app)]">
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
                />
              </Popover>
            </div>
          ) : null}

          {workspaceActionsEnabled && activeWorkspace && VIEWS_FOR_MODE[activeWorkspace.mode] ? (
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
                ariaLabel={`${VIEWS_FOR_MODE[activeWorkspace.mode]?.label ?? 'View'} panels`}
                popupRole="menu"
                placement="bottom-end"
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <Tooltip content={`${VIEWS_FOR_MODE[activeWorkspace.mode]?.label ?? 'View'} panels`} placement="bottom">
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
                      <span className="text-[12px] font-semibold">{VIEWS_FOR_MODE[activeWorkspace.mode]?.label ?? 'View'}</span>
                      <svg className={`icon-xs transition-transform ${viewMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </Tooltip>
                )}
              >
                <div className="w-60 overflow-hidden p-1">
                  <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-[color:var(--text-muted)]">
                    {VIEWS_FOR_MODE[activeWorkspace.mode]?.label ?? 'View'} panels
                  </div>
                  {(VIEWS_FOR_MODE[activeWorkspace.mode]?.views ?? []).map((view) => {
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

          {/* top-bar-group: workspace-context */}
          {activeWorkspace ? (
            <WorkspaceGitStatusButton
              workspaceId={activeWorkspace.id}
              folderPath={activeWorkspace.folderPath ?? null}
              onOpen={() => {
                setSessionsOpen(false)
                setNotificationsOpen(false)
                setSpecialistMenuOpen(false)
                setAccountOpen(false)
              }}
            />
          ) : null}

          {workspaceActionsEnabled ? (
            <Tooltip content="Knowledge Graph" placement="bottom">
              <button
                type="button"
                onClick={openMemoryGraph}
                disabled={!activeWorkspaceId}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] disabled:opacity-40 disabled:hover:bg-[color:var(--bg-surface-raised)]"
                aria-label="Knowledge Graph"
              >
                <MemoryGraphIcon className="h-[18px] w-[18px]" />
              </button>
            </Tooltip>
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
                    <NotificationBellIcon className="h-[18px] w-[18px]" />
                    {unreadNotificationCount > 0 ? (
                      <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[color:var(--bg-app)] bg-[color:var(--tone-error)] px-1 text-[10px] font-bold leading-none text-[color:var(--bg-app)]">
                        {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
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
              />
            </Popover>
          </div>

          {workspaceActionsEnabled ? (
            <Tooltip content="Handoff current plan to sprintengine" placement="bottom">
              <button
                type="button"
                onClick={openHandoffDialog}
                disabled={!activeWorkspaceId}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--tone-warn)] transition-colors hover:border-[color:var(--tone-warn-soft)] hover:bg-[color:var(--tone-warn)]/8 hover:text-[color:var(--tone-warn)] disabled:opacity-40 disabled:hover:bg-[color:var(--bg-surface-raised)]"
                aria-label="Handoff current plan to sprintengine"
              >
                <WorkspaceTypeIcon mode="sprintengine" className="h-[18px] w-[18px]" />
              </button>
            </Tooltip>
          ) : null}

          {/* top-bar-group: agent-spawn */}
          {workspaceActionsEnabled ? (
            <Tooltip content={`Open terminal (${shortcutLabel("Ctrl+Shift+'")})`} placement="bottom">
              <button
                onClick={addNewTerminal}
                disabled={!activeWorkspaceId}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] disabled:opacity-40 disabled:hover:bg-[color:var(--bg-surface-raised)]"
                aria-label="Open terminal"
              >
                <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M7.25 10L10 12.5L7.25 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12.5 15H16.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </Tooltip>
          ) : null}

          {workspaceActionsEnabled ? (() => {
            const triggerCli: AgentCli = multiloopLaunchMenu
              ? (multiloopRoleCliDefaults[selectedMultiloopRoleDescriptor.role] ?? lastSelectedCli)
              : (specialistCliDefaults[selectedSpecialistAction.id] ?? lastSelectedCli)
            const triggerCliOption =
              AGENT_SPAWN_CLI_OPTIONS.find((option) => option.value === triggerCli)
              ?? AGENT_SPAWN_CLI_OPTIONS[0]
            const menuQuery = agentMenuQuery.trim().toLowerCase()
            const filteredSpecialists = menuQuery
              ? SPECIALIST_ACTIONS.filter((action) =>
                  action.label.toLowerCase().includes(menuQuery)
                  || action.shortLabel.toLowerCase().includes(menuQuery)
                  || action.description.toLowerCase().includes(menuQuery)
                )
              : SPECIALIST_ACTIONS
            const filteredMultiloop = menuQuery
              ? MULTILOOP_ROLES.filter((soul) =>
                  soul.label.toLowerCase().includes(menuQuery)
                  || soul.shortLabel.toLowerCase().includes(menuQuery)
                )
              : MULTILOOP_ROLES
            const visibleItems = multiloopLaunchMenu ? filteredMultiloop : filteredSpecialists
            const safeHighlight = visibleItems.length === 0
              ? 0
              : Math.min(agentMenuHighlight, visibleItems.length - 1)
            const cycleCli = (current: AgentCli): AgentCli => {
              const index = AGENT_SPAWN_CLI_OPTIONS.findIndex((option) => option.value === current)
              const next = AGENT_SPAWN_CLI_OPTIONS[(index + 1) % AGENT_SPAWN_CLI_OPTIONS.length]
              return next?.value ?? current
            }
            const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setAgentMenuHighlight((index) =>
                  visibleItems.length === 0 ? 0 : Math.min(index + 1, visibleItems.length - 1)
                )
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setAgentMenuHighlight((index) => Math.max(index - 1, 0))
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const item = visibleItems[safeHighlight]
                if (!item) return
                if (multiloopLaunchMenu) {
                  handleSelectMultiloopRole((item as MultiloopRoleDescriptor).role)
                } else {
                  handleSelectSpecialist((item as SpecialistAction).id)
                }
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                if (chipPopoverForRole) {
                  setChipPopoverForRole(null)
                } else {
                  setSpecialistMenuOpen(false)
                }
                return
              }
              if ((event.altKey || event.metaKey) && (event.key === 'm' || event.key === 'M')) {
                event.preventDefault()
                const item = visibleItems[safeHighlight]
                if (!item) return
                if (multiloopLaunchMenu) {
                  const role = (item as MultiloopRoleDescriptor).role
                  const next = cycleCli(multiloopRoleCliDefaults[role] ?? lastSelectedCli)
                  setMultiloopRoleCliDefault(role, next)
                } else {
                  const id = (item as SpecialistAction).id
                  const next = cycleCli(specialistCliDefaults[id] ?? lastSelectedCli)
                  setSpecialistCliDefault(id, next)
                }
                return
              }
              if (event.shiftKey && event.key === 'Backspace') {
                event.preventDefault()
                const item = visibleItems[safeHighlight]
                if (!item) return
                if (multiloopLaunchMenu) {
                  setMultiloopRoleCliDefault((item as MultiloopRoleDescriptor).role, null)
                } else {
                  setSpecialistCliDefault((item as SpecialistAction).id, null)
                }
                return
              }
            }
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
                      : `Spawn ${selectedSpecialistAction.label} specialist with ${triggerCliOption.label}, ${selectedAgentPermissionOption.label}${selectedSpecialistAction.shortcut ? ` (${shortcutLabel(selectedSpecialistAction.shortcut)})` : ''}`
                  }
                >
                  <button
                    onClick={() => {
                      if (multiloopLaunchMenu) {
                        void addNewMultiloopAgent()
                      } else {
                        void addNewSpecialist()
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
                <div className="w-[320px] overflow-hidden">
                  <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-2">
                    <svg className="icon-sm shrink-0 text-[color:var(--text-disabled)]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.6" />
                      <path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    <input
                      ref={agentMenuSearchRef}
                      value={agentMenuQuery}
                      onChange={(event) => {
                        setAgentMenuQuery(event.currentTarget.value)
                        setAgentMenuHighlight(0)
                      }}
                      onKeyDown={onSearchKeyDown}
                      placeholder={multiloopLaunchMenu ? 'Spawn role…' : 'Spawn agent…'}
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] focus:outline-none"
                      aria-label="Filter agents"
                    />
                  </div>

                  {visibleItems.length === 0 ? (
                    <div className="px-3 py-5 text-center text-[11px] text-[color:var(--text-disabled)]">
                      No matches
                    </div>
                  ) : (
                    <div className="max-h-[340px] overflow-y-auto py-1">
                      {multiloopLaunchMenu
                        ? filteredMultiloop.map((soul, index) => {
                            const highlighted = index === safeHighlight
                            const boundCli = multiloopRoleCliDefaults[soul.role] ?? lastSelectedCli
                            const popoverOpen =
                              chipPopoverForRole?.kind === 'multiloop'
                              && chipPopoverForRole.role === soul.role
                            const hasOverride = multiloopRoleCliDefaults[soul.role] !== undefined
                            return (
                              <div key={soul.role} className="relative">
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={highlighted}
                                  onClick={() => handleSelectMultiloopRole(soul.role)}
                                  onMouseEnter={() => setAgentMenuHighlight(index)}
                                  className={`grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pr-2 text-left transition-colors ${
                                    highlighted
                                      ? 'bg-[color:var(--accent-primary-soft)] pl-[7px] shadow-[inset_3px_0_0_var(--accent-primary)] text-[color:var(--text-strong)]'
                                      : 'pl-2.5 text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.05)]'
                                  }`}
                                >
                                  <SpecialistActionIcon
                                    icon={soul.icon}
                                    className={`h-4 w-4 ${highlighted ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'}`}
                                  />
                                  <span className="truncate text-[13px]">{soul.label}</span>
                                  <Tooltip
                                    placement="bottom"
                                    content={hasOverride
                                      ? `Pinned to ${boundCli === 'codex' ? 'Codex' : 'Claude Code'} · click to change · ⇧⌫ to unpin`
                                      : `Using last-used (${boundCli === 'codex' ? 'Codex' : 'Claude Code'}) · click to pin`}
                                  >
                                    <span
                                      role="button"
                                      tabIndex={-1}
                                      aria-label={`Default CLI: ${boundCli === 'codex' ? 'Codex' : 'Claude Code'}`}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        setAgentMenuHighlight(index)
                                        setChipPopoverForRole((current) =>
                                          current?.kind === 'multiloop' && current.role === soul.role
                                            ? null
                                            : { kind: 'multiloop', role: soul.role }
                                        )
                                      }}
                                      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors ${
                                        hasOverride
                                          ? highlighted
                                            ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                                            : 'bg-[color:var(--accent-primary-soft)]/60 text-[color:var(--text-strong)]'
                                          : highlighted
                                            ? 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
                                            : 'text-[color:var(--text-disabled)] hover:text-[color:var(--text-strong)]'
                                      }`}
                                    >
                                      <CliIcon cli={boundCli} className="icon-sm" />
                                    </span>
                                  </Tooltip>
                                </button>
                                {popoverOpen ? (
                                  <div
                                    role="listbox"
                                    aria-label={`Default CLI for ${soul.label}`}
                                    // primitive-duplication-allow: nested chip-listbox inside the Popover-managed specialist menu;
                                    // anchored to a row-local `<div className="relative">` with no separate outside-click handler.
                                    // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                                    className="absolute right-2 top-[32px] z-50 w-[180px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                                  >
                                    {AGENT_SPAWN_CLI_OPTIONS.map((option) => {
                                      const isCurrent = option.value === boundCli
                                      return (
                                        <button
                                          key={option.value}
                                          type="button"
                                          role="option"
                                          aria-selected={isCurrent}
                                          onClick={() => {
                                            setMultiloopRoleCliDefault(soul.role, option.value)
                                            setChipPopoverForRole(null)
                                          }}
                                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                                            isCurrent
                                              ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                                              : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
                                          }`}
                                        >
                                          <CliIcon cli={option.value} className="icon-sm" />
                                          {option.label}
                                          {isCurrent ? <span className="ml-auto text-[color:var(--accent-primary)]">✓</span> : null}
                                        </button>
                                      )
                                    })}
                                    {hasOverride ? (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setMultiloopRoleCliDefault(soul.role, null)
                                          setChipPopoverForRole(null)
                                        }}
                                        className="mt-0.5 flex w-full items-center gap-2 border-t border-white/[0.06] px-2 py-1.5 text-left text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
                                      >
                                        Unpin
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })
                        : filteredSpecialists.map((action, index) => {
                            const highlighted = index === safeHighlight
                            const boundCli = specialistCliDefaults[action.id] ?? lastSelectedCli
                            const popoverOpen =
                              chipPopoverForRole?.kind === 'specialist'
                              && chipPopoverForRole.id === action.id
                            const hasOverride = specialistCliDefaults[action.id] !== undefined
                            return (
                              <div key={action.id} className="relative">
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={highlighted}
                                  onClick={() => handleSelectSpecialist(action.id)}
                                  onMouseEnter={() => setAgentMenuHighlight(index)}
                                  className={`grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pr-2 text-left transition-colors ${
                                    highlighted
                                      ? 'bg-[color:var(--accent-primary-soft)] pl-[7px] shadow-[inset_3px_0_0_var(--accent-primary)] text-[color:var(--text-strong)]'
                                      : 'pl-2.5 text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.05)]'
                                  }`}
                                >
                                  <SpecialistActionIcon
                                    icon={action.icon}
                                    className={`h-4 w-4 ${highlighted ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'}`}
                                  />
                                  <span className="truncate text-[13px]">{action.shortLabel}</span>
                                  <Tooltip
                                    placement="bottom"
                                    content={hasOverride
                                      ? `Pinned to ${boundCli === 'codex' ? 'Codex' : 'Claude Code'} · click to change · ⇧⌫ to unpin`
                                      : `Using last-used (${boundCli === 'codex' ? 'Codex' : 'Claude Code'}) · click to pin`}
                                  >
                                    <span
                                      role="button"
                                      tabIndex={-1}
                                      aria-label={`Default CLI: ${boundCli === 'codex' ? 'Codex' : 'Claude Code'}`}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        setAgentMenuHighlight(index)
                                        setChipPopoverForRole((current) =>
                                          current?.kind === 'specialist' && current.id === action.id
                                            ? null
                                            : { kind: 'specialist', id: action.id }
                                        )
                                      }}
                                      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors ${
                                        hasOverride
                                          ? highlighted
                                            ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                                            : 'bg-[color:var(--accent-primary-soft)]/60 text-[color:var(--text-strong)]'
                                          : highlighted
                                            ? 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
                                            : 'text-[color:var(--text-disabled)] hover:text-[color:var(--text-strong)]'
                                      }`}
                                    >
                                      <CliIcon cli={boundCli} className="icon-sm" />
                                    </span>
                                  </Tooltip>
                                </button>
                                {popoverOpen ? (
                                  <div
                                    role="listbox"
                                    aria-label={`Default CLI for ${action.label}`}
                                    // primitive-duplication-allow: nested chip-listbox inside the Popover-managed specialist menu;
                                    // anchored to a row-local `<div className="relative">` with no separate outside-click handler.
                                    // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                                    className="absolute right-2 top-[32px] z-50 w-[180px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                                  >
                                    {AGENT_SPAWN_CLI_OPTIONS.map((option) => {
                                      const isCurrent = option.value === boundCli
                                      return (
                                        <button
                                          key={option.value}
                                          type="button"
                                          role="option"
                                          aria-selected={isCurrent}
                                          onClick={() => {
                                            setSpecialistCliDefault(action.id, option.value)
                                            setChipPopoverForRole(null)
                                          }}
                                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                                            isCurrent
                                              ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                                              : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
                                          }`}
                                        >
                                          <CliIcon cli={option.value} className="icon-sm" />
                                          {option.label}
                                          {isCurrent ? <span className="ml-auto text-[color:var(--accent-primary)]">✓</span> : null}
                                        </button>
                                      )
                                    })}
                                    {hasOverride ? (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSpecialistCliDefault(action.id, null)
                                          setChipPopoverForRole(null)
                                        }}
                                        className="mt-0.5 flex w-full items-center gap-2 border-t border-white/[0.06] px-2 py-1.5 text-left text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
                                      >
                                        Unpin
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          addNewCliAgent(lastSelectedCli, 'General Agent')
                          setSpecialistMenuOpen(false)
                        }}
                        className="mt-1 grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 border-t border-white/[0.06] py-1.5 pl-2.5 pr-2 text-left text-[color:var(--text-muted)] transition-colors hover:bg-[rgba(92,124,255,0.05)] hover:text-[color:var(--text-strong)]"
                      >
                        <CliIcon cli={lastSelectedCli} className="icon-md" />
                        <span className="truncate text-[13px]">General Agent</span>
                        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[color:var(--text-disabled)]">
                          <CliIcon cli={lastSelectedCli} className="icon-sm" />
                        </span>
                      </button>
                    </div>
                  )}

                  <div className="flex items-center gap-1 border-t border-white/[0.06] px-2 py-1.5">
                    {AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => {
                      const active = option.value === agentSpawnPermissionPreset
                      const isBypass = option.value === 'bypass_all'
                      return (
                        <Tooltip key={option.value} content={option.title} placement="bottom">
                          <button
                            type="button"
                            onClick={() => setAgentSpawnPermissionPreset(option.value)}
                            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                              active
                                ? isBypass
                                  ? 'bg-[color:var(--tone-warn)]/12 text-[color:var(--tone-warn)]'
                                  : 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                                : 'text-[color:var(--text-disabled)] hover:text-[color:var(--text-muted)]'
                            }`}
                          >
                            {option.value === 'default' ? 'Default' : option.value === 'auto_workspace' ? 'Auto' : 'Bypass'}
                          </button>
                        </Tooltip>
                      )
                    })}
                  </div>
                </div>
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
                ariaLabel={proAccount ? 'Multicode Pro account' : 'Multicode account'}
                popupRole="menu"
                placement="bottom-end"
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <Tooltip content={proAccount ? 'Multicode Pro account' : 'Multicode account'} placement="bottom">
                    <button
                      ref={ref}
                      type="button"
                      onClick={togglePopover}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                        proAccount
                          ? accountOpen
                            ? 'border-[color:var(--tone-warn-soft)] bg-[color:var(--tone-warn)]/8 text-[color:var(--tone-warn)]'
                            : 'border-transparent text-[color:var(--tone-warn)] hover:bg-[color:var(--tone-warn)]/8 hover:text-[color:var(--tone-warn)]'
                          : accountOpen
                            ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--tone-good)]'
                            : 'border-[color:var(--tone-good-soft)] bg-[color:var(--tone-good-soft)] text-[color:var(--tone-good)] hover:border-[color:var(--tone-good)]/50 hover:bg-[color:var(--tone-good-soft)]'
                      }`}
                      aria-label={proAccount ? 'Multicode Pro account' : 'Multicode account'}
                      {...triggerProps}
                    >
                      <AccountIcon className="icon-md" />
                    </button>
                  </Tooltip>
                )}
              >
                <AccountPopover
                  authState={authState}
                  message={authMessage}
                  onRefresh={() => void refreshAuthState()}
                  onLogout={() => void logout()}
                  onSwitchOrganization={() => void switchOrganization()}
                  onUpgrade={() => void window.api.authOpenUpgrade('sprintengine')}
                />
              </Popover>
            ) : (
              <Tooltip content={authState.status === 'checking' ? 'Checking sign-in status' : 'Sign in'} placement="bottom">
                <button
                  type="button"
                  onClick={() => void startLogin()}
                  disabled={authState.status === 'checking'}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[color:var(--bg-selected)] disabled:hover:bg-[color:var(--bg-surface-raised)] disabled:hover:text-[color:var(--text-muted)]"
                  aria-label={authState.status === 'checking' ? 'Checking sign-in status' : 'Sign in'}
                >
                  <AccountIcon className="icon-md" />
                </button>
              </Tooltip>
            )}
          </div>

          <Tooltip content={`Settings (${shortcutLabel('Ctrl+,')})`} placement="bottom">
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
