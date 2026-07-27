import React from 'react'
import {
  GENERAL_AGENT_ENGINE_KEY,
  orderSpecialistActions,
  type SpecialistAction,
} from '../../../specialists/specialistActions'
import { listSpecialistPacks, resolveEnabledSpecialists } from '../../../specialists/specialistPacks'
import type {
  AgentCli,
  AgentCliModelSelection,
  SpecialistActionId,
} from '../../../types/workspace'
import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import {
  resolveAvailableAgentCli,
  resolveSurfaceModel,
  selectAgentCliCatalog,
} from '../newWorkspace/cliRuntimeOptions'
import { normalizeSelectedCli } from '../../../store/slices/settingsSlice'
import { useWorkspaceStore } from '../../../store/workspaceStore'

// Stable empty fallbacks so store selectors returning a default don't churn refs.
const EMPTY_SPECIALIST_CLI_DEFAULTS: Partial<Record<SpecialistActionId, AgentCli>> = {}
const EMPTY_SPECIALIST_MODEL_DEFAULTS: Partial<Record<SpecialistActionId, AgentCliModelSelection>> = {}
const EMPTY_SPECIALIST_ORDER: SpecialistActionId[] = []
const EMPTY_DISABLED_PACKS: string[] = []

// The agent a composer surface picks. Terminal / General / Conversation have no
// soul; a specialist carries its id. The engine (CLI/model)
// is bound to the selection and read from the store's per-agent defaults, so a
// confirm only needs the agent identity plus the resolved CLI — the model
// round-trips through the defaults.
export type AgentComposerSelection =
  | { kind: 'terminal' }
  | { kind: 'general' }
  | { kind: 'conversation' }
  | { kind: 'specialist'; specialistId: SpecialistActionId }

export type AgentComposerConfirm = (
  | { kind: 'terminal' }
  | { kind: 'general'; cli: AgentCli }
  | { kind: 'conversation' }
  | { kind: 'specialist'; specialistId: SpecialistActionId; cli: AgentCli }
) & {
  // Optional "+ Skill" attachment: the spawn ensure-installs it and prefills
  // the invocation as the agent's first input (never auto-sent). Terminal
  // confirms ignore it.
  skill?: WorkspaceSkill
  // Optional "+ Worktree" attachment (general/specialist only): the spawn
  // creates a git worktree off the workspace repo and executes the agent in it.
  // An empty name means "derive from the agent's name at spawn".
  worktree?: { name: string }
  // Optional "+ Connector" attachment (general/specialist only): the spawn
  // routes through the connector-chat runtime — an isolated connector worktree
  // whose MCP config carries only this server (plus its driving skill when the
  // catalog pairs one). Resolution happens at spawn; the confirm only names it.
  connector?: AgentComposerConnector
}

// The picked connector, as the confirm carries it: identity for the spawn's
// resolveConnectorLaunch plus the display bits the attachment chip shows.
export type AgentComposerConnector = { id: string; name: string; icon?: string }

// One roster row. Quick rows (terminal/general/conversation) precede the
// specialist roster; arrow keys rove this flat list so navigation is uniform
// across both groups.
export type ComposerRow =
  | { key: string; kind: 'terminal' }
  | { key: string; kind: 'general' }
  | { key: string; kind: 'conversation' }
  | { key: string; kind: 'specialist'; action: SpecialistAction }

export function rowMatchesSelection(row: ComposerRow, selection: AgentComposerSelection): boolean {
  if (row.kind === 'specialist') {
    return selection.kind === 'specialist' && selection.specialistId === row.action.id
  }
  return selection.kind === row.kind
}

export function selectionForRow(row: ComposerRow): AgentComposerSelection {
  if (row.kind === 'specialist') return { kind: 'specialist', specialistId: row.action.id }
  return { kind: row.kind }
}

// Resolve the opening selection to a row that actually exists. The remembered
// agent is preselected when present; otherwise it falls back to the first
// roster row (a specialist/role, else the first quick row) — so a remembered
// pick whose pack is now disabled, or a cold install, lands on a real row
// rather than an unselectable phantom. Pure: the caller supplies the roster.
// This replaces SpawnAgentMenu's `rememberedHighlight` seam.
export function resolveInitialSelection(
  rows: ComposerRow[],
  preferred: AgentComposerSelection,
): AgentComposerSelection {
  if (rows.some((row) => rowMatchesSelection(row, preferred))) return preferred
  const first = rows.find((row) => row.kind === 'specialist') ?? rows[0]
  return first ? selectionForRow(first) : preferred
}

type UseAgentComposerOptions = {
  // Whether the Terminal quick row is offered (spawn surfaces yes; the
  // Automations select picker no — it chooses a soul, not a runtime session).
  showTerminal: boolean
  // Whether the Conversation quick row is offered (bound to the active standard
  // workspace's provider load).
  conversationAvailable: boolean
  // The remembered agent, preselected on open. Absent → first roster row.
  initialSelection: AgentComposerSelection
  // Optional connector to open with already attached (the connector "New chat"
  // entry points). Seeds the attachment only; it stays removable/replaceable
  // like a hand-picked one.
  initialConnector?: AgentComposerConnector | null
}

