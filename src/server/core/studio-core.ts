import { mkdirSync } from 'node:fs'
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
import {
  acquireDataDirLock,
  readDataDirSecrets,
  recordDataDirSecrets,
  type DataDirHolder,
  type DataDirLock,
  type StudioRole,
} from './data-dir'

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
// 2026-10-01: not served by the server in v1), the canvas worker and the
// browser tools (the render host, phase 5), and everything the shell owns.

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

/** Another process holds the data directory. Thrown to a server, which exits rather than run as a second writer. */
export class StudioDataDirBusyError extends Error {
  constructor(
    message: string,
    readonly holder: DataDirHolder,
  ) {
    super(message)
    this.name = 'StudioDataDirBusyError'
  }
}

export type StudioCore = ReturnType<typeof createStudioCore>

export function createStudioCore(platform: StudioPlatform, options: StudioCoreOptions) {
  // Installed first, so a free function deep in the graph (the credential
  // store, a resource lookup) reads this platform even when the caller has not
  // installed one. The desktop's entry has already installed the same one.
  if (installedStudioPlatform() !== platform) installStudioPlatform(platform)
  const dataDir = platform.paths.dataDir()
  mkdirSync(dataDir, { recursive: true })

  const dataDirLock = takeDataDir(platform, options.role)

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
  const conversationRuntime = new ConversationRuntime({
    secretStore: getSharedCredentialStore(),
    approvalRules: new ConversationApprovalRuleStore(dataDir),
    attachmentStore: new ConversationAttachmentStore(dataDir),
    planStore: new ConversationPlanStore(dataDir),
    ...(options.resolveStudioMcpServer ? { resolveStudioMcpServer: options.resolveStudioMcpServer } : {}),
  })
  conversationRuntime.startIdleSweep(powerActivity)
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
    /** Null only in a desktop that found the directory held and carried on, as builds before the lock did. */
    dataDirLock,
    agentLaunchSettings,
    hosts,
    workspaceRegistry,
    workspaceSyncService,
    conversationRuntime,
    conversations,
    conversationModelCatalog,
    conversationLaunchService,
    resolveAgentPermissionPreset,
    createConversationHost,
    shutdown,
  }
}

/**
 * Take the data directory and settle whose cipher seals it. A server refuses a
 * held directory, and refuses to seal into one the desktop's keychain sealed
 * (its entry hands it a cipher that is off there). The desktop never refuses
 * to start: a held directory, or one a server sealed, is reported and the app
 * runs as it did before either existed.
 */
function takeDataDir(platform: StudioPlatform, role: StudioRole): DataDirLock | null {
  const dataDir = platform.paths.dataDir()
  const taken = acquireDataDirLock(dataDir, role)
  if (!taken.ok && role === 'server') throw new StudioDataDirBusyError(taken.message, taken.holder)
  if (!taken.ok) {
    void writeDiagnosticLog({
      level: 'warning',
      source: 'workspace',
      title: 'Data directory in use',
      message: taken.message,
    })
  }

  const sealedBy = readDataDirSecrets(dataDir)
  if (role === 'desktop') {
    if (sealedBy === 'server-key') {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Secrets sealed by a Studio server',
        message:
          "This data directory's secrets were sealed by a standalone Studio server, which the app's keychain cannot open. Saved keys read as not set here.",
      })
    } else {
      recordDataDirSecrets(dataDir, 'desktop-keychain')
    }
  } else if (sealedBy === 'desktop-keychain') {
    if (platform.secrets.available()) {
      if (taken.ok) taken.lock.release()
      throw new Error(
        `${dataDir} holds secrets the desktop's keychain sealed; a server there must run with its secrets off.`,
      )
    }
  } else if (platform.secrets.available()) {
    recordDataDirSecrets(dataDir, 'server-key')
  }
  return taken.ok ? taken.lock : null
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
