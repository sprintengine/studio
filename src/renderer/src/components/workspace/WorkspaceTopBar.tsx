import React from 'react'
import { SpecialistActionIcon, SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import { Popover, StatusDot, Tooltip } from '../ui'
import CliIcon from '../CliIcon'
import {
  MULTILOOP_ROLES,
  getMultiloopRole,
  getSpecialistAction,
  type MultiloopRoleDescriptor,
  type SpecialistAction,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AgentCliModelSelection,
  AppNotification,
  MultiloopRole,
  PluginCatalogStatus,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
  Workspace,
} from '../../types/workspace'
import { resolveAvailableAgentCli, resolveCliModel, type AgentCliCatalogOption } from './newWorkspace/cliRuntimeOptions'
import { hasComponentTab, toggleComponentTab } from '../../utils/modelRegistry'
import { getHighlightSwatch, getWorkspaceAccentHex, isStarred } from '../../utils/highlight'
import { getSprintEngineRoleAccent } from '../../utils/sprintengine'
import { NotificationsPopover } from './topbar/NotificationsPopover'
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

export type ChipPopoverForRole =
  | { kind: 'specialist'; id: SpecialistActionId }
  | { kind: 'multiloop'; role: MultiloopRole }
  | { kind: 'general' }
  | { kind: 'terminal' }
  | { kind: 'conversation' }
  | null

// Top item of a spawn row's right-click menu: opens that row's agent in a fresh
// workspace instead of the active one. Shared by every spawn row so the affordance
// reads identically; rows with a CLI list render it above a divider.
function OpenInNewChatItem({ onSelect }: { onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]"
    >
      <svg className="icon-sm shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="3" y="3" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 7v6M7 10h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      Open in New Chat
    </button>
  )
}

