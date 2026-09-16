import React from 'react'
import type { AgentCli } from '../../../types/workspace'
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

// The agent a composer surface picks. The engine (CLI/model) is bound to the
// selection and read from the store's remembered defaults, so a confirm only
// needs the agent identity plus the resolved CLI — the model round-trips
// through the defaults.
export type AgentComposerSelection =
  | { kind: 'terminal' }
  | { kind: 'general' }
  | { kind: 'conversation' }

export type AgentComposerConfirm = (
  | { kind: 'terminal' }
  | { kind: 'general'; cli: AgentCli; model?: string | null }
  | { kind: 'conversation'; provider?: { providerId: string; modelId: string; modelLabel: string } }
) & {
  // The Skills & MCPs picks (browser-pane epic, child 7). Skills were
  // installed on pick; the spawn prefills their invocations as the agent's
  // first input, in pick order, never auto-sent. Terminal confirms ignore them.
  skills?: WorkspaceSkill[]
  // The effort level the launch runs at. Always named for a General spawn
  // (null = the CLI's own default). The host must not re-read the remembered
  // defaults for this; the same-turn miss that dropped `--model` would drop
  // the effort flag the same way.
  reasoning?: string | null
  // Optional "+ Worktree" attachment (General only): the spawn creates a git
  // worktree off the workspace repo and executes the agent in it. An empty name
  // means "derive from the agent's name at spawn".
  worktree?: { name: string }
  // MCP servers picked for this launch. They were added to the app's MCP
  // settings and synced into the workspace's CLI config on pick, so the agent
  // finds them in place; the confirm names them for the record and the chips.
  mcpServers?: AgentComposerConnector[]
}

// One picked MCP server, as the confirm carries it: identity plus the display
// bits the chip shows. `icon` falls back to the brand mark keyed off the id.
export type AgentComposerConnector = { id: string; name: string; icon?: string }

// One roster row. Arrow keys rove this flat list so navigation is uniform.
export type ComposerRow =
  | { key: string; kind: 'terminal' }
  | { key: string; kind: 'general' }
  | { key: string; kind: 'conversation' }

export function rowMatchesSelection(row: ComposerRow, selection: AgentComposerSelection): boolean {
  return selection.kind === row.kind
}

export function selectionForRow(row: ComposerRow): AgentComposerSelection {
  return { kind: row.kind }
}

// The roster every composer surface offers. Terminal (a plain shell) and
// Conversation (provider-backed) launch no CLI, so they survive a machine with
// none; the General row does launch one, so with none installed it is not built
// at all — a row that cannot run must not be reachable by click, Enter, or
// search, and the surfaces render the install route instead (MC-2093).
export function composerRosterRows({
  showTerminal,
  conversationAvailable,
  noAgentCliInstalled,
}: {
  showTerminal: boolean
  conversationAvailable: boolean
  noAgentCliInstalled: boolean
}): ComposerRow[] {
  const rows: ComposerRow[] = []
  if (showTerminal) rows.push({ key: 'terminal', kind: 'terminal' })
  if (!noAgentCliInstalled) rows.push({ key: 'general', kind: 'general' })
  if (conversationAvailable) rows.push({ key: 'conversation', kind: 'conversation' })
  return rows
}

// Resolve the opening selection to a row that actually exists. The remembered
// agent is preselected when present; otherwise it falls back to the General row
// (else the first quick row) — so a cold install lands on a real row rather
// than an unselectable phantom. Pure: the caller supplies the roster.
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

