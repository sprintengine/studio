import React from 'react'
import { SpecialistActionIcon } from '../AppIcons'
import { CliModelListbox, Tooltip } from '../ui'
import CliIcon from '../CliIcon'
import {
  MULTILOOP_ROLES,
  orderSpecialistActions,
  type MultiloopRoleDescriptor,
  type SpecialistAction,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AgentCliModelSelection,
  MultiloopRole,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
} from '../../types/workspace'
import { resolveAvailableAgentCli, resolveCliModel, resolveSurfaceModel, selectAgentCliCatalog } from './newWorkspace/cliRuntimeOptions'
import { normalizeSelectedCli } from '../../store/slices/settingsSlice'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  getEffectiveKeybindingLabel,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'

// Which spawn row currently has its CLI/model (and Open-in-New-Chat) flyout open.
// Only one chip is open at a time across the whole menu.
export type ChipPopoverForRole =
  | { kind: 'specialist'; id: SpecialistActionId }
  | { kind: 'multiloop'; role: MultiloopRole }
  | { kind: 'general' }
  | { kind: 'terminal' }
  | { kind: 'conversation' }
  | null

// Stable empty fallbacks so store selectors returning a default don't churn refs.
const EMPTY_SPECIALIST_CLI_DEFAULTS: Partial<Record<SpecialistActionId, AgentCli>> = {}
const EMPTY_MULTILOOP_ROLE_CLI_DEFAULTS: Partial<Record<MultiloopRole, AgentCli>> = {}
const EMPTY_CLI_MODEL_DEFAULTS: Partial<Record<AgentCli, string>> = {}
const EMPTY_SPECIALIST_MODEL_DEFAULTS: Partial<Record<SpecialistActionId, AgentCliModelSelection>> = {}
const EMPTY_MULTILOOP_ROLE_MODEL_DEFAULTS: Partial<Record<MultiloopRole, AgentCliModelSelection>> = {}
const EMPTY_SPECIALIST_ORDER: SpecialistActionId[] = []

// Permission preset chips shown in the menu footer. Exported because the top
// bar's split-button trigger tooltip names the active preset.
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

// Top item of a spawn row's right-click flyout: opens that row's agent in a fresh
// workspace instead of the active one. Rendered only where the row's primary click
// does not already create a new chat (i.e. the top bar, not the sidebar New chat).
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

