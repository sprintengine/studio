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
  resolveCliReasoning,
  resolveSurfaceModel,
  selectAgentCliCatalog,
  type AgentCliCatalogOption,
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

/**
 * The CLI an engine pick leaves as the app's default, or null when the pick
 * belongs to one agent alone.
 *
 * `appSettings.lastSelectedCli` is what every surface without a remembered CLI
 * of its own falls back to: the Sprint Engine board's role terminals, an
 * automation whose runtime is unset, the review guide, a module asking for the
 * default CLI, and an `agent_launch` over MCP that names none. Nothing wrote it
 * until this seam existed, so that fallback sat on its factory value on every
 * machine — including machines where that CLI is not installed.
 *
 * A specialist's pick stays that specialist's: it writes its own key and moves
 * nothing else (MC-2222 — one role's engine never moves another's). General is
 * the New chat engine and the app's own agent, so its pick is the one that
 * answers "which CLI does this person use".
 */
export function globalCliFromEnginePick(target: AgentComposerSelection, cli: AgentCli): AgentCli | null {
  return target.kind === 'specialist' ? null : cli
}

export type AgentComposerConfirm = (
  | { kind: 'terminal' }
  | { kind: 'general'; cli: AgentCli; model?: string | null }
  | { kind: 'conversation'; provider?: { providerId: string; modelId: string; modelLabel: string } }
  | { kind: 'specialist'; specialistId: SpecialistActionId; cli: AgentCli; model?: string | null }
) & {
  // The Skills & MCPs picks (browser-pane epic, child 7). Skills were
  // installed on pick; the spawn prefills their invocations as the agent's
  // first input, in pick order, never auto-sent. Terminal confirms ignore them.
  skills?: WorkspaceSkill[]
  // The effort level the launch runs at. Always named for general/specialist
  // (null = the CLI's own default). The host must not re-read the remembered
  // defaults for this; the same-turn miss that dropped `--model` would drop
  // the effort flag the same way.
  reasoning?: string | null
  // Optional "+ Worktree" attachment (general/specialist only): the spawn
  // creates a git worktree off the workspace repo and executes the agent in it.
  // An empty name means "derive from the agent's name at spawn".
  worktree?: { name: string }
  // MCP servers picked for this launch. They were added to the app's MCP
  // settings and synced into the workspace's CLI config on pick, so the agent
  // finds them in place; the confirm names them for the record and the chips.
  mcpServers?: AgentComposerConnector[]
}

// One picked MCP server, as the confirm carries it: identity plus the display
// bits the chip shows. `icon` falls back to the brand mark keyed off the id.
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

// The roster every composer surface offers. Terminal (a plain shell) and
// Conversation (provider-backed) launch no CLI, so they survive a machine with
// none; the roleless and specialist rows do launch one, so with none installed
// they are not built at all — a row that cannot run must not be reachable by
// click, Enter, or search, and the surfaces render the install route instead
// (MC-2093).
export function composerRosterRows({
  showTerminal,
  conversationAvailable,
  specialistActions,
  noAgentCliInstalled,
}: {
  showTerminal: boolean
  conversationAvailable: boolean
  specialistActions: SpecialistAction[]
  noAgentCliInstalled: boolean
}): ComposerRow[] {
  const rows: ComposerRow[] = []
  if (showTerminal) rows.push({ key: 'terminal', kind: 'terminal' })
  if (!noAgentCliInstalled) rows.push({ key: 'general', kind: 'general' })
  if (conversationAvailable) rows.push({ key: 'conversation', kind: 'conversation' })
  if (!noAgentCliInstalled) {
    for (const action of specialistActions) {
      rows.push({ key: `specialist:${action.id}`, kind: 'specialist', action })
    }
  }
  return rows
}