// CLI listbox shared by the spawn-row chip popovers (General Agent, specialist
// rows, Multiloop roles). Each CLI row selects that CLI as-is; rows whose
// plugin declares modelSelection get a trailing disclosure that expands an
// indented model list — "Default" (the CLI's own default, no flag passed),
// the merged seed + user-added options, and a free-text id when the plugin
// allows custom ids. Picking a model selects the CLI and the model together.
function CliModelListbox({
  ariaLabel,
  options,
  currentCli,
  effectiveModelFor,
  onSelectCli,
  onSelectModel,
}: {
  ariaLabel: string
  options: AgentCliCatalogOption[]
  currentCli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
}) {
  const [expandedCli, setExpandedCli] = React.useState<AgentCli | null>(null)
  const [customModel, setCustomModel] = React.useState('')
  return (
    <div role="listbox" aria-label={ariaLabel}>
      {options.map((option) => {
        const isCurrent = option.value === currentCli
        const models = option.modelSelection
        const expanded = expandedCli === option.value
        const effectiveModel = effectiveModelFor(option.value)
        return (
          <React.Fragment key={option.value}>
            <div className="relative">
              <button
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => onSelectCli(option.value)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                  models ? 'pr-7' : ''
                } ${
                  isCurrent
                    ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
                }`}
              >
                <CliIcon cli={option.value} className="icon-sm" />
                {option.label}
                {isCurrent ? <span className="ml-auto text-[color:var(--accent-primary)]">✓</span> : null}
              </button>
              {models ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={`Models for ${option.label}`}
                  onClick={() => {
                    setCustomModel('')
                    setExpandedCli((current) => (current === option.value ? null : option.value))
                  }}
                  className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[color:var(--text-disabled)] transition-colors hover:text-[color:var(--text-strong)]"
                >
                  <svg className={`icon-xs transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}
            </div>
            {expanded && models ? (
              <div
                role="listbox"
                aria-label={`Model for ${option.label}`}
                // Bounded: the chip popover measured its flip placement before
                // this section expanded, so long model lists scroll instead of
                // growing past the spawn menu's clip.
                className="my-0.5 ml-3.5 max-h-[168px] overflow-y-auto border-l border-[color:var(--border-subtle)] pl-1"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={!effectiveModel}
                  onClick={() => onSelectModel(option.value, null)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors ${
                    !effectiveModel
                      ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                      : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
                  }`}
                >
                  Default
                  {!effectiveModel ? <span className="ml-auto text-[color:var(--accent-primary)]">✓</span> : null}
                </button>
                {models.options.map((model) => {
                  const isModelCurrent = model.id === effectiveModel
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="option"
                      aria-selected={isModelCurrent}
                      onClick={() => onSelectModel(option.value, model.id)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors ${
                        model.label ? '' : 'font-mono text-[11px]'
                      } ${
                        isModelCurrent
                          ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                          : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{model.label ?? model.id}</span>
                      {isModelCurrent ? <span className="text-[color:var(--accent-primary)]">✓</span> : null}
                    </button>
                  )
                })}
                {/* A persisted model no longer in the catalog still launches with
                    that id; surface it as the checked entry instead of hiding it. */}
                {effectiveModel && !models.options.some((model) => model.id === effectiveModel) ? (
                  <button
                    type="button"
                    role="option"
                    aria-selected
                    onClick={() => onSelectModel(option.value, effectiveModel)}
                    className="flex w-full items-center gap-2 rounded bg-[color:var(--accent-primary-soft-strong)] px-2 py-1 text-left font-mono text-[11px] text-[color:var(--text-strong)]"
                  >
                    <span className="min-w-0 flex-1 truncate">{effectiveModel}</span>
                    <span className="text-[color:var(--accent-primary)]">✓</span>
                  </button>
                ) : null}
                {models.allowCustomId ? (
                  <input
                    type="text"
                    value={customModel}
                    placeholder="Custom model id"
                    aria-label={`Custom model id for ${option.label}`}
                    onChange={(event) => setCustomModel(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        const model = customModel.trim()
                        if (model) onSelectModel(option.value, model)
                      }
                    }}
                    className="mt-0.5 w-full rounded border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 font-mono text-[11px] text-[color:var(--text-default)] placeholder:font-sans placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] focus:outline-none"
                  />
                ) : null}
              </div>
            ) : null}
          </React.Fragment>
        )
      })}
    </div>
  )
}

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

// Neutral chat glyph for conversation-runtime spawn rows. CliIcon is reserved
// for terminal CLI plugins; a provider-backed agent is a conversation, so it
// reads as a speech bubble rather than a terminal prompt.
function ConversationProviderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 5.75h14a1.75 1.75 0 0 1 1.75 1.75v7a1.75 1.75 0 0 1-1.75 1.75H10l-3.75 3v-3H5A1.75 1.75 0 0 1 3.25 15.5v-8A1.75 1.75 0 0 1 5 5.75Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
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

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3.25" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.75 11.5a6.25 6.25 0 0 0 12.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 17.75V20.5M8.75 20.5h6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
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
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
                      aria-label="Starred workspace"
                    >
                      <path d="M8 1.5L9.95 5.7L14.5 6.3L11.2 9.55L12 14.1L8 11.95L4 14.1L4.8 9.55L1.5 6.3L6.05 5.7L8 1.5Z" />
                    </svg>
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
            className="h-8 rounded-md border border-[color:var(--text-strong)] bg-[color:var(--text-strong)] px-3 text-[12px] font-semibold text-[color:var(--bg-app)] hover:bg-[color:var(--bg-inverted-hover)]"
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
  stopWorkspaceSessions: (workspace: Workspace, items: SessionItem[]) => void | Promise<void>

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

  /** Voice dictation (gated on the voice-dictation module). */
  voiceDictationEnabled: boolean
  voiceRecording: boolean
  voiceTranscribing: boolean
  toggleVoiceDictation: () => void

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
  // Per-agent CLI choice (e.g. Architect → Codex). The row CLI is this default
  // when set, else the last-used CLI — picking one agent's CLI does not change
  // the others. Not a pinned/unpin affordance; just a persisted per-row choice.
  specialistCliDefaults: Partial<Record<SpecialistActionId, AgentCli>>
  multiloopRoleCliDefaults: Partial<Record<MultiloopRole, AgentCli>>
  setSpecialistCliDefault: (id: SpecialistActionId, cli: AgentCli | null) => void
  setMultiloopRoleCliDefault: (role: MultiloopRole, cli: AgentCli | null) => void
  // Model selection mirrors the CLI selection idiom: a remembered per-CLI
  // default plus optional per-row overrides scoped to the CLI they were picked
  // for. Absent everywhere means "the CLI's own default model".
  cliModelDefaults: Partial<Record<AgentCli, string>>
  specialistModelDefaults: Partial<Record<SpecialistActionId, AgentCliModelSelection>>
  multiloopRoleModelDefaults: Partial<Record<MultiloopRole, AgentCliModelSelection>>
  setCliModelDefault: (cli: AgentCli, model: string | null) => void
  setSpecialistModelDefault: (id: SpecialistActionId, selection: AgentCliModelSelection | null) => void
  setMultiloopRoleModelDefault: (role: MultiloopRole, selection: AgentCliModelSelection | null) => void
  // Specialist roster in the user's persisted display order. Drives the spawn
  // menu list and is the source the drag-reorder rewrites.
  specialistActions: SpecialistAction[]
  setSpecialistOrder: (order: SpecialistActionId[]) => void
  // Plugin-aware agent CLI catalog (bundled + configured cliRuntimes), shared
  // with the sidebar New chat picker so the lists stay in sync. Entries carry
  // the plugin's merged model catalog when it declares modelSelection.
  agentCliOptions: AgentCliCatalogOption[]
  // Plugin registry load state, so the spawn menu can tell "still loading" and
  // "registry error" apart from a genuinely empty catalog.
  agentCliStatus: PluginCatalogStatus
  agentCliError: string | null
  agentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  setAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  handleSelectSpecialist: (id: SpecialistActionId, cli: AgentCli) => void
  handleSelectMultiloopRole: (role: MultiloopRole, cli: AgentCli) => void
  addNewSpecialist: (cli: AgentCli) => void | Promise<void>
  addNewMultiloopAgent: (cli: AgentCli) => void | Promise<void>
  addNewCliAgent: (cli: AgentCli, label: string) => void
  addNewTerminal: () => void
  // Sets the CLI used by the General Agent quick row (the remembered default,
  // shared with the trigger button and New chat). Wired to setLastSelectedCli.
  setGeneralAgentCli: (cli: AgentCli) => void
  // Conversation runtime spawn collapses to one entry: the model is picked in
  // the chat composer, so the menu only needs to know whether a default
  // provider/model is available and how to open it.
  conversationSpawnAvailable: boolean
  onSpawnConversationAgent: () => void
  // Open-in-new-chat: spawn the row's agent in a fresh workspace (inheriting the
  // current folder) instead of the active one. Surfaced as the top item of each
  // row's right-click menu.
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
  stopWorkspaceSessions,
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
  voiceDictationEnabled,
  voiceRecording,
  voiceTranscribing,
  toggleVoiceDictation,
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
  cliModelDefaults,
  specialistModelDefaults,
  multiloopRoleModelDefaults,
  setCliModelDefault,
  setSpecialistModelDefault,
  setMultiloopRoleModelDefault,
  specialistActions,
  setSpecialistOrder,
  agentCliOptions,
  agentCliStatus,
  agentCliError,
  agentSpawnPermissionPreset,
  setAgentSpawnPermissionPreset,
  handleSelectSpecialist,
  handleSelectMultiloopRole,
  addNewSpecialist,
  addNewMultiloopAgent,
  addNewCliAgent,
  addNewTerminal,
  setGeneralAgentCli,
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
  proAccount,
  startLogin,
  refreshAuthState,
  logout,
  switchOrganization,
}: WorkspaceTopBarProps) {
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
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
  // "Claude Code · Opus" for tooltips: the model's friendly label when the
  // catalog knows it, the raw id otherwise, nothing when the CLI default runs.
  const cliWithModelLabel = (cli: AgentCli, model: string | undefined): string => {
    const cliLabel = cliLabelFor(cli)
    if (!model) return cliLabel
    const option = agentCliOptions.find((entry) => entry.value === cli)
    const modelLabel = option?.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model
    return `${cliLabel} · ${modelLabel}`
  }
  // Drag-to-reorder state for the specialist spawn list. Ephemeral: the dragged
  // row and the row it is currently hovering, used only to paint the drop target.
  const [draggingSpecialistId, setDraggingSpecialistId] = React.useState<SpecialistActionId | null>(null)
  const [dragOverSpecialistId, setDragOverSpecialistId] = React.useState<SpecialistActionId | null>(null)
  // Commit a drop: move the dragged specialist to the target's position and
  // persist the full id sequence. No-ops when source/target match or are stale.
  const reorderSpecialist = (sourceId: SpecialistActionId, targetId: SpecialistActionId): void => {
    if (sourceId === targetId) return
    const ids = specialistActions.map((action) => action.id)
    const from = ids.indexOf(sourceId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(from, 1)
    ids.splice(to, 0, sourceId)
    setSpecialistOrder(ids)
  }
  // The per-row CLI chip popover is absolutely positioned inside the spawn
  // menu's scroll container, which clips overflow. For rows near the bottom it
  // would open downward into the clip and extend the scrollbar, so flip it to
  // open upward when there isn't room below within the scroller (or panel for
  // the quick rows that sit above the list).
  const [chipPopoverPlacement, setChipPopoverPlacement] = React.useState<'down' | 'up'>('down')
  React.useLayoutEffect(() => {
    if (!chipPopoverForRole) {
      setChipPopoverPlacement('down')
      return
    }
    const root = specialistMenuRef.current
    const surface = root?.querySelector<HTMLElement>('[data-chip-popover="true"]')
    const anchor = surface?.parentElement
    if (!surface || !anchor) return
    const bounds =
      surface.closest<HTMLElement>('[data-spawn-scroll="true"]')
      ?? surface.closest<HTMLElement>('[data-spawn-panel="true"]')
    const boundsBottom = bounds ? bounds.getBoundingClientRect().bottom : window.innerHeight
    const spaceBelow = boundsBottom - anchor.getBoundingClientRect().bottom
    setChipPopoverPlacement(spaceBelow < surface.offsetHeight + 8 ? 'up' : 'down')
  }, [chipPopoverForRole, specialistMenuRef, agentCliOptions.length])
  const chipPopoverPositionClass = chipPopoverPlacement === 'up' ? 'bottom-[32px]' : 'top-[32px]'
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
                  onStopWorkspace={stopWorkspaceSessions}
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
            const menuQuery = agentMenuQuery.trim().toLowerCase()
            const filteredSpecialists = menuQuery
              ? specialistActions.filter((action) =>
                  action.label.toLowerCase().includes(menuQuery)
                  || action.shortLabel.toLowerCase().includes(menuQuery)
                  || action.description.toLowerCase().includes(menuQuery)
                )
              : specialistActions
            // Reordering only makes sense against the full, unfiltered roster:
            // a search-filtered list has gaps that make drop positions ambiguous.
            const specialistDragEnabled = !menuQuery
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
            const quickTerminalVisible = !multiloopLaunchMenu && (!menuQuery || 'terminal'.includes(menuQuery))
            const quickGeneralVisible = !multiloopLaunchMenu && (!menuQuery || 'general agent'.includes(menuQuery))
            // Single conversation-agent quick row (standard workspaces with an
            // available provider/model). Non-roving like the other quick rows;
            // the model itself is chosen later in the chat composer.
            const quickConversationVisible =
              conversationSpawnAvailable && (!menuQuery || 'conversation agent'.includes(menuQuery))
            const hasQuickMatches = quickTerminalVisible || quickGeneralVisible || quickConversationVisible
            const hasAnyMatches = hasQuickMatches || visibleItems.length > 0
            const cycleCli = (current: AgentCli): AgentCli => {
              if (agentCliOptions.length === 0) return current
              const index = agentCliOptions.findIndex((option) => option.value === current)
              const next = agentCliOptions[(index + 1) % agentCliOptions.length]
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
                  const role = (item as MultiloopRoleDescriptor).role
                  handleSelectMultiloopRole(role, resolvePickerCli(multiloopRoleCliDefaults[role] ?? lastSelectedCli))
                } else {
                  const id = (item as SpecialistAction).id
                  handleSelectSpecialist(id, resolvePickerCli(specialistCliDefaults[id] ?? lastSelectedCli))
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
                // Cycle the CLI for the highlighted row only — per agent, not global.
                event.preventDefault()
                const item = visibleItems[safeHighlight]
                if (!item) return
                if (multiloopLaunchMenu) {
                  const role = (item as MultiloopRoleDescriptor).role
                  setMultiloopRoleCliDefault(role, cycleCli(multiloopRoleCliDefaults[role] ?? lastSelectedCli))
                } else {
                  const id = (item as SpecialistAction).id
                  setSpecialistCliDefault(id, cycleCli(specialistCliDefaults[id] ?? lastSelectedCli))
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
                <div data-spawn-panel="true" className="w-[320px] overflow-hidden">
                  <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-2.5 py-2">
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

                  {agentCliStatus === 'loading' ? (
                    <div className="px-3 py-1.5 text-[11px] text-[color:var(--text-disabled)]" role="status">
                      Loading installed agents…
                    </div>
                  ) : agentCliStatus === 'error' ? (
                    <div className="px-3 py-1.5 text-[11px] text-[color:var(--text-muted)]" role="status">
                      {agentCliError ?? 'Could not load agent plugins.'} Showing built-in agents.
                    </div>
                  ) : agentCliOptions.length === 0 ? (
                    <div className="px-3 py-1.5 text-[11px] text-[color:var(--text-muted)]" role="status">
                      No agent plugins installed.
                    </div>
                  ) : null}

                  {hasQuickMatches ? (
                    <div className="py-1">
                      {quickTerminalVisible ? (() => {
                        const terminalChipOpen = chipPopoverForRole?.kind === 'terminal'
                        return (
                          <div className="relative">
                            <Tooltip content={withShortcut('Open a plain terminal · right-click for more', shortcutFor('terminal.new'))} placement="bottom" wrapperClassName="block w-full">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  addNewTerminal()
                                  setSpecialistMenuOpen(false)
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault()
                                  setChipPopoverForRole((current) => (current?.kind === 'terminal' ? null : { kind: 'terminal' }))
                                }}
                                className="grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pl-2.5 pr-2 text-left text-[color:var(--text-default)] transition-colors hover:bg-[rgba(92,124,255,0.05)] hover:text-[color:var(--text-strong)]"
                              >
                                <TerminalSessionIcon className="h-4 w-4 text-[color:var(--text-muted)]" />
                                <span className="truncate text-[13px]">Terminal</span>
                                <span aria-hidden="true" />
                              </button>
                            </Tooltip>
                            {terminalChipOpen ? (
                              // primitive-duplication-allow: nested chip menu inside the Popover-managed spawn menu, matching the General Agent row; the outer Popover owns outside-click and focus restoration.
                              <div
                                role="menu"
                                data-chip-popover="true"
                                aria-label="Terminal actions"
                                // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                                className={`absolute right-2 ${chipPopoverPositionClass} z-50 w-[180px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]`}
                              >
                                <OpenInNewChatItem
                                  onSelect={() => {
                                    onOpenTerminalInNewChat()
                                    setChipPopoverForRole(null)
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                        )
                      })() : null}
                      {quickGeneralVisible ? (() => {
                        const generalCli = resolvePickerCli(lastSelectedCli)
                        const generalChipOpen = chipPopoverForRole?.kind === 'general'
                        return (
                          <div className="relative">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                addNewCliAgent(generalCli, 'General Agent')
                                setSpecialistMenuOpen(false)
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                setChipPopoverForRole((current) => (current?.kind === 'general' ? null : { kind: 'general' }))
                              }}
                              className="grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pl-2.5 pr-2 text-left text-[color:var(--text-default)] transition-colors hover:bg-[rgba(92,124,255,0.05)] hover:text-[color:var(--text-strong)]"
                            >
                              <CliIcon cli={generalCli} className="h-4 w-4 text-[color:var(--text-muted)]" />
                              <span className="truncate text-[13px]">General Agent</span>
                              <Tooltip placement="bottom" content={`Agent CLI: ${cliWithModelLabel(generalCli, resolveCliModel(generalCli, undefined, cliModelDefaults))} · right-click or click to change`}>
                                <span
                                  role="button"
                                  tabIndex={-1}
                                  aria-label={`Agent CLI: ${cliWithModelLabel(generalCli, resolveCliModel(generalCli, undefined, cliModelDefaults))}`}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    setChipPopoverForRole((current) => (current?.kind === 'general' ? null : { kind: 'general' }))
                                  }}
                                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[color:var(--text-disabled)] transition-colors hover:text-[color:var(--text-strong)]"
                                >
                                  <CliIcon cli={generalCli} className="icon-sm" />
                                </span>
                              </Tooltip>
                            </button>
                            {generalChipOpen ? (
                              // primitive-duplication-allow: nested chip menu inside the Popover-managed spawn menu, matching the specialist rows; the outer Popover owns outside-click and focus restoration.
                              <div
                                role="menu"
                                data-chip-popover="true"
                                aria-label="General Agent actions"
                                // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                                className={`absolute right-2 ${chipPopoverPositionClass} z-50 w-[220px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]`}
                              >
                                <OpenInNewChatItem
                                  onSelect={() => {
                                    onOpenGeneralInNewChat(generalCli)
                                    setChipPopoverForRole(null)
                                  }}
                                />
                                <div className="my-1 h-px bg-[color:var(--border-subtle)]" role="separator" />
                                <CliModelListbox
                                  ariaLabel="Agent CLI for General Agent"
                                  options={agentCliOptions}
                                  currentCli={generalCli}
                                  effectiveModelFor={(cli) => resolveCliModel(cli, undefined, cliModelDefaults)}
                                  onSelectCli={(cli) => {
                                    setGeneralAgentCli(cli)
                                    setChipPopoverForRole(null)
                                  }}
                                  onSelectModel={(cli, model) => {
                                    setGeneralAgentCli(cli)
                                    setCliModelDefault(cli, model)
                                    setChipPopoverForRole(null)
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                        )
                      })() : null}
                      {quickConversationVisible ? (() => {
                        const conversationChipOpen = chipPopoverForRole?.kind === 'conversation'
                        return (
                          <div className="relative">
                            <Tooltip content="Open a chat agent — pick the model in the composer · right-click for more" placement="bottom" wrapperClassName="block w-full">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => onSpawnConversationAgent()}
                                onContextMenu={(event) => {
                                  event.preventDefault()
                                  setChipPopoverForRole((current) => (current?.kind === 'conversation' ? null : { kind: 'conversation' }))
                                }}
                                className="grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pl-2.5 pr-2 text-left text-[color:var(--text-default)] transition-colors hover:bg-[rgba(92,124,255,0.05)] hover:text-[color:var(--text-strong)]"
                              >
                                <ConversationProviderIcon className="h-4 w-4 text-[color:var(--text-muted)]" />
                                <span className="truncate text-[13px]">Conversation agent</span>
                                <span aria-hidden="true" />
                              </button>
                            </Tooltip>
                            {conversationChipOpen ? (
                              // primitive-duplication-allow: nested chip menu inside the Popover-managed spawn menu, matching the General Agent row; the outer Popover owns outside-click and focus restoration.
                              <div
                                role="menu"
                                data-chip-popover="true"
                                aria-label="Conversation agent actions"
                                // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                                className={`absolute right-2 ${chipPopoverPositionClass} z-50 w-[180px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]`}
                              >
                                <OpenInNewChatItem
                                  onSelect={() => {
                                    onOpenConversationInNewChat()
                                    setChipPopoverForRole(null)
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                        )
                      })() : null}
                    </div>
                  ) : null}

                  {!hasAnyMatches ? (
                    <div className="px-3 py-5 text-center text-[11px] text-[color:var(--text-disabled)]">
                      No matches
                    </div>
                  ) : visibleItems.length === 0 ? null : (
                    <div data-spawn-scroll="true" className={`max-h-[340px] overflow-y-auto py-1 ${hasQuickMatches ? 'border-t border-[color:var(--border-subtle)]' : ''}`}>
                      {multiloopLaunchMenu
                        ? filteredMultiloop.map((soul, index) => {
                            const highlighted = index === safeHighlight
                            const boundCli = resolvePickerCli(multiloopRoleCliDefaults[soul.role] ?? lastSelectedCli)
                            const boundModel = resolveCliModel(boundCli, multiloopRoleModelDefaults[soul.role], cliModelDefaults)
                            const popoverOpen =
                              chipPopoverForRole?.kind === 'multiloop'
                              && chipPopoverForRole.role === soul.role
                            return (
                              <div key={soul.role} className="relative">
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={highlighted}
                                  onClick={() => handleSelectMultiloopRole(soul.role, boundCli)}
                                  onContextMenu={(event) => {
                                    event.preventDefault()
                                    setAgentMenuHighlight(index)
                                    setChipPopoverForRole({ kind: 'multiloop', role: soul.role })
                                  }}
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
                                    content={`Agent CLI: ${cliWithModelLabel(boundCli, boundModel)} · click to change`}
                                  >
                                    <span
                                      role="button"
                                      tabIndex={-1}
                                      aria-label={`Agent CLI: ${cliWithModelLabel(boundCli, boundModel)}`}
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
                                        highlighted
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
                                    data-chip-popover="true"
                                    // primitive-duplication-allow: nested chip-listbox inside the Popover-managed specialist menu;
                                    // anchored to a row-local `<div className="relative">` with no separate outside-click handler.
                                    // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                                    className={`absolute right-2 ${chipPopoverPositionClass} z-50 w-[220px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]`}
                                  >
                                    <CliModelListbox
                                      ariaLabel={`Agent CLI for ${soul.label}`}
                                      options={agentCliOptions}
                                      currentCli={boundCli}
                                      effectiveModelFor={(cli) =>
                                        resolveCliModel(cli, multiloopRoleModelDefaults[soul.role], cliModelDefaults)}
                                      onSelectCli={(cli) => {
                                        setMultiloopRoleCliDefault(soul.role, cli)
                                        setChipPopoverForRole(null)
                                      }}
                                      onSelectModel={(cli, model) => {
                                        setMultiloopRoleCliDefault(soul.role, cli)
                                        setMultiloopRoleModelDefault(soul.role, model ? { cli, model } : null)
                                        setChipPopoverForRole(null)
                                      }}
                                    />
                                  </div>
                                ) : null}
                              </div>
                            )
                          })
                        : filteredSpecialists.map((action, index) => {
                            const highlighted = index === safeHighlight
                            const boundCli = resolvePickerCli(specialistCliDefaults[action.id] ?? lastSelectedCli)
                            const boundModel = resolveCliModel(boundCli, specialistModelDefaults[action.id], cliModelDefaults)
                            const popoverOpen =
                              chipPopoverForRole?.kind === 'specialist'
                              && chipPopoverForRole.id === action.id
                            const dragging = draggingSpecialistId === action.id
                            const dropTarget =
                              specialistDragEnabled
                              && dragOverSpecialistId === action.id
                              && draggingSpecialistId !== null
                              && draggingSpecialistId !== action.id
                            return (
                              <div
                                key={action.id}
                                className={`relative ${dragging ? 'opacity-40' : ''} ${
                                  dropTarget ? 'shadow-[inset_0_2px_0_var(--accent-primary)]' : ''
                                }`}
                                draggable={specialistDragEnabled}
                                onDragStart={(event) => {
                                  setDraggingSpecialistId(action.id)
                                  event.dataTransfer.effectAllowed = 'move'
                                  event.dataTransfer.setData('text/plain', action.id)
                                }}
                                onDragOver={(event) => {
                                  if (!specialistDragEnabled || draggingSpecialistId === null) return
                                  event.preventDefault()
                                  event.dataTransfer.dropEffect = 'move'
                                  if (dragOverSpecialistId !== action.id) setDragOverSpecialistId(action.id)
                                }}
                                onDragLeave={() => {
                                  setDragOverSpecialistId((current) => (current === action.id ? null : current))
                                }}
                                onDrop={(event) => {
                                  event.preventDefault()
                                  if (draggingSpecialistId) reorderSpecialist(draggingSpecialistId, action.id)
                                  setDraggingSpecialistId(null)
                                  setDragOverSpecialistId(null)
                                }}
                                onDragEnd={() => {
                                  setDraggingSpecialistId(null)
                                  setDragOverSpecialistId(null)
                                }}
                              >
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={highlighted}
                                  onClick={() => handleSelectSpecialist(action.id, boundCli)}
                                  onContextMenu={(event) => {
                                    event.preventDefault()
                                    setAgentMenuHighlight(index)
                                    setChipPopoverForRole({ kind: 'specialist', id: action.id })
                                  }}
                                  onMouseEnter={() => setAgentMenuHighlight(index)}
                                  className={`grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pr-2 text-left transition-colors ${
                                    dragging ? 'cursor-grabbing' : ''
                                  } ${
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
                                    content={`Agent CLI: ${cliWithModelLabel(boundCli, boundModel)} · click to change`}
                                  >
                                    <span
                                      role="button"
                                      tabIndex={-1}
                                      aria-label={`Agent CLI: ${cliWithModelLabel(boundCli, boundModel)}`}
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
                                        highlighted
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
                                    role="menu"
                                    data-chip-popover="true"
                                    aria-label={`${action.label} actions`}
                                    // primitive-duplication-allow: nested chip menu inside the Popover-managed specialist menu;
                                    // anchored to a row-local `<div className="relative">` with no separate outside-click handler.
                                    // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                                    className={`absolute right-2 ${chipPopoverPositionClass} z-50 w-[220px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]`}
                                  >
                                    <OpenInNewChatItem
                                      onSelect={() => {
                                        onOpenSpecialistInNewChat(action.id, boundCli)
                                        setChipPopoverForRole(null)
                                      }}
                                    />
                                    <div className="my-1 h-px bg-[color:var(--border-subtle)]" role="separator" />
                                    <CliModelListbox
                                      ariaLabel={`Agent CLI for ${action.label}`}
                                      options={agentCliOptions}
                                      currentCli={boundCli}
                                      effectiveModelFor={(cli) =>
                                        resolveCliModel(cli, specialistModelDefaults[action.id], cliModelDefaults)}
                                      onSelectCli={(cli) => {
                                        setSpecialistCliDefault(action.id, cli)
                                        setChipPopoverForRole(null)
                                      }}
                                      onSelectModel={(cli, model) => {
                                        setSpecialistCliDefault(action.id, cli)
                                        setSpecialistModelDefault(action.id, model ? { cli, model } : null)
                                        setChipPopoverForRole(null)
                                      }}
                                    />
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                    </div>
                  )}

                  <div className="flex items-center gap-1 border-t border-[color:var(--border-subtle)] px-2 py-1.5">
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