// Terminal glyph for the Terminal quick row. Exported so the top bar's session
// list can reuse the same mark for terminal sessions.
export function TerminalSessionIcon({ className }: { className?: string }) {
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

export type SpawnAgentMenuProps = {
  // Multiloop workspaces spawn loop roles; everything else spawns specialists.
  multiloopLaunchMenu: boolean
  // Whether the Conversation agent quick row is offered.
  conversationSpawnAvailable: boolean

  // Shared permission preset. Owned by the parent because the spawn handlers
  // read it at spawn time; both pickers read/write the same remembered value.
  agentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  onChangeAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void

  // Primary row actions. The parent decides whether these spawn into the active
  // workspace (top bar) or into a fresh solo chat (sidebar New chat).
  onSpawnTerminal: () => void
  onSpawnGeneral: (cli: AgentCli) => void
  onSpawnConversation: () => void
  onSpawnSpecialist: (id: SpecialistActionId, cli: AgentCli) => void
  onSpawnMultiloopRole: (role: MultiloopRole, cli: AgentCli) => void

  // Optional "Open in New Chat" flyout items. Only meaningful when the primary
  // action spawns in place (top bar); the sidebar omits them as redundant.
  showOpenInNewChat: boolean
  onOpenTerminalInNewChat?: () => void
  onOpenGeneralInNewChat?: (cli: AgentCli) => void
  onOpenConversationInNewChat?: () => void
  onOpenSpecialistInNewChat?: (id: SpecialistActionId, cli: AgentCli) => void

  // Dismiss the surrounding surface (Popover / coordinate menu) after a pick.
  onClose: () => void
}

/**
 * The spawn-agent picker body: search, the Terminal / General / Conversation
 * quick rows, the specialist (or multiloop) roster with per-row CLI/model
 * flyouts and drag-reorder, and the permission-preset footer.
 *
 * Renders content only — the caller supplies the floating surface (the top bar's
 * Popover, the sidebar's coordinate popover). It owns its own transient UI state
 * (search text, keyboard highlight, which row's flyout is open) and reads
 * app-global agent preferences from the workspace store, so both call sites stay
 * a thin behavioral contract instead of plumbing ~20 props.
 */
export default function SpawnAgentMenu({
  multiloopLaunchMenu,
  conversationSpawnAvailable,
  agentSpawnPermissionPreset,
  onChangeAgentSpawnPermissionPreset,
  onSpawnTerminal,
  onSpawnGeneral,
  onSpawnConversation,
  onSpawnSpecialist,
  onSpawnMultiloopRole,
  showOpenInNewChat,
  onOpenTerminalInNewChat,
  onOpenGeneralInNewChat,
  onOpenConversationInNewChat,
  onOpenSpecialistInNewChat,
  onClose,
}: SpawnAgentMenuProps) {
  // App-global agent preferences (persisted in settings). Read here so the menu
  // is self-contained at every call site.
  const lastSelectedCli = useWorkspaceStore((s) => normalizeSelectedCli(s.appSettings.lastSelectedCli))
  const setLastSelectedCli = useWorkspaceStore((s) => s.setLastSelectedCli)
  const specialistCliDefaults = useWorkspaceStore((s) => s.appSettings.specialistCliDefaults ?? EMPTY_SPECIALIST_CLI_DEFAULTS)
  const multiloopRoleCliDefaults = useWorkspaceStore((s) => s.appSettings.multiloopRoleCliDefaults ?? EMPTY_MULTILOOP_ROLE_CLI_DEFAULTS)
  const setSpecialistCliDefault = useWorkspaceStore((s) => s.setSpecialistCliDefault)
  const setMultiloopRoleCliDefault = useWorkspaceStore((s) => s.setMultiloopRoleCliDefault)
  const cliModelDefaults = useWorkspaceStore((s) => s.appSettings.cliModelDefaults ?? EMPTY_CLI_MODEL_DEFAULTS)
  const specialistModelDefaults = useWorkspaceStore((s) => s.appSettings.specialistModelDefaults ?? EMPTY_SPECIALIST_MODEL_DEFAULTS)
  const multiloopRoleModelDefaults = useWorkspaceStore((s) => s.appSettings.multiloopRoleModelDefaults ?? EMPTY_MULTILOOP_ROLE_MODEL_DEFAULTS)
  const setCliModelDefault = useWorkspaceStore((s) => s.setCliModelDefault)
  const setSpecialistModelDefault = useWorkspaceStore((s) => s.setSpecialistModelDefault)
  const setMultiloopRoleModelDefault = useWorkspaceStore((s) => s.setMultiloopRoleModelDefault)
  const specialistOrder = useWorkspaceStore((s) => s.appSettings.specialistOrder ?? EMPTY_SPECIALIST_ORDER)
  const setSpecialistOrder = useWorkspaceStore((s) => s.setSpecialistOrder)
  const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)

  const specialistActions = React.useMemo(() => orderSpecialistActions(specialistOrder), [specialistOrder])
  const agentCliOptions = React.useMemo(
    () => selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes],
  )

  // Transient UI state for this menu instance.
  const [agentMenuQuery, setAgentMenuQuery] = React.useState('')
  const [agentMenuHighlight, setAgentMenuHighlight] = React.useState(0)
  const [chipPopoverForRole, setChipPopoverForRole] = React.useState<ChipPopoverForRole>(null)
  const agentMenuSearchRef = React.useRef<HTMLInputElement>(null)
  // Drag-to-reorder state for the specialist list (paints the drop target only).
  const [draggingSpecialistId, setDraggingSpecialistId] = React.useState<SpecialistActionId | null>(null)
  const [dragOverSpecialistId, setDragOverSpecialistId] = React.useState<SpecialistActionId | null>(null)

  // Focus the search field when the menu mounts (i.e. opens).
  React.useEffect(() => {
    const id = requestAnimationFrame(() => agentMenuSearchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const shortcutFor = React.useCallback(
    (commandId: string): string | null => getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform),
    [keybindingPlatform, keybindingSettings],
  )
  const withShortcut = (label: string, shortcut: string | null): string => (shortcut ? `${label} (${shortcut})` : label)
  const cliLabelFor = (cli: AgentCli): string =>
    agentCliOptions.find((option) => option.value === cli)?.label ?? cli
  const cliWithModelLabel = (cli: AgentCli, model: string | undefined): string => {
    const cliLabel = cliLabelFor(cli)
    if (!model) return cliLabel
    const option = agentCliOptions.find((entry) => entry.value === cli)
    const modelLabel = option?.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model
    return `${cliLabel} · ${modelLabel}`
  }

  // Constrain a remembered CLI to one that is actually installed. When the
  // catalog is empty (registry loading or no agent plugins) this preserves the
  // passed id rather than throwing on an empty list.
  const resolvePickerCli = (cli: AgentCli): AgentCli =>
    resolveAvailableAgentCli(cli, agentCliOptions, agentCliOptions[0]?.value ?? cli)

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

  // The per-row CLI chip flyout lives inside the menu's scroll container, which
  // clips overflow. The menu surface is portaled to <body>, so position the open
  // flyout `fixed` by writing coordinates onto its node: it escapes the clip and
  // floats anchored to its row, flipping above when it would run past the bottom.
  React.useLayoutEffect(() => {
    if (!chipPopoverForRole) return
    const apply = () => {
      const surface = document.querySelector<HTMLElement>('[data-chip-popover="true"]')
      const anchor = surface?.parentElement
      if (!surface || !anchor) return
      const rect = anchor.getBoundingClientRect()
      const openUp = window.innerHeight - rect.top - 32 < surface.offsetHeight + 8
      surface.style.position = 'fixed'
      surface.style.left = 'auto'
      surface.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right + 8))}px`
      if (openUp) {
        surface.style.top = 'auto'
        surface.style.bottom = `${Math.round(window.innerHeight - rect.bottom + 32)}px`
      } else {
        surface.style.bottom = 'auto'
        surface.style.top = `${Math.round(rect.top + 32)}px`
      }
    }
    apply()
    window.addEventListener('resize', apply)
    window.addEventListener('scroll', apply, true)
    return () => {
      window.removeEventListener('resize', apply)
      window.removeEventListener('scroll', apply, true)
    }
  }, [chipPopoverForRole, agentCliOptions.length])

  const menuQuery = agentMenuQuery.trim().toLowerCase()
  const filteredSpecialists = menuQuery
    ? specialistActions.filter((action) =>
        action.label.toLowerCase().includes(menuQuery)
        || action.shortLabel.toLowerCase().includes(menuQuery)
        || action.description.toLowerCase().includes(menuQuery)
      )
    : specialistActions
  // Reordering only makes sense against the full, unfiltered roster: a
  // search-filtered list has gaps that make drop positions ambiguous.
  const specialistDragEnabled = !menuQuery
  const filteredMultiloop = menuQuery
    ? MULTILOOP_ROLES.filter((soul) =>
        soul.label.toLowerCase().includes(menuQuery) || soul.shortLabel.toLowerCase().includes(menuQuery)
      )
    : MULTILOOP_ROLES
  const visibleItems = multiloopLaunchMenu ? filteredMultiloop : filteredSpecialists
  const safeHighlight = visibleItems.length === 0 ? 0 : Math.min(agentMenuHighlight, visibleItems.length - 1)
  const quickTerminalVisible = !multiloopLaunchMenu && (!menuQuery || 'terminal'.includes(menuQuery))
  const quickGeneralVisible = !multiloopLaunchMenu && (!menuQuery || 'general agent'.includes(menuQuery))
  // Single conversation-agent quick row (when a provider/model is available).
  // Non-roving like the other quick rows; the model is chosen later in the
  // chat composer.
  const quickConversationVisible = conversationSpawnAvailable && (!multiloopLaunchMenu) && (!menuQuery || 'conversation agent'.includes(menuQuery))
  const hasQuickMatches = quickTerminalVisible || quickGeneralVisible || quickConversationVisible
  const hasAnyMatches = hasQuickMatches || visibleItems.length > 0
  const cycleCli = (current: AgentCli): AgentCli => {
    if (agentCliOptions.length === 0) return current
    const index = agentCliOptions.findIndex((option) => option.value === current)
    const next = agentCliOptions[(index + 1) % agentCliOptions.length]
    return next?.value ?? current
  }

  const selectSpecialist = (id: SpecialistActionId, cli: AgentCli) => {
    onSpawnSpecialist(id, cli)
    onClose()
  }
  const selectMultiloopRole = (role: MultiloopRole, cli: AgentCli) => {
    onSpawnMultiloopRole(role, cli)
    onClose()
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setAgentMenuHighlight((index) => (visibleItems.length === 0 ? 0 : Math.min(index + 1, visibleItems.length - 1)))
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
        selectMultiloopRole(role, resolvePickerCli(multiloopRoleCliDefaults[role] ?? lastSelectedCli))
      } else {
        const id = (item as SpecialistAction).id
        selectSpecialist(id, resolvePickerCli(specialistCliDefaults[id] ?? lastSelectedCli))
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (chipPopoverForRole) {
        setChipPopoverForRole(null)
      } else {
        onClose()
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

      {pluginCatalogStatus === 'loading' ? (
        <div className="px-3 py-1.5 text-[11px] text-[color:var(--text-disabled)]" role="status">
          Loading installed agents…
        </div>
      ) : pluginCatalogStatus === 'error' ? (
        <div className="px-3 py-1.5 text-[11px] text-[color:var(--text-muted)]" role="status">
          {pluginCatalogError ?? 'Could not load agent plugins.'} Showing built-in agents.
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
                      onSpawnTerminal()
                      onClose()
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      if (!showOpenInNewChat) return
                      setChipPopoverForRole((current) => (current?.kind === 'terminal' ? null : { kind: 'terminal' }))
                    }}
                    className="grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pl-2.5 pr-2 text-left text-[color:var(--text-default)] transition-colors hover:bg-[rgba(92,124,255,0.05)] hover:text-[color:var(--text-strong)]"
                  >
                    <TerminalSessionIcon className="h-4 w-4 text-[color:var(--text-muted)]" />
                    <span className="truncate text-[13px]">Terminal</span>
                    <span aria-hidden="true" />
                  </button>
                </Tooltip>
                {showOpenInNewChat && terminalChipOpen ? (
                  // primitive-duplication-allow: nested chip menu inside the menu's floating surface, matching the General Agent row; the surrounding surface owns outside-click and focus restoration.
                  <div
                    role="menu"
                    data-chip-popover="true"
                    aria-label="Terminal actions"
                    // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                    className="fixed z-50 w-[180px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                  >
                    <OpenInNewChatItem
                      onSelect={() => {
                        onOpenTerminalInNewChat?.()
                        setChipPopoverForRole(null)
                        onClose()
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
                    onSpawnGeneral(generalCli)
                    onClose()
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
                  // primitive-duplication-allow: nested chip menu inside the menu's floating surface, matching the specialist rows; the surrounding surface owns outside-click and focus restoration.
                  <div
                    role="menu"
                    data-chip-popover="true"
                    aria-label="General Agent actions"
                    // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                    className="fixed z-50 w-[220px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                  >
                    {showOpenInNewChat ? (
                      <>
                        <OpenInNewChatItem
                          onSelect={() => {
                            onOpenGeneralInNewChat?.(generalCli)
                            setChipPopoverForRole(null)
                            onClose()
                          }}
                        />
                        <div className="my-1 h-px bg-[color:var(--border-subtle)]" role="separator" />
                      </>
                    ) : null}
                    <CliModelListbox
                      ariaLabel="Agent CLI for General Agent"
                      options={agentCliOptions}
                      currentCli={generalCli}
                      effectiveModelFor={(cli) => resolveCliModel(cli, undefined, cliModelDefaults)}
                      onSelectCli={(cli) => {
                        setLastSelectedCli(cli)
                        setChipPopoverForRole(null)
                      }}
                      onSelectModel={(cli, model) => {
                        setLastSelectedCli(cli)
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
                    onClick={() => {
                      onSpawnConversation()
                      onClose()
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      if (!showOpenInNewChat) return
                      setChipPopoverForRole((current) => (current?.kind === 'conversation' ? null : { kind: 'conversation' }))
                    }}
                    className="grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pl-2.5 pr-2 text-left text-[color:var(--text-default)] transition-colors hover:bg-[rgba(92,124,255,0.05)] hover:text-[color:var(--text-strong)]"
                  >
                    <ConversationProviderIcon className="h-4 w-4 text-[color:var(--text-muted)]" />
                    <span className="truncate text-[13px]">Conversation agent</span>
                    <span aria-hidden="true" />
                  </button>
                </Tooltip>
                {showOpenInNewChat && conversationChipOpen ? (
                  // primitive-duplication-allow: nested chip menu inside the menu's floating surface, matching the General Agent row; the surrounding surface owns outside-click and focus restoration.
                  <div
                    role="menu"
                    data-chip-popover="true"
                    aria-label="Conversation agent actions"
                    // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                    className="fixed z-50 w-[180px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                  >
                    <OpenInNewChatItem
                      onSelect={() => {
                        onOpenConversationInNewChat?.()
                        setChipPopoverForRole(null)
                        onClose()
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
                const boundModel = resolveSurfaceModel(boundCli, multiloopRoleModelDefaults[soul.role])
                const popoverOpen = chipPopoverForRole?.kind === 'multiloop' && chipPopoverForRole.role === soul.role
                return (
                  <div key={soul.role} className="relative">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={highlighted}
                      onClick={() => selectMultiloopRole(soul.role, boundCli)}
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
                      <Tooltip placement="bottom" content={`Agent CLI: ${cliWithModelLabel(boundCli, boundModel)} · click to change`}>
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={`Agent CLI: ${cliWithModelLabel(boundCli, boundModel)}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            setAgentMenuHighlight(index)
                            setChipPopoverForRole((current) =>
                              current?.kind === 'multiloop' && current.role === soul.role ? null : { kind: 'multiloop', role: soul.role }
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
                        // primitive-duplication-allow: nested chip-listbox inside the menu's floating surface;
                        // anchored to a row-local `<div className="relative">` with no separate outside-click handler.
                        // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                        className="fixed z-50 w-[220px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                      >
                        <CliModelListbox
                          ariaLabel={`Agent CLI for ${soul.label}`}
                          options={agentCliOptions}
                          currentCli={boundCli}
                          effectiveModelFor={(cli) => resolveSurfaceModel(cli, multiloopRoleModelDefaults[soul.role])}
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
                const boundModel = resolveSurfaceModel(boundCli, specialistModelDefaults[action.id])
                const popoverOpen = chipPopoverForRole?.kind === 'specialist' && chipPopoverForRole.id === action.id
                const dragging = draggingSpecialistId === action.id
                const dropTarget =
                  specialistDragEnabled
                  && dragOverSpecialistId === action.id
                  && draggingSpecialistId !== null
                  && draggingSpecialistId !== action.id
                return (
                  <div
                    key={action.id}
                    className={`relative ${dragging ? 'opacity-40' : ''} ${dropTarget ? 'shadow-[inset_0_2px_0_var(--accent-primary)]' : ''}`}
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
                      onClick={() => selectSpecialist(action.id, boundCli)}
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
                      <Tooltip placement="bottom" content={`Agent CLI: ${cliWithModelLabel(boundCli, boundModel)} · click to change`}>
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={`Agent CLI: ${cliWithModelLabel(boundCli, boundModel)}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            setAgentMenuHighlight(index)
                            setChipPopoverForRole((current) =>
                              current?.kind === 'specialist' && current.id === action.id ? null : { kind: 'specialist', id: action.id }
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
                        // primitive-duplication-allow: nested chip menu inside the menu's floating surface;
                        // anchored to a row-local `<div className="relative">` with no separate outside-click handler.
                        // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                        className="fixed z-50 w-[220px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                      >
                        {showOpenInNewChat ? (
                          <>
                            <OpenInNewChatItem
                              onSelect={() => {
                                onOpenSpecialistInNewChat?.(action.id, boundCli)
                                setChipPopoverForRole(null)
                                onClose()
                              }}
                            />
                            <div className="my-1 h-px bg-[color:var(--border-subtle)]" role="separator" />
                          </>
                        ) : null}
                        <CliModelListbox
                          ariaLabel={`Agent CLI for ${action.label}`}
                          options={agentCliOptions}
                          currentCli={boundCli}
                          effectiveModelFor={(cli) => resolveSurfaceModel(cli, specialistModelDefaults[action.id])}
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
                onClick={() => onChangeAgentSpawnPermissionPreset(option.value)}
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
  )
}