// Resolve the opening selection to a row that actually exists. The remembered
// agent is preselected when present; otherwise it falls back to the roleless
// row (else the first quick row) — so a remembered pick whose pack is now
// disabled, or a cold install, lands on a real row rather than an unselectable
// phantom. A role is never a fallback: preselecting a specialist nobody picked
// made Enter in a fresh New chat fetch that specialist's soul. Pure: the
// caller supplies the roster. This replaces SpawnAgentMenu's
// `rememberedHighlight` seam.
export function resolveInitialSelection(
  rows: ComposerRow[],
  preferred: AgentComposerSelection,
): AgentComposerSelection {
  if (rows.some((row) => rowMatchesSelection(row, preferred))) return preferred
  const first = rows.find((row) => row.kind === 'general') ?? rows[0]
  return first ? selectionForRow(first) : preferred
}

// What an agent's engine is called on screen: the runtime ("Claude Code") and
// the model picked on it ("Fable 5"), or null when the agent launches on that
// runtime's own default model.
export type EngineNames = { cliLabel: string; modelLabel: string | null }

// The engine's display names, from the catalog that produced the option. A
// model id with no catalog row keeps its id rather than borrowing a neighbour's
// label — an unlabelled model is shown as what it is, never renamed.
export function engineNames(
  options: AgentCliCatalogOption[],
  cli: AgentCli,
  model: string | undefined,
): EngineNames {
  const option = options.find((entry) => entry.value === cli)
  return {
    cliLabel: option?.label ?? cli,
    modelLabel: model ? (option?.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model) : null,
  }
}

/**
 * The installed, enabled roles in the user's order. One owner for "which roles
 * exist right now" — the spawn picker's Role control and the Automations
 * editor's Agent field read the same list, through the same pack enablement and
 * ordering, so a disabled pack disappears from both at once.
 */
export function useSpecialistRoster(): SpecialistAction[] {
  const specialistOrder = useWorkspaceStore((s) => s.appSettings.specialistOrder ?? EMPTY_SPECIALIST_ORDER)
  const disabledSpecialistPacks = useWorkspaceStore(
    (s) => s.appSettings.specialistPacks?.disabled ?? EMPTY_DISABLED_PACKS,
  )
  const sprintEngineRoleRegistry = useWorkspaceStore((s) => s.sprintEngineRoleRegistry)
  return React.useMemo(
    () =>
      orderSpecialistActions(
        specialistOrder,
        resolveEnabledSpecialists(disabledSpecialistPacks, listSpecialistPacks(sprintEngineRoleRegistry)),
      ),
    [specialistOrder, disabledSpecialistPacks, sprintEngineRoleRegistry],
  )
}

