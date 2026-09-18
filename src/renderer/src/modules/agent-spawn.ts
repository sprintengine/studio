// Agent spawn + tab focus for module renderers (RendererHost.spawnAgent /
// focusTab / listAgentRuntimes). The hard rule: spawns route through the
// SHARED session runtime — the same terminalSpawn path every shell surface
// uses — never a bespoke PTY. Ports are injected so the contract is
// unit-testable; modules/index wires the real store/api/layout helpers at
// boot.

/** One model a runtime offers, as a picker row. */
export type ModuleAgentRuntimeModelOption = {
  /** Model id to pass as `spawnAgent`'s `cliModel`. */
  id: string
  /** Display label; falls back to the id when the catalog names none. */
  label: string
}

export type ModuleAgentRuntimeOption = {
  /** Runtime id to pass as `spawnAgent`'s `cli` (e.g. 'claude', 'codex'). */
  id: string
  /** Display label for pickers. */
  label: string
  /**
   * Whether this machine has the runtime's binary. False rows are still
   * listed — a module that builds its own picker shows them disabled rather
   * than pretending the CLI does not exist — but spawning one fails.
   */
  available: boolean
  /**
   * The model ids this runtime offers, merged from the plugin manifest, what
   * the CLI reported about itself, and the ids the user added. Empty means the
   * runtime exposes no model choice, so launch with its own default.
   */
  models: ModuleAgentRuntimeModelOption[]
  /** True for the runtime the user last chose — what a picker preselects. */
  isDefault: boolean
}

export type ModuleSpawnAgentInput = {
  workspaceId: string
  /** Display name for the agent tab; defaults to a shell-picked agent name. */
  name?: string
  /** Runtime id from `listAgentRuntimes()`; defaults to the user's last-used CLI. */
  cli?: string
  /** Model id for the runtime; omitted = the CLI's default model. */
  cliModel?: string
  /** Launch prompt handed to the agent once the session starts. */
  prompt?: string
  /** Focus the new agent's tab (default true). */
  focus?: boolean
}

export type ModuleSpawnAgentResult =
  | { ok: true; agentId: string }
  | { ok: false; code: 'unknown_workspace' | 'missing_folder' | 'unknown_runtime' | 'spawn_failed'; message: string }

export type ModuleFocusTabInput = {
  workspaceId: string
  kind: 'agent' | 'file'
  /** Agent id, or a workspace-relative file path. */
  id: string
}

export type AgentSpawnPorts = {
  getWorkspace: (
    workspaceId: string,
  ) => { folderPath: string | null; agents: Array<{ id: string; name: string }> } | null
  /** Upserts the agent record ahead of the spawn (the store's updateAgent). */
  upsertAgent: (workspaceId: string, agentId: string, patch: { name: string; cli: string; cliModel?: string }) => void
  /** Rolls the record back when the spawn fails (the store's removeAgent). */
  removeAgent: (workspaceId: string, agentId: string) => void
  /** The SHARED session runtime spawn (window.api.terminalSpawn, curried). */
  spawnTerminal: (input: {
    sessionId: string
    cwd: string
    cli: string
    prompt?: string
    workspaceId: string
    agentId: string
    cliModel?: string
  }) => Promise<{ ok: boolean; message?: string }>
  /** Focus (or add) the agent's layout tab. */
  revealAgentTab: (workspaceId: string, agentId: string, name: string) => void
  focusFileTab: (workspaceId: string, absolutePath: string) => boolean
  listRuntimes: () => ModuleAgentRuntimeOption[]
  defaultCli: () => string | null
  pickAgentName: (existingNames: string[]) => string
  newAgentId: () => string
  newSessionId: () => string
}

export type ModuleAgentSpawner = {
  spawnAgent: (input: ModuleSpawnAgentInput) => Promise<ModuleSpawnAgentResult>
  focusTab: (input: ModuleFocusTabInput) => boolean
  listAgentRuntimes: () => ModuleAgentRuntimeOption[]
}

export function createModuleAgentSpawner(ports: AgentSpawnPorts): ModuleAgentSpawner {
  return {
    async spawnAgent(input) {
      const workspace = ports.getWorkspace(input.workspaceId)
      if (!workspace) {
        return { ok: false, code: 'unknown_workspace', message: `Workspace "${input.workspaceId}" is not open.` }
      }
      if (!workspace.folderPath) {
        return { ok: false, code: 'missing_folder', message: 'The workspace has no project folder to run an agent in.' }
      }
      const runtimes = ports.listRuntimes()
      // An EXPLICIT runtime pick must exist; with no pick, prefer the user's
      // last-used CLI only while it is actually available (its binary can be
      // uninstalled), else any available runtime.
      const defaultCli = ports.defaultCli()
      const cli =
        input.cli ??
        (defaultCli && runtimes.some((runtime) => runtime.id === defaultCli) ? defaultCli : runtimes[0]?.id)
      if (!cli || !runtimes.some((runtime) => runtime.id === cli)) {
        return {
          ok: false,
          code: 'unknown_runtime',
          message: `Agent runtime "${cli ?? '(none)'}" is not available — pick one from listAgentRuntimes().`,
        }
      }
      const agentId = ports.newAgentId()
      const name = input.name?.trim() || ports.pickAgentName(workspace.agents.map((agent) => agent.name))
      // Record first, spawn second: the session's lifecycle events key off the
      // agent record, and the tab reveal needs it to exist.
      ports.upsertAgent(input.workspaceId, agentId, { name, cli, cliModel: input.cliModel })
      const spawn = await ports.spawnTerminal({
        sessionId: ports.newSessionId(),
        cwd: workspace.folderPath,
        cli,
        prompt: input.prompt,
        workspaceId: input.workspaceId,
        agentId,
        cliModel: input.cliModel,
      })
      if (!spawn.ok) {
        // Roll the pre-spawn record back — a failed spawn must not leave a
        // ghost agent in the persisted workspace store.
        ports.removeAgent(input.workspaceId, agentId)
        return { ok: false, code: 'spawn_failed', message: spawn.message ?? 'Failed to start the agent session.' }
      }
      if (input.focus !== false) {
        ports.revealAgentTab(input.workspaceId, agentId, name)
      }
      return { ok: true, agentId }
    },

    focusTab(input) {
      if (input.kind === 'agent') {
        const workspace = ports.getWorkspace(input.workspaceId)
        // Unknown agent ids return false instead of minting a phantom tab;
        // known ones reveal under their real display name, never the raw id.
        const agent = workspace?.agents.find((candidate) => candidate.id === input.id)
        if (!agent) return false
        ports.revealAgentTab(input.workspaceId, input.id, agent.name)
        return true
      }
      const workspace = ports.getWorkspace(input.workspaceId)
      if (!workspace?.folderPath) return false
      if (input.id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input.id) || input.id.split(/[\\/]+/).includes('..')) {
        return false
      }
      const separator = workspace.folderPath.includes('\\') && !workspace.folderPath.includes('/') ? '\\' : '/'
      const absolutePath = `${workspace.folderPath.replace(/[\\/]+$/, '')}${separator}${input.id}`
      return ports.focusFileTab(input.workspaceId, absolutePath)
    },

    listAgentRuntimes() {
      return ports.listRuntimes()
    },
  }
}