// Shared state + store-derived data for every AgentComposer surface (the New
// Chat panel and the popover picker). Owns roster building, selection, search,
// keyboard roving, and engine (CLI/model) resolution + persistence, so each
// layout component stays presentational. Selection is the durable highlight;
// the engine controls always reflect the selected agent's remembered pair and
// persist edits as that agent's default.
export function useAgentComposer({
  showTerminal,
  conversationAvailable,
  initialSelection,
  initialConnector,
}: UseAgentComposerOptions) {
  const lastSelectedCli = useWorkspaceStore((s) => normalizeSelectedCli(s.appSettings.lastSelectedCli))
  const specialistCliDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistCliDefaults ?? EMPTY_SPECIALIST_CLI_DEFAULTS,
  )
  const setSpecialistCliDefault = useWorkspaceStore((s) => s.setSpecialistCliDefault)
  const specialistModelDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistModelDefaults ?? EMPTY_SPECIALIST_MODEL_DEFAULTS,
  )
  const setSpecialistModelDefault = useWorkspaceStore((s) => s.setSpecialistModelDefault)
  const specialistOrder = useWorkspaceStore((s) => s.appSettings.specialistOrder ?? EMPTY_SPECIALIST_ORDER)
  const disabledSpecialistPacks = useWorkspaceStore(
    (s) => s.appSettings.specialistPacks?.disabled ?? EMPTY_DISABLED_PACKS,
  )
  const sprintEngineRoleRegistry = useWorkspaceStore((s) => s.sprintEngineRoleRegistry)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)

  const specialistActions = React.useMemo(
    () =>
      orderSpecialistActions(
        specialistOrder,
        resolveEnabledSpecialists(disabledSpecialistPacks, listSpecialistPacks(sprintEngineRoleRegistry)),
      ),
    [specialistOrder, disabledSpecialistPacks, sprintEngineRoleRegistry],
  )
  const agentCliOptions = React.useMemo(
    () =>
      selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus],
  )
  // General offers the same CLI + model catalog as specialists; it is just
  // another keyed agent, its defaults living under GENERAL_AGENT_ENGINE_KEY.
  const generalCliOptions = agentCliOptions

  const allRows = React.useMemo<ComposerRow[]>(() => {
    const rows: ComposerRow[] = []
    if (showTerminal) rows.push({ key: 'terminal', kind: 'terminal' })
    rows.push({ key: 'general', kind: 'general' })
    if (conversationAvailable) rows.push({ key: 'conversation', kind: 'conversation' })
    for (const action of specialistActions) {
      rows.push({ key: `specialist:${action.id}`, kind: 'specialist', action })
    }
    return rows
  }, [showTerminal, conversationAvailable, specialistActions])

  const [query, setQuery] = React.useState('')
  const [selection, setSelection] = React.useState<AgentComposerSelection>(() =>
    resolveInitialSelection(allRows, initialSelection),
  )
  // Optional "+ Skill" attachment, carried onto the confirm. One per spawn;
  // cleared by the surface when it closes (state dies with the composer).
  const [skillAttachment, setSkillAttachment] = React.useState<WorkspaceSkill | null>(null)
  // Optional "+ Worktree" attachment: null = off; a string (possibly empty =
  // auto-name) means the spawn should create a worktree and run the agent there.
  const [worktreeName, setWorktreeName] = React.useState<string | null>(null)
  // Optional "+ Connector" attachment, carried onto the confirm like the skill.
  // A surface that opened with a connector in hand (the connector "New chat"
  // buttons) seeds it here; from then on it is ordinary attachment state.
  const [connectorAttachment, setConnectorAttachment] = React.useState<AgentComposerConnector | null>(
    initialConnector ?? null,
  )

  const trimmedQuery = query.trim().toLowerCase()
  const visibleRows = React.useMemo(() => {
    if (!trimmedQuery) return allRows
    return allRows.filter((row) => {
      if (row.kind === 'terminal') return 'terminal'.includes(trimmedQuery)
      if (row.kind === 'general') return 'general agent'.includes(trimmedQuery)
      if (row.kind === 'conversation') return 'conversation agent'.includes(trimmedQuery)
      return (
        row.action.label.toLowerCase().includes(trimmedQuery) ||
        row.action.shortLabel.toLowerCase().includes(trimmedQuery) ||
        row.action.description.toLowerCase().includes(trimmedQuery)
      )
    })
  }, [allRows, trimmedQuery])

  // Keep the selection pointed at a visible row: a search that filters out the
  // current pick moves selection to the first match, so Enter always has a target.
  React.useEffect(() => {
    if (visibleRows.length === 0) return
    if (!visibleRows.some((row) => rowMatchesSelection(row, selection))) {
      setSelection(selectionForRow(visibleRows[0]))
    }
  }, [visibleRows, selection])

  const resolvePickerCli = React.useCallback(
    (cli: AgentCli): AgentCli => resolveAvailableAgentCli(cli, agentCliOptions, agentCliOptions[0]?.value ?? cli),
    [agentCliOptions],
  )

  // The engine CLI bound to a selection.
  const cliForSelection = React.useCallback(
    (target: AgentComposerSelection): AgentCli => {
      if (target.kind === 'specialist') {
        return resolvePickerCli(specialistCliDefaults[target.specialistId] ?? lastSelectedCli)
      }
      // General is just another keyed agent: its own entry in the specialist
      // defaults map (falling back to the shared default for first display).
      return resolvePickerCli(specialistCliDefaults[GENERAL_AGENT_ENGINE_KEY] ?? lastSelectedCli)
    },
    [resolvePickerCli, specialistCliDefaults, lastSelectedCli],
  )
  const selectionCli = cliForSelection(selection)

  const modelForSelection = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli): string | undefined => {
      if (target.kind === 'specialist') return resolveSurfaceModel(cli, specialistModelDefaults[target.specialistId])
      if (target.kind === 'general') return resolveSurfaceModel(cli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY])
      return undefined
    },
    [specialistModelDefaults],
  )

  const buildConfirm = React.useCallback(
    (target: AgentComposerSelection): AgentComposerConfirm => {
      const skill = skillAttachment ? { skill: skillAttachment } : {}
      // Worktree execution only applies to CLI agents spawned into the active
      // workspace: terminal/conversation have no agent execution.
      const worktree = worktreeName !== null ? { worktree: { name: worktreeName } } : {}
      // Connectors ride the CLI spawn's isolated-worktree runtime, so only
      // general/specialist confirms carry the attachment.
      const connector = connectorAttachment ? { connector: connectorAttachment } : {}
      if (target.kind === 'terminal') return { kind: 'terminal' }
      if (target.kind === 'conversation') return { kind: 'conversation', ...skill }
      if (target.kind === 'specialist') {
        return { kind: 'specialist', specialistId: target.specialistId, cli: cliForSelection(target), ...skill, ...worktree, ...connector }
      }
      return { kind: 'general', cli: cliForSelection(target), ...skill, ...worktree, ...connector }
    },
    [cliForSelection, skillAttachment, worktreeName, connectorAttachment],
  )

  const moveSelection = React.useCallback(
    (delta: number) => {
      if (visibleRows.length === 0) return
      const index = visibleRows.findIndex((row) => rowMatchesSelection(row, selection))
      const nextIndex = Math.max(0, Math.min(visibleRows.length - 1, (index < 0 ? 0 : index) + delta))
      setSelection(selectionForRow(visibleRows[nextIndex]))
    },
    [visibleRows, selection],
  )

  // Engine persistence, keyed by the current selection.
  const setEngineCli = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli) => {
      if (target.kind === 'specialist') setSpecialistCliDefault(target.specialistId, cli)
      // General writes its own key in the specialist map — never the shared
      // lastSelectedCli, so choosing General's CLI never moves any specialist.
      else setSpecialistCliDefault(GENERAL_AGENT_ENGINE_KEY, cli)
    },
    [setSpecialistCliDefault],
  )
  const setEngineModel = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli, model: string | null) => {
      // A null model is the CLI's own default model, not "forget this CLI", so
      // it is written as an empty model rather than a cleared selection — the
      // setter then keeps a reasoning-effort level already chosen for this CLI.
      const selection = { cli, model: model ?? '' }
      if (target.kind === 'specialist') {
        setSpecialistCliDefault(target.specialistId, cli)
        setSpecialistModelDefault(target.specialistId, selection)
      } else {
        setSpecialistCliDefault(GENERAL_AGENT_ENGINE_KEY, cli)
        setSpecialistModelDefault(GENERAL_AGENT_ENGINE_KEY, selection)
      }
    },
    [setSpecialistCliDefault, setSpecialistModelDefault],
  )

  return {
    query,
    setQuery,
    skillAttachment,
    setSkillAttachment,
    worktreeName,
    setWorktreeName,
    connectorAttachment,
    setConnectorAttachment,
    visibleRows,
    hasResults: visibleRows.length > 0,
    selection,
    setSelection,
    selectionCli,
    cliForSelection,
    modelForSelection,
    moveSelection,
    buildConfirm,
    setEngineCli,
    setEngineModel,
    agentCliOptions,
    generalCliOptions,
    // Catalog load state, so pickers can say "loading" / "no plugins" instead
    // of rendering a silently thin roster.
    catalogStatus: pluginCatalogStatus,
    catalogError: pluginCatalogError,
  }
}