type UseAgentComposerOptions = {
  // Whether the Terminal quick row is offered (spawn surfaces yes; the
  // Automations select picker no — it chooses a soul, not a runtime session).
  showTerminal: boolean
  // Whether the Conversation quick row is offered (bound to the active standard
  // workspace's provider load).
  conversationAvailable: boolean
  // The remembered agent, preselected on open. Absent → the roleless row.
  initialSelection: AgentComposerSelection
  // MCP servers to open with already picked (the connector "New chat" entry
  // points). Seeds the picks only; each stays removable like a hand-picked one.
  initialMcpServers?: AgentComposerConnector[] | null
  /** Skills a parked New chat draft carried; absent starts with none. */
  initialSkills?: WorkspaceSkill[] | null
  /**
   * The engine this surface OPENS on for its roleless row, when the pick that
   * chose it was never written to the remembered defaults (a card's `Go`
   * picker, item 2473: choosing how to run one card must not move the engine of
   * the next New chat). Absent everywhere else, and the defaults answer exactly
   * as before.
   *
   * It is an opening position, not a lock: the first engine the person picks
   * here writes a default and retires it.
   */
  initialEngine?: { cli: AgentCli; model: string | null; reasoning: string | null } | null
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
  initialMcpServers,
  initialSkills,
  initialEngine,
}: UseAgentComposerOptions) {
  const lastSelectedCli = useWorkspaceStore((s) => normalizeSelectedCli(s.appSettings.lastSelectedCli))
  const specialistCliDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistCliDefaults ?? EMPTY_SPECIALIST_CLI_DEFAULTS,
  )
  const setSpecialistCliDefault = useWorkspaceStore((s) => s.setSpecialistCliDefault)
  const setLastSelectedCli = useWorkspaceStore((s) => s.setLastSelectedCli)
  const specialistModelDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistModelDefaults ?? EMPTY_SPECIALIST_MODEL_DEFAULTS,
  )
  const setSpecialistModelDefault = useWorkspaceStore((s) => s.setSpecialistModelDefault)
  const setSpecialistReasoningDefault = useWorkspaceStore((s) => s.setSpecialistReasoningDefault)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const hostedModelCatalogs = useWorkspaceStore((s) => s.hostedModelCatalogs)

  const specialistActions = useSpecialistRoster()
  const agentCliOptions = React.useMemo(
    () =>
      selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }, undefined, hostedModelCatalogs),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus, hostedModelCatalogs],
  )
  // General offers the same CLI + model catalog as specialists; it is just
  // another keyed agent, its defaults living under GENERAL_AGENT_ENGINE_KEY.
  const generalCliOptions = agentCliOptions

  // This machine has no agent CLI (MC-2093). The catalog is availability-
  // filtered, so an empty one on a READY registry is the honest answer — a
  // pending or failed probe leaves the annotated catalog in place and never
  // reaches here, which is what keeps a transient probe failure from emptying
  // the roster on a machine that has CLIs.
  const noAgentCliInstalled = pluginCatalogStatus === 'ready' && agentCliOptions.length === 0

  const allRows = React.useMemo<ComposerRow[]>(
    () => composerRosterRows({ showTerminal, conversationAvailable, specialistActions, noAgentCliInstalled }),
    [showTerminal, conversationAvailable, specialistActions, noAgentCliInstalled],
  )

  const [query, setQuery] = React.useState('')
  const [selection, setSelection] = React.useState<AgentComposerSelection>(() =>
    resolveInitialSelection(allRows, initialSelection),
  )
  // The Skills & MCPs picks, carried onto the confirm in pick order; state
  // dies with the composer when the surface closes.
  const [skills, setSkills] = React.useState<WorkspaceSkill[]>(() => initialSkills ?? [])
  // Optional "+ Worktree" attachment: null = off; a string (possibly empty =
  // auto-name) means the spawn should create a worktree and run the agent there.
  const [worktreeName, setWorktreeName] = React.useState<string | null>(null)
  // A surface that opened with a server in hand (the connector "New chat"
  // buttons) seeds it here; from then on it is an ordinary pick.
  const [mcpServers, setMcpServers] = React.useState<AgentComposerConnector[]>(() => initialMcpServers ?? [])

  // The parked engine, until the person picks one. Held here rather than written
  // to the store on the way in: a default the person did not choose is a default
  // they cannot see they are carrying. Every engine write below retires it,
  // because from then on the store holds the answer.
  const [openingEngine, setOpeningEngine] = React.useState(() => initialEngine ?? null)

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
      // defaults map (falling back to the shared default for first display) —
      // or the engine this surface was opened on, which is a pick that happened
      // somewhere else and was deliberately not stored.
      if (openingEngine) return resolvePickerCli(openingEngine.cli)
      return resolvePickerCli(specialistCliDefaults[GENERAL_AGENT_ENGINE_KEY] ?? lastSelectedCli)
    },
    [resolvePickerCli, specialistCliDefaults, lastSelectedCli, openingEngine],
  )
  const selectionCli = cliForSelection(selection)

  const modelForSelection = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli): string | undefined => {
      if (target.kind === 'specialist') return resolveSurfaceModel(cli, specialistModelDefaults[target.specialistId])
      if (target.kind === 'general') {
        // The opening engine answers for ITS OWN runtime only, exactly as a
        // stored pair does: a model chosen for one CLI must never surface on
        // another.
        if (openingEngine && resolvePickerCli(openingEngine.cli) === cli) return openingEngine.model ?? undefined
        return resolveSurfaceModel(cli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY])
      }
      return undefined
    },
    [specialistModelDefaults, openingEngine, resolvePickerCli],
  )

  // Display names for a selection's remembered engine. Resolved from the
  // TARGET's engine, so a caller naming one row never picks up another row's.
  const engineNamesFor = React.useCallback(
    (target: AgentComposerSelection): EngineNames => {
      const cli = cliForSelection(target)
      return engineNames(agentCliOptions, cli, modelForSelection(target, cli))
    },
    [cliForSelection, agentCliOptions, modelForSelection],
  )

  const trimmedQuery = query.trim().toLowerCase()
  const visibleRows = React.useMemo(() => {
    if (!trimmedQuery) return allRows
    return allRows.filter((row) => {
      if (row.kind === 'terminal') return 'terminal'.includes(trimmedQuery)
      if (row.kind === 'general') {
        // The roleless row wears its bound engine on spawn surfaces and reads
        // "No role" where the engine belongs to the caller, so search answers
        // to both — typing the name on the row always finds the row.
        const { cliLabel, modelLabel } = engineNamesFor({ kind: 'general' })
        return `${cliLabel} ${modelLabel ?? ''} no role`.toLowerCase().includes(trimmedQuery)
      }
      if (row.kind === 'conversation') return 'conversation agent'.includes(trimmedQuery)
      return (
        row.action.label.toLowerCase().includes(trimmedQuery) ||
        row.action.shortLabel.toLowerCase().includes(trimmedQuery) ||
        row.action.description.toLowerCase().includes(trimmedQuery)
      )
    })
  }, [allRows, trimmedQuery, engineNamesFor])

  // Keep the selection pointed at a visible row: a search that filters out the
  // current pick moves selection to the first match, so Enter always has a target.
  React.useEffect(() => {
    if (visibleRows.length === 0) return
    if (!visibleRows.some((row) => rowMatchesSelection(row, selection))) {
      setSelection(selectionForRow(visibleRows[0]))
    }
  }, [visibleRows, selection])

  // Effort reads through the same per-surface selection the model does, guarded
  // per-CLI by resolveCliReasoning so a level chosen for one CLI never surfaces
  // on another.
  const reasoningForSelection = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli): string | undefined => {
      if (target.kind === 'specialist') return resolveCliReasoning(cli, specialistModelDefaults[target.specialistId])
      if (target.kind === 'general') {
        if (openingEngine && resolvePickerCli(openingEngine.cli) === cli) return openingEngine.reasoning ?? undefined
        return resolveCliReasoning(cli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY])
      }
      return undefined
    },
    [specialistModelDefaults, openingEngine, resolvePickerCli],
  )

  // The confirm names the runtime the surface is standing on. `engine` is the
  // same-event override for a click that picks a row and launches in one
  // gesture. Without it the confirm still carries the resolved model and
  // effort — a spawn that omitted them used to re-read the remembered
  // defaults, and a write and a read in the same turn can miss, so Codex
  // launched its own default (Astra) instead of the chip the person chose.
  // `null` is the CLI's own default (no `--model` / no effort flag).
  const buildConfirm = React.useCallback(
    (target: AgentComposerSelection, engine?: { cli: AgentCli; model: string | null }): AgentComposerConfirm => {
      const picked = skills.length > 0 ? { skills } : {}
      // Worktree execution only applies to CLI agents spawned into the active
      // workspace: terminal/conversation have no agent execution.
      const worktree = worktreeName !== null ? { worktree: { name: worktreeName } } : {}
      // MCP servers reach CLI agents through their workspace config, so only
      // general/specialist confirms carry the picks.
      const servers = mcpServers.length > 0 ? { mcpServers } : {}
      if (target.kind === 'terminal') return { kind: 'terminal' }
      if (target.kind === 'conversation') return { kind: 'conversation', ...picked }
      const cli = engine?.cli ?? cliForSelection(target)
      const model = engine ? engine.model : (modelForSelection(target, cli) ?? null)
      const reasoning = reasoningForSelection(target, cli) ?? null
      if (target.kind === 'specialist') {
        return {
          kind: 'specialist',
          specialistId: target.specialistId,
          cli,
          model,
          reasoning,
          ...picked,
          ...worktree,
          ...servers,
        }
      }
      return { kind: 'general', cli, model, reasoning, ...picked, ...worktree, ...servers }
    },
    [cliForSelection, modelForSelection, reasoningForSelection, skills, worktreeName, mcpServers],
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
      // General writes its own key in the specialist map, so choosing General's
      // CLI never moves any specialist that remembers one of its own.
      else {
        setSpecialistCliDefault(GENERAL_AGENT_ENGINE_KEY, cli)
        setOpeningEngine(null)
      }
      // …and, for General only, the app-wide default every surface without a
      // CLI of its own falls back to. See globalCliFromEnginePick.
      const globalCli = globalCliFromEnginePick(target, cli)
      if (globalCli) setLastSelectedCli(globalCli)
    },
    [setSpecialistCliDefault, setLastSelectedCli],
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
        setOpeningEngine(null)
      }
      // Picking a model picks its CLI, so it moves the app-wide default on the
      // same terms the CLI picker does.
      const globalCli = globalCliFromEnginePick(target, cli)
      if (globalCli) setLastSelectedCli(globalCli)
    },
    [setSpecialistCliDefault, setSpecialistModelDefault, setLastSelectedCli],
  )
  // `null` clears the level back to the CLI's own default effort. The setter
  // keeps the model already chosen for that CLI, so clearing effort never
  // silently changes which model launches.
  const setEngineReasoning = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli, reasoning: string | null) => {
      const key = target.kind === 'specialist' ? target.specialistId : GENERAL_AGENT_ENGINE_KEY
      setSpecialistCliDefault(key, cli)
      setSpecialistReasoningDefault(key, cli, reasoning)
      // Effort is an axis OF the opening engine, not a replacement for it: a
      // level chosen here moves that level and leaves the parked model standing,
      // where picking a row retires the whole thing.
      if (target.kind !== 'specialist') {
        setOpeningEngine((held) => (held && resolvePickerCli(held.cli) === cli ? { ...held, reasoning } : held))
      }
    },
    [setSpecialistCliDefault, setSpecialistReasoningDefault, resolvePickerCli],
  )

  return {
    query,
    setQuery,
    skills,
    setSkills,
    worktreeName,
    setWorktreeName,
    mcpServers,
    setMcpServers,
    visibleRows,
    hasResults: visibleRows.length > 0,
    selection,
    setSelection,
    selectionCli,
    cliForSelection,
    modelForSelection,
    engineNamesFor,
    reasoningForSelection,
    moveSelection,
    buildConfirm,
    setEngineCli,
    setEngineModel,
    setEngineReasoning,
    // The engine this surface opened on and has not been overruled on yet, so a
    // host parking its state can park that too rather than lose it.
    openingEngine,
    agentCliOptions,
    generalCliOptions,
    // The installed, enabled roles in the user's order — the roster the spawn
    // picker's Role control offers, and the only roles a starred composition
    // can name.
    specialistActions,
    // True when this machine has no agent CLI installed: the surfaces render
    // the install route in place of the agent rows the hook withheld.
    noAgentCliInstalled,
    // Catalog load state, so pickers can say "loading" / "no plugins" instead
    // of rendering a silently thin roster.
    catalogStatus: pluginCatalogStatus,
    catalogError: pluginCatalogError,
  }
}