type UseAgentComposerOptions = {
  // Whether the Terminal quick row is offered.
  showTerminal: boolean
  // Whether the Conversation quick row is offered (bound to the active standard
  // workspace's provider load).
  conversationAvailable: boolean
  // The remembered agent, preselected on open. Absent → the General row.
  initialSelection: AgentComposerSelection
  // MCP servers to open with already picked (the connector "New chat" entry
  // points). Seeds the picks only; each stays removable like a hand-picked one.
  initialMcpServers?: AgentComposerConnector[] | null
  /** Skills a parked New chat draft carried; absent starts with none. */
  initialSkills?: WorkspaceSkill[] | null
  /**
   * The engine this surface OPENS on, when the pick that chose it was never
   * written to the remembered defaults (a card's `Go` picker, item 2473:
   * choosing how to run one card must not move the engine of the next New
   * chat). Absent everywhere else, and the defaults answer exactly as before.
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
  const setLastSelectedCli = useWorkspaceStore((s) => s.setLastSelectedCli)
  const lastSelectedAgentModel = useWorkspaceStore((s) => s.appSettings.lastSelectedAgentModel ?? null)
  const setLastSelectedAgentModel = useWorkspaceStore((s) => s.setLastSelectedAgentModel)
  const setLastSelectedAgentReasoning = useWorkspaceStore((s) => s.setLastSelectedAgentReasoning)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const hostedModelCatalogs = useWorkspaceStore((s) => s.hostedModelCatalogs)

  const agentCliOptions = React.useMemo(
    () =>
      selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }, undefined, hostedModelCatalogs),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus, hostedModelCatalogs],
  )
  // This machine has no agent CLI (MC-2093). The catalog is availability-
  // filtered, so an empty one on a READY registry is the honest answer — a
  // pending or failed probe leaves the annotated catalog in place and never
  // reaches here, which is what keeps a transient probe failure from emptying
  // the roster on a machine that has CLIs.
  const noAgentCliInstalled = pluginCatalogStatus === 'ready' && agentCliOptions.length === 0

  const allRows = React.useMemo<ComposerRow[]>(
    () => composerRosterRows({ showTerminal, conversationAvailable, noAgentCliInstalled }),
    [showTerminal, conversationAvailable, noAgentCliInstalled],
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

  // The engine CLI bound to a selection: the app-wide remembered CLI, or the
  // engine this surface was opened on — a pick that happened somewhere else and
  // was deliberately not stored.
  const cliForSelection = React.useCallback(
    (_target: AgentComposerSelection): AgentCli => {
      if (openingEngine) return resolvePickerCli(openingEngine.cli)
      return resolvePickerCli(lastSelectedCli)
    },
    [resolvePickerCli, lastSelectedCli, openingEngine],
  )
  const selectionCli = cliForSelection(selection)

  const modelForSelection = React.useCallback(
    (target: AgentComposerSelection, cli: AgentCli): string | undefined => {
      if (target.kind !== 'general') return undefined
      // The opening engine answers for ITS OWN runtime only, exactly as a
      // stored pair does: a model chosen for one CLI must never surface on
      // another.
      if (openingEngine && resolvePickerCli(openingEngine.cli) === cli) return openingEngine.model ?? undefined
      return resolveSurfaceModel(cli, lastSelectedAgentModel ?? undefined)
    },
    [lastSelectedAgentModel, openingEngine, resolvePickerCli],
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
        // The General row wears its bound engine, so typing the runtime's or
        // the model's name always finds the row.
        const { cliLabel, modelLabel } = engineNamesFor({ kind: 'general' })
        return `${cliLabel} ${modelLabel ?? ''}`.toLowerCase().includes(trimmedQuery)
      }
      return 'conversation agent'.includes(trimmedQuery)
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
      if (target.kind !== 'general') return undefined
      if (openingEngine && resolvePickerCli(openingEngine.cli) === cli) return openingEngine.reasoning ?? undefined
      return resolveCliReasoning(cli, lastSelectedAgentModel ?? undefined)
    },
    [lastSelectedAgentModel, openingEngine, resolvePickerCli],
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
      // the General confirm carries the picks.
      const servers = mcpServers.length > 0 ? { mcpServers } : {}
      if (target.kind === 'terminal') return { kind: 'terminal' }
      if (target.kind === 'conversation') return { kind: 'conversation', ...picked }
      const cli = engine?.cli ?? cliForSelection(target)
      const model = engine ? engine.model : (modelForSelection(target, cli) ?? null)
      const reasoning = reasoningForSelection(target, cli) ?? null
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

  // Engine persistence. `appSettings.lastSelectedCli` is what every surface
  // without a CLI of its own falls back to: an automation whose runtime is
  // unset, the review guide, a module asking for the default CLI, and an
  // `agent_launch` over MCP that names none. A pick here is what writes it.
  const setEngineCli = React.useCallback(
    (_target: AgentComposerSelection, cli: AgentCli) => {
      setLastSelectedCli(cli)
      setOpeningEngine(null)
    },
    [setLastSelectedCli],
  )
  const setEngineModel = React.useCallback(
    (_target: AgentComposerSelection, cli: AgentCli, model: string | null) => {
      // A null model is the CLI's own default model, not "forget this CLI", so
      // it is written as an empty model rather than a cleared selection — the
      // setter then keeps a reasoning-effort level already chosen for this CLI.
      setLastSelectedAgentModel({ cli, model: model ?? '' })
      setOpeningEngine(null)
      // Picking a model picks its CLI, so it moves the app-wide default on the
      // same terms the CLI picker does.
      setLastSelectedCli(cli)
    },
    [setLastSelectedAgentModel, setLastSelectedCli],
  )
  // `null` clears the level back to the CLI's own default effort. The setter
  // keeps the model already chosen for that CLI, so clearing effort never
  // silently changes which model launches.
  const setEngineReasoning = React.useCallback(
    (_target: AgentComposerSelection, cli: AgentCli, reasoning: string | null) => {
      setLastSelectedCli(cli)
      setLastSelectedAgentReasoning(cli, reasoning)
      // Effort is an axis OF the opening engine, not a replacement for it: a
      // level chosen here moves that level and leaves the parked model standing,
      // where picking a row retires the whole thing.
      setOpeningEngine((held) => (held && resolvePickerCli(held.cli) === cli ? { ...held, reasoning } : held))
    },
    [setLastSelectedCli, setLastSelectedAgentReasoning, resolvePickerCli],
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
    // True when this machine has no agent CLI installed: the surfaces render
    // the install route in place of the agent rows the hook withheld.
    noAgentCliInstalled,
    // Catalog load state, so pickers can say "loading" / "no plugins" instead
    // of rendering a silently thin roster.
    catalogStatus: pluginCatalogStatus,
    catalogError: pluginCatalogError,
  }
}
