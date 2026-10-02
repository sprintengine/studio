import { join } from 'node:path'

import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import { effectiveAgentLaunchSettings } from '../../shared/launch-settings'
import { isWslHostId } from '../../shared/execution-host'
import { comparablePath } from '../../shared/host-paths'
import { ensureSkillInstalled } from '../../main/builtin-skills'
import { cliResumeCapabilities } from '../../main/cli-resume-capabilities'
import {
  createAgentPermissionResolver,
  type AgentPermissionResolver,
} from '../../main/automation/launch-permission-cap'
import { createConversationGatewayHost } from '../../main/automation/tailnet/tailnet-conversation-host'
import { ConversationApprovalRuleStore } from '../../main/conversation-approval-rules'
import { ConversationAttachmentStore } from '../../main/conversation-attachment-store'
import { createConversationLaunchService } from '../../main/conversation-launch-service'
import { createConversationModelCatalog } from '../../main/conversation-model-catalog'
import { ConversationPlanStore } from '../../main/conversation-plan-store'
import { ConversationRuntime, type ConversationRuntimeOptions } from '../../main/conversation-runtime'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { installGitHostResolver } from '../../main/git-run'
import { createHostRegistry, installHostRegistry } from '../../main/hosts/host-registry'
import { createAgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { readDiscoveredCliModelCatalogs } from '../../main/model-discovery/service'
import { listPluginRegistryEntries } from '../../main/plugin-registry-instance'
import { powerActivity } from '../../main/power-activity'
import { getSharedCredentialStore } from '../../main/secret-store'
import { createWorkspaceRegistryService } from '../../main/workspace-registry-service'
import { createWorkspaceRegistryStore } from '../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../main/workspace-sync-service'
import { installedStudioPlatform, installStudioPlatform, type StudioPlatform } from '../platform/platform'
import type { StudioPaths } from '../platform/studio-paths'
import { localConversationBackend } from './conversation-backend'
import type { StudioRole } from './data-dir'
import { takeDataDir } from './take-data-dir'

// The Studio core: the services the server owns (studio-server design, section
// 4.1), composed once. The desktop builds it inside Electron main, from
// `createAppServices`, with the Electron platform; the standalone server
// (src/server/main.ts) builds it under plain Node with the Node platform. Both
// go through this function, so there is one wiring of the core and not two
// that drift.
//
// What is here: launch settings and the machines they name, the workspace
// registry and its sync, git's machine resolver, the conversation runtime and
// the backend every caller drives chats through (providers, checkpoints, the
// thread index and transcripts are the runtime's), the model catalog, and the
// launch service that starts a chat for a caller with no window. The MCP
// gateway is composed beside it (studio-gateway.ts), because the desktop adds
// tools to it that act on windows and terminals.
//
// What is not, yet: the module host and its bundled modules (they still take
// the shell's terminal runtime and account bridge), terminals (owner ruling
// 2026-10-01: not served by the server in v1), and everything the shell owns.
// What is not, ever: the browser and the canvas (owner ruling 2026-10-02: the
// server draws nothing). They are toolsets a client offers, which the gateway
// lists and routes (src/server/tools/); the server keeps only the board files,
// read and written through `files.*`.

export type StudioCoreOptions = {
  /** Which kind of process this core runs in; decides the lock and secret rules below. */
  role: StudioRole
  /**
   * How a Claude chat's child reaches this process's MCP gateway, on the machine
   * its `claude` runs on. Null for no gateway entry.
   */
  resolveStudioMcpServer?: ConversationRuntimeOptions['resolveStudioMcpServer']
  /**
   * The agent terminals this process runs, for the gateway's launch cap: an
   * agent may start agents only at its own preset or stricter. A server has
   * none (owner ruling 2026-10-01), so it defaults to an empty list.
   */
  listTerminalSessions?: () => ReadonlyArray<{
    kind?: string
    workspaceId?: string
    agentId?: string
    processAlive: boolean
    agentRecord?: { cliPermissionPreset?: unknown }
  }>
  /** A machine's settings changed (a distribution turned on or off). */
  onHostSettingsChanged?: () => void
}

export { StudioDataDirBusyError, StudioDataDirUnusableError } from './take-data-dir'

export type StudioCore = ReturnType<typeof createStudioCore>

export function createStudioCore(platform: StudioPlatform, options: StudioCoreOptions) {
  // Installed first, so a free function deep in the graph (the credential
  // store, a resource lookup) reads this platform even when the caller has not
  // installed one. The desktop's entry has already installed the same one.
  if (installedStudioPlatform() !== platform) installStudioPlatform(platform)
  const dataDir = platform.paths.dataDir()
  const taken = takeDataDir(platform, options.role)
  const dataDirLock = taken.lock

  const logDiagnostic =
    (source: 'agents' | 'workspace') =>
    (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => {
      void writeDiagnosticLog({ ...diagnostic, source })
    }

  // The agent-launch settings (CLI runtimes, MCP, knowledge roots, last CLI,
  // spawn permission preset). The core owns them: clients read and patch this
  // store, and every launch the core makes reads it.
  const agentLaunchSettings = createAgentLaunchSettingsStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('agents'),
  })

  // The machines this computer offers (shared/execution-host.ts): this one,
  // and on Windows each WSL distribution. One registry, installed for the whole
  // process, so a launch, the reaper and the git runner resolve a host against
  // the same per-machine settings.
  const hosts = createHostRegistry({ readHostSettings: () => agentLaunchSettings.get().hosts })
  installHostRegistry(hosts)
  let lastHostSettings = JSON.stringify(agentLaunchSettings.get().hosts)
  agentLaunchSettings.subscribe((record) => {
    const next = JSON.stringify(record.settings.hosts)
    if (next === lastHostSettings) return
    lastHostSettings = next
    hosts.notifyChanged()
    options.onHostSettingsChanged?.()
  })

  // The authoritative workspace registry. Routing lives in the record, so no
  // side-map of names, folders or modes is needed beside it.
  const workspaceRegistryStore = createWorkspaceRegistryStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('workspace'),
  })
  const workspaceRegistry = createWorkspaceRegistryService({
    store: workspaceRegistryStore,
    logDiagnostic: logDiagnostic('workspace'),
  })
  const workspaceSyncService = createWorkspaceSyncService({
    registry: workspaceRegistry,
    resolveResumeCapabilities: cliResumeCapabilities,
  })

  // Git for a repository on a WSL machine runs in that distribution: a folder
  // inside it (`\\wsl.localhost\<distro>\…`), or one an open workspace on that
  // machine holds. Everything else keeps this machine's git. macOS and Linux
  // have one machine, so their git never asks.
  installGitHostResolver((cwd) => {
    if (process.platform !== 'win32') return null
    const byFolder = hosts.resolve({ folder: cwd })
    if (byFolder.kind === 'wsl') return byFolder
    const owner = findWorkspaceHostForPath(cwd)
    return owner ? hosts.get(owner) : null
  })
  // The WSL machine of the open workspace whose folder holds `path`: a WSL
  // workspace whose folder sits on a Windows drive still runs its git in the
  // distribution, where its agents run theirs.
  function findWorkspaceHostForPath(path: string): string | null {
    const target = comparablePath(path)
    for (const workspace of workspaceSyncService.getSnapshot().state.workspaces) {
      if (!isWslHostId(workspace.hostId) || !workspace.folderPath) continue
      const folder = comparablePath(workspace.folderPath)
      if (target === folder || target.startsWith(`${folder}/`)) return workspace.hostId
    }
    return null
  }

  // The conversation runtime: chat sessions and the providers and agent CLI
  // children behind them, transcripts, the thread index and checkpoints. Owned
  // here so the owner's shutdown disposes its child processes.
  // The saved approvals, which a revoked app's tools leave with it.
  const approvalRules = new ConversationApprovalRuleStore(dataDir)
  const conversationRuntime = new ConversationRuntime({
    secretStore: getSharedCredentialStore(),
    approvalRules,
    attachmentStore: new ConversationAttachmentStore(dataDir),
    planStore: new ConversationPlanStore(dataDir),
    ...(options.resolveStudioMcpServer ? { resolveStudioMcpServer: options.resolveStudioMcpServer } : {}),
  })
  conversationRuntime.startIdleSweep(powerActivity)
  // What only the runtime's owner does with it: the idle threshold, and the
  // flush and shutdown at the end. Everything else goes through the backend.
  const conversationOwner = {
    setIdleThresholdMs: (value: unknown) => conversationRuntime.setIdleThresholdMs(value),
    flushTranscripts: () => conversationRuntime.flushTranscripts(),
    shutdown: () => conversationRuntime.shutdown(),
  }
  // What every caller drives chats through; the runtime itself is only for
  // what its owner does (the idle sweep, flush, shutdown).
  const conversations = localConversationBackend(conversationRuntime)

  const conversationModelCatalog = createConversationModelCatalog({
    listClis: () => listPluginRegistryEntries(),
    readDiscovered: () => readDiscoveredCliModelCatalogs(),
    userModels: (cli) => agentLaunchSettings.get().cliRuntimes[cli]?.models,
  })

  // Starting a chat for a caller with no window to start it in (a paired
  // machine's New chat, `conversation.create`, a module). The record goes
  // through the sequenced bus like any agent the core registers, so every
  // client hears about the chat the moment it exists.
  const conversationLaunchService = createConversationLaunchService({
    getWorkspace: (workspaceId) => workspaceRegistry.getRecord(workspaceId) ?? null,
    getLaunchSettings: () => agentLaunchSettings.get(),
    writeAgent: (workspaceId, agentId, agent) =>
      workspaceSyncService.updateWorkspaceAgent(workspaceId, agentId, agent, 'system'),
    listWorkspaces: () => workspaceRegistry.getRecords(),
    createWorkspace: (request) => {
      const created = workspaceSyncService.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => {
      workspaceSyncService.removeWorkspace(workspaceId, 'system')
    },
    startSession: (input) => conversations.startSession(input),
    send: (input) => conversations.sendTurn(input),
    // The same installer a terminal launch's skill-at-spawn uses, into the
    // folder the chat works in (a run's worktree when it has one).
    ensureSkillInstalled: (workingRoot, skillId) => ensureSkillInstalled(workingRoot, skillId),
    warn: (message) => {
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Chat launch', message })
    },
  })

  // What an agent of this app is running on now, for the gateway's launch cap:
  // an agent may start agents only at its own preset or stricter.
  const resolveAgentPermissionPreset: AgentPermissionResolver = createAgentPermissionResolver({
    listConversationSessions: (agentId) => {
      const listed = conversations.listSessions({ agentId })
      return listed.ok ? listed.sessions : []
    },
    listTerminalSessions: () => options.listTerminalSessions?.() ?? [],
    readAgentRecordPreset: (workspaceId, agentId) => {
      const agent = workspaceRegistry.getRecord(workspaceId)?.agents[agentId]
      return agent ? { found: true, preset: agent.cliPermissionPreset } : { found: false }
    },
  })

  /**
   * The conversation host every remote door wraps: the tailnet lane a paired
   * device follows chats through, and the Studio RPC a local app does. One
   * factory, so a chat lists, resumes and switches the same by either.
   */
  const createConversationHost = () =>
    createConversationGatewayHost(
      conversations,
      (workspaceId) => workspaceRegistry.getRecord(workspaceId)?.folderPath ?? null,
      () =>
        workspaceRegistry
          .getRecords()
          .filter((record) => Boolean(record.folderPath))
          .map((record) => ({
            workspaceId: record.id,
            workspaceRoot: record.folderPath!,
          })),
      // A chat's own agent record carries the preset the person last chose
      // for it; a chat without one starts on the app-wide spawn default, as a
      // new chat in a window does.
      (key) =>
        parseCliPermissionPreset(
          workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.cliPermissionPreset,
        ) ?? effectiveAgentLaunchSettings(agentLaunchSettings.get()).lastAgentSpawnPermissionPreset,
      // The agent record's name — the same record, and the same field, this
      // desktop's tab and sidebar read — so a remote lists the chat by the
      // name it has here rather than by its first message.
      (key) => workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.name,
      // The chat's CLI catalog as this machine's own picker lists it, so a
      // paired device offers the same models and can switch to no other.
      conversationModelCatalog,
    )

  /**
   * The core's own end, for a process that owns nothing else: the registry
   * flushed around the chats' end, the machines' helpers told to stop, the
   * data directory let go. The desktop runs the same steps as legs of its own
   * quit (app-lifecycle.ts), interleaved with the shell's.
   *
   * The lock is let go last, once the chats' shutdown has closed every
   * transcript, so a process that takes the directory next never finds a log
   * still being written. A stop cut short leaves the lock to be found
   * abandoned instead.
   */
  async function shutdown(): Promise<void> {
    const legs: Array<() => unknown> = [
      () => workspaceSyncService.flush(),
      () => conversationRuntime.flushTranscripts(),
      () => conversationRuntime.shutdown(),
      () => workspaceSyncService.flush(),
      () => hosts.dispose(),
    ]
    for (const leg of legs) {
      try {
        await leg()
      } catch {
        // Best effort, leg by leg: the process is leaving either way.
      }
    }
    dataDirLock?.release()
  }

  return {
    platform,
    role: options.role,
    /** Null only in a desktop that could not take the directory and carried on, as builds before the lock did. */
    dataDirLock,
    /** Resolves once a Studio server this desktop displaced has exited; a gateway or socket opens after it. */
    whenDataDirFree: taken.whenFree,
    agentLaunchSettings,
    hosts,
    workspaceRegistry,
    workspaceSyncService,
    conversations,
    conversationOwner,
    approvalRules,
    conversationModelCatalog,
    conversationLaunchService,
    resolveAgentPermissionPreset,
    createConversationHost,
    shutdown,
  }
}

/**
 * The stdio bridge agents run to reach the gateway: shipped under
 * `resources/automation`, which an installed build unpacks into its resources
 * directory and a source checkout keeps at its root.
 */
export function studioBridgeScriptPath(paths: StudioPaths): string {
  const root = paths.isPackaged() ? paths.resourcesDir() : join(paths.appRoot() ?? process.cwd(), 'resources')
  return join(root ?? '', 'automation', 'mcp-stdio-bridge.mjs')
}
