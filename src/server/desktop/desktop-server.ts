import { homedir } from 'node:os'

import { SHELL_TOOLSETS, serverAutomationTools } from './shell-toolsets'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import { applyGatewayLaunchTokenChange, type LaunchTokenChange } from '../core/gateway-launch-tokens'
import { createTailnetTools, type TailnetToolsFrontDoor } from '../../main/automation/tailnet/tailnet-tools'
import { cliResumeCapabilities } from '../../main/cli-resume-capabilities'
import { createConversationAttentionListener } from '../../main/conversation-attention'
import { createConversationTerminalHandoff } from '../../main/conversation-terminal-handoff'
import { setDiagnosticsLogName, writeDiagnosticLog } from '../../main/diagnostics-service'
import { createFilesystemReadHandlers } from '../../main/filesystem-read'
import { createFilesystemWatchSearchHandlers } from '../../main/filesystem-watch-search-handlers'
import { GitHubTokenStore } from '../../main/github-token-store'
import { buildLauncherMcpServer, usableLocalLauncherRef } from '../../main/integrations/launcher'
import {
  discoverAndBroadcastCliModels,
  setCliModelDiscoveryRuntimesResolver,
} from '../../main/ipc/cli-model-discovery-ipc'
import { getPluginRegistry } from '../../main/plugin-registry-instance'
import { powerActivity } from '../../main/power-activity'
import { declaredPermissionPresets } from '../../main/plugin-render'
import { getSharedCredentialStore } from '../../main/secret-store'
import { readStudioEnvironmentId } from '../../main/studio-rpc/studio-rpc-service'
import { createTailnetNotifier } from '../../main/tailnet-notifications'
import { createWorkspaceBackupService } from '../../main/workspace-backup'
import { isWslHostId } from '../../shared/execution-host'
import { effectiveAgentLaunchSettings } from '../../shared/launch-settings'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../../shared/product-identity'
import { TAILNET_EVENT_CHANNEL } from '../../shared/tailnet'
import { MESH_EVENT_CHANNEL } from '../../shared/tailnet-mesh'
import type { ModuleRegistrySnapshot } from '../../shared/modules/registry-snapshot'
import { SERVER_EXIT } from '../bootstrap/envelope'
import type { RunningServer, ServerStart } from '../bootstrap/serve'
import { runShutdownLegs } from '../bootstrap/serve'
import {
  createStudioCore,
  StudioDataDirBusyError,
  StudioDataDirUnusableError,
  studioBridgeScriptPath,
} from '../core/studio-core'
import { createStudioGateway, type StudioGateway } from '../core/studio-gateway'
import { createStudioRpc } from '../core/studio-rpc'
import { createIpcTunnel, type TunnelPort } from '../ipc/ipc-tunnel'
import { createStaticAppIdentity } from '../platform/app-identity'
import { installStudioPlatform, type StudioPlatform } from '../platform/platform'
import { createNodeStudioPaths } from '../platform/studio-paths'
import { createRemoteShellBridge } from '../shell-bridge/remote'
import { createShellSecretCipher, meshSealedTokens } from '../shell-bridge/shell-cipher'
import { createServerGatewayBackends } from './gateway-backends'
import { registerServerDomainIpc } from './server-ipc'
import {
  SERVER_EVENTS,
  SERVER_METHODS,
  SHELL_METHODS,
  type PowerHint,
  type ServerInfo,
  type ServerMirrorLaunchSettings,
  type ServerMirrorRegistry,
  type ServerMirrorState,
} from './server-methods'
import { createServerModules } from './server-modules'

// The desktop's own Studio server, out of process (phase 6 spec): the core,
// its gateway and owner socket, the tunnelled window.api domains, and the
// module kernel with every module's server half, composed in a utility
// process the shell forked. What it asks of the shell (the keychain, a
// notification, a terminal launch) goes over the control channel; what the
// shell needs of it (the workspace registry and launch settings it mirrors,
// a credential for a terminal launch, the GitHub token) is answered there too.
//
// It takes the data directory's run lock with the desktop role, as main does
// in process: it is the app's own process tree, and a predecessor's lock is
// its to replace (the supervisor never forks while that predecessor lives).
//
// The gateway lists the core's tools and the server-side automation tools;
// what acts on a screen or a terminal is the shell's, offered as its toolsets
// (spec 6.3), and the launches the server starts itself (`backlog.work`, a
// scheduled run, resume in terminal) go through the shell bridge.

export const startDesktopServer: ServerStart = async ({ envelope, rpc, log, requestExit }) => {
  // Its own diagnostics file, so two processes never append to one.
  setDiagnosticsLogName('diagnostics-server')
  const bridge = createRemoteShellBridge(rpc)
  const cipher = createShellSecretCipher(bridge, {
    available: envelope.secrets.kind === 'shell' ? envelope.secrets.available : false,
  })
  // The mesh store opens its tokens as it is built; they are opened ahead.
  await cipher.prime(meshSealedTokens(envelope.dataDir))

  const tunnel = createIpcTunnel({ log })
  const platform: StudioPlatform = {
    paths: createNodeStudioPaths({
      dataDir: envelope.dataDir,
      logsDir: envelope.logsDir,
      packaged: envelope.paths.isPackaged,
      resourcesDir: envelope.paths.resourcesDir,
      appRoot: envelope.paths.appPath,
    }),
    secrets: cipher,
    clients: tunnel.bus,
    // A click on a notice goes where the notice names, which the shell
    // carries out: no closure crosses the channel.
    notifier: {
      notify: (notice) =>
        bridge.notify({
          key: notice.key,
          title: notice.title,
          ...(notice.body ? { body: notice.body } : {}),
          ...(notice.activate ? { activate: notice.activate } : {}),
        }),
    },
    identity: createStaticAppIdentity({ version: envelope.app.version }),
  }
  installStudioPlatform(platform)

  // Hints from the shell (6.3): what windows show and whether one has focus.
  let anyWindowVisible = true
  let appFocused = false
  rpc.on(SERVER_EVENTS.hintVisibility, (payload) => {
    anyWindowVisible = (payload as { anyWindowVisible?: unknown })?.anyWindowVisible !== false
  })
  rpc.on(SERVER_EVENTS.hintFocus, (payload) => {
    appFocused = (payload as { appFocused?: unknown })?.appFocused === true
    powerActivity.noteFocus(appFocused)
  })

  // The shell's terminals, as the gateway reads them (the launch cap,
  // `backlog.work`'s confirmation), and the launch tokens they were issued.
  let terminalSessions: TerminalSessionSnapshot[] = []
  rpc.on(SERVER_EVENTS.terminalSessions, (payload) => {
    if (Array.isArray(payload)) terminalSessions = payload as TerminalSessionSnapshot[]
  })
  rpc.on(SERVER_EVENTS.launchTokens, (payload) => {
    const update = payload as { reset?: boolean; changes?: LaunchTokenChange[] } | null
    for (const change of update?.changes ?? []) applyGatewayLaunchTokenChange(change)
  })

  let gateway: StudioGateway | null = null
  const whenAgentLaunchReady = async (): Promise<void> => {
    await Promise.all([gateway?.whenGatewayReady(), bridge.integrationsReady()])
  }

  let core: ReturnType<typeof createStudioCore>
  try {
    core = createStudioCore(platform, {
      role: 'desktop',
      // An agent may start agents only at its own preset or stricter; the
      // terminal agents it is read for are the shell's.
      listTerminalSessions: () => terminalSessions,
      // A Claude chat's child is handed the gateway itself, through the
      // launcher the shell writes (decision R63), or this build's binary run
      // as Node when the launcher could not be written. A WSL machine's
      // helper is the shell's and none is configured here, so a chat there
      // does not start out of process until WSL servers (phase 7).
      resolveStudioMcpServer: async ({ hostId }) => {
        if (isWslHostId(hostId ?? null)) return null
        await whenAgentLaunchReady()
        const launcher = usableLocalLauncherRef(homedir())
        const entry: { command: string; args: string[]; env: Record<string, string> } = launcher
          ? { ...buildLauncherMcpServer(launcher), env: { SPRINTENGINE_USER_DATA_DIR: envelope.dataDir } }
          : {
              command: envelope.paths.appExecPath,
              args: [studioBridgeScriptPath(platform.paths)],
              env: { ELECTRON_RUN_AS_NODE: '1', SPRINTENGINE_USER_DATA_DIR: envelope.dataDir },
            }
        return { id: STUDIO_MCP_SERVER_ID, name: STUDIO_MCP_SERVER_NAME, transport: 'stdio', ...entry }
      },
    })
  } catch (error) {
    if (error instanceof StudioDataDirBusyError) throw Object.assign(error, { exitCode: SERVER_EXIT.dataDirBusy })
    if (error instanceof StudioDataDirUnusableError) {
      throw Object.assign(error, { exitCode: SERVER_EXIT.dataDirUnusable })
    }
    throw error
  }
  const { agentLaunchSettings, workspaceRegistry, workspaceSyncService, conversations } = core
  // The model discovery a pass the server starts itself runs with the
  // person's own per-CLI commands, as in process.
  setCliModelDiscoveryRuntimesResolver(() => agentLaunchSettings.get().cliRuntimes)

  // The renderer's module registry, which the shell mirrors and passes on.
  let moduleRegistry: ModuleRegistrySnapshot | null = null
  rpc.on(SERVER_EVENTS.moduleRegistrySnapshot, (payload) => {
    if (payload && typeof payload === 'object') moduleRegistry = payload as ModuleRegistrySnapshot
  })

  const permissionPresetsForCli = (cli: string) => {
    const plugin = getPluginRegistry()
      .loaded()
      .find((candidate) => candidate.manifest.id === cli)
    return plugin ? declaredPermissionPresets(plugin.manifest) : null
  }

  // OS notifications for pairing and reachability, only while no window has
  // focus; a click opens the Remote popover, which the shell does.
  let tailnetFrontDoor: TailnetToolsFrontDoor | null = null
  const tailnetNotifier = createTailnetNotifier({
    isAnyWindowFocused: () => appFocused,
    isEnabled: () => gateway?.getTailnetStatus().notifications ?? false,
    openRemote: () => void bridge.reveal.tab({ kind: 'remote' }),
    show: (notice) => bridge.notify({ ...notice, activate: { kind: 'remote' } }),
  })

  const modules = createServerModules({ platform, core, log })
  gateway = createStudioGateway(core, {
    onTailnetEvent: (payload) => {
      tunnel.publish(TAILNET_EVENT_CHANNEL, payload)
      tailnetNotifier.onTailnetEvent(payload)
    },
    onMeshEvent: (event) => {
      tunnel.publish(MESH_EVENT_CHANNEL, event)
      tailnetNotifier.onMeshEvent(event)
    },
    hasWindow: () => anyWindowVisible,
    resolveModuleTools: () => modules.mcpTools(),
    isModuleEnabled: (moduleId) => modules.isEnabled(moduleId),
    // The shell offers what acts on a screen or a terminal (6.3): an agent's
    // first list waits for them, as in process it waits for the browser and
    // the canvas.
    expectShellToolsets: SHELL_TOOLSETS,
    appTools: (coreTools) => [
      ...coreTools,
      ...serverAutomationTools(
        createServerGatewayBackends({
          getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
          // The shell's sessions, mirrored: `backlog.work` confirms its launch
          // against them. `terminal.*` and `agent.*` are the shell's toolsets.
          listTerminalSessions: () => terminalSessions,
          launchAgent: (request) => bridge.terminals.launchAgent(request),
          resolveAgentPermissionPreset: core.resolveAgentPermissionPreset,
          createWorkspace: (input, actor) => workspaceSyncService.createWorkspace(input, actor),
          getScheduledAgents: () => modules.scheduledAgents(),
          defaultChatCli: () => effectiveAgentLaunchSettings(agentLaunchSettings.get()).lastSelectedCli ?? null,
          getModuleRegistrySnapshot: () => moduleRegistry,
          // The marketplace and the module trust store are the shell's caches.
          listInstalledThirdPartyModules: () => rpc.call(SHELL_METHODS.thirdPartyModules),
          listModuleContributedTools: () =>
            modules.mcpTools().map((tool) => ({ moduleId: tool.moduleId, toolName: tool.registration.name })),
          readMarketplaceRegistry: (input) => rpc.call(SHELL_METHODS.marketplaceRead, input ?? {}),
        }),
      ),
      ...createTailnetTools({ resolveTailnet: () => tailnetFrontDoor }),
    ],
  })
  tailnetFrontDoor = gateway
  const studioRpc = createStudioRpc(core, gateway)
  const githubTokenStore = new GitHubTokenStore()
  const workspaceBackup = createWorkspaceBackupService({
    resolveUserDataDir: () => envelope.dataDir,
    readRegistry: () => workspaceRegistry.getState(),
    minRegistryIntervalMs: 10_000,
  })
  // Resume in terminal: a chat's CLI session handed to a terminal agent, which
  // the shell starts.
  const terminalHandoff = createConversationTerminalHandoff({
    runtime: conversations,
    launch: (request) => bridge.terminals.launchAgent(request),
    cliResumesSessions: (cli) => cliResumeCapabilities(cli).resumeSession,
    permissionPresetsForCli,
    chatName: (workspaceId, agentId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)?.agents?.[
        agentId
      ]?.name,
  })
  const files = { ...createFilesystemWatchSearchHandlers(), ...createFilesystemReadHandlers() }
  const domains = registerServerDomainIpc(tunnel.registry as unknown as Parameters<typeof registerServerDomainIpc>[0], {
    core,
    gateway,
    studioRpc,
    githubTokenStore,
    workspaceBackup,
    terminalHandoff: (input) => terminalHandoff.handoff(input),
    files,
    // The window's port is the check: main brokers one only to an app window.
    assertAppSender: () => undefined,
  })
  modules.load(tunnel.registry, gateway)

  // A chat's phase, for the shell's dock badge and taskbar flash.
  conversations.onEvent(
    createConversationAttentionListener({
      onAgentPhase: (event) => rpc.emit(SERVER_EVENTS.attentionPhase, event),
    }),
  )

  // What the shell mirrors (6.3, ServerStateMirror), pushed as it changes.
  const registryView = (): ServerMirrorRegistry => ({
    state: workspaceRegistry.getState(),
    snapshot: workspaceSyncService.getSnapshot(),
    needsHydration: workspaceRegistry.needsHydration(),
  })
  const launchSettingsView = (): ServerMirrorLaunchSettings => ({
    settings: agentLaunchSettings.get(),
    record: agentLaunchSettings.getRecord(),
  })
  workspaceRegistry.subscribe(() => rpc.emit(SERVER_EVENTS.mirrorRegistry, registryView()))
  workspaceSyncService.subscribeEvents((event) => rpc.emit(SERVER_EVENTS.mirrorWorkspaceEvent, event))
  agentLaunchSettings.subscribe(() => rpc.emit(SERVER_EVENTS.mirrorLaunchSettings, launchSettingsView()))
  const handlers = serveShellRequests({
    rpc,
    mirror: (): ServerMirrorState => ({ ...registryView(), launchSettings: launchSettingsView() }),
    core,
    githubTokenStore,
    modules,
    studioRpc,
    gateway,
    envelope,
    cipherKind: envelope.secrets.kind,
  })

  // Power: the idle sweep and the scheduler read this process's activity, so
  // the shell's power and focus events are replayed into it; waking also
  // re-checks every paired machine, as in process.
  rpc.on(SERVER_EVENTS.hintPower, (payload) => {
    const hint = (payload as { event?: PowerHint } | null)?.event
    if (hint === 'suspend') powerActivity.noteSuspend()
    if (hint === 'resume') powerActivity.noteResume()
    if (hint === 'lock' || hint === 'unlock') powerActivity.noteScreenLocked(hint === 'lock')
    if (hint === 'battery' || hint === 'ac') powerActivity.noteBattery(hint === 'battery')
    if (hint === 'resume' || hint === 'unlock') gateway?.mesh().onWake()
  })
  rpc.on(SERVER_EVENTS.conversationIdleThreshold, (payload) => core.conversationOwner.setIdleThresholdMs(payload))

  // The launch tokens the shell's terminal agents hold, before the socket
  // their bridges reconnect to is back: a bridge that connects first is
  // proven, not left unattributed until the shell's push after ready.
  const liveTokens = await rpc.call<LaunchTokenChange[]>(SHELL_METHODS.liveLaunchTokens).catch(() => [])
  for (const change of Array.isArray(liveTokens) ? liveTokens : []) applyGatewayLaunchTokenChange(change)

  // Listening: the gateway, the owner socket, the module startup hooks.
  const status = await gateway.initialize()
  void studioRpc.start().catch(() => undefined)
  modules.startup()
  // The boot pass of model discovery runs where its cache lives, a little
  // after start, so its probes do not compete with the window's first paint.
  const discoveryTimer = setTimeout(() => {
    void discoverAndBroadcastCliModels().catch(() => undefined)
  }, BOOT_MODEL_DISCOVERY_DELAY_MS)
  discoveryTimer.unref()

  const running: RunningServer = {
    environmentId: readStudioEnvironmentId(envelope.dataDir),
    gatewaySocket: status.running ? status.socketPath : null,
    tailnetBound: null,
    attachClient(attach, port) {
      if (!port) return
      if (attach.kind === 'desktop-window') {
        tunnel.attach(
          {
            clientId: attach.clientId,
            windowId: attach.windowId,
            kind: attach.kind,
            workspaceWindow: attach.workspaceWindow === true,
          },
          port as TunnelPort,
        )
        return
      }
      if (attach.kind === 'studio-connection' || attach.kind === 'shell') {
        // A chat view's protocol connection, or the shell's own: answered with
        // its ticket by the `studio.connect` or `studio.connect-shell` request
        // that follows on the same channel.
        handlers.pendingConnections.set(attach.clientId, { port: port as TunnelPort, shell: attach.kind === 'shell' })
      }
    },
    detachClient(clientId) {
      tunnel.detach(clientId)
    },
    async stop({ drain, onLeg }) {
      clearTimeout(discoveryTimer)
      const legs: Array<readonly [string, () => unknown]> = [
        ['modules (begin)', () => modules.shutdownBegin()],
        ['local app socket', () => studioRpc.stop()],
        ['automations', () => gateway?.shutdown()],
        ['workspace registry', () => workspaceSyncService.flush()],
        // What a person would miss most: every chat's buffered transcript.
        ['chat transcripts', () => core.conversationOwner.flushTranscripts()],
        ['chats', () => core.conversationOwner.shutdown()],
        // After the chats: a turn that ended on the way out has its lookup
        // written down, and the watch's timers stop.
        [
          'pull requests',
          async () => {
            await core.pullRequests.flush()
            core.pullRequests.dispose()
          },
        ],
        ['command lists', () => domains.conversationCommands.dispose()],
        ['workspace registry (final)', () => workspaceSyncService.flush()],
        ['modules', () => modules.shutdown()],
        ['data directory', () => core.dataDirLock?.release()],
      ]
      // A lost parent: nothing can be shown, so only what cannot be lost runs.
      const urgent = new Set(['chat transcripts', 'pull requests', 'workspace registry (final)', 'data directory'])
      await runShutdownLegs(drain ? legs : legs.filter(([name]) => urgent.has(name)), onLeg)
    },
  }
  // The desktop that owns this directory wins it back only by restarting this
  // server; a lock taken by anyone else means leave now (a second writer).
  const lockWatch = setInterval(() => {
    if (core.dataDirLock?.isHeld() !== false) return
    clearInterval(lockWatch)
    requestExit(SERVER_EXIT.dataDirBusy, 'Another Studio took this data directory; stopping.')
  }, 1_000)
  lockWatch.unref()
  void writeDiagnosticLog({
    level: 'info',
    source: 'workspace',
    title: 'Studio server started',
    message: `Studio server ${envelope.app.version} serving ${envelope.dataDir} (pid ${process.pid}).`,
  }).catch(() => undefined)
  return running
}

const BOOT_MODEL_DISCOVERY_DELAY_MS = 10_000

function serveShellRequests(deps: {
  rpc: Parameters<ServerStart>[0]['rpc']
  mirror: () => ServerMirrorState
  core: ReturnType<typeof createStudioCore>
  githubTokenStore: GitHubTokenStore
  modules: ReturnType<typeof createServerModules>
  studioRpc: ReturnType<typeof createStudioRpc>
  gateway: StudioGateway
  envelope: Parameters<ServerStart>[0]['envelope']
  cipherKind: 'shell' | 'key-file'
}): { pendingConnections: Map<string, { port: TunnelPort; shell: boolean }> } {
  const { rpc, core } = deps
  // A port that arrived for a connection, until its request takes it: a chat
  // view's, or the shell's, which only `studio.connect-shell` may take.
  const pendingConnections = new Map<string, { port: TunnelPort; shell: boolean }>()
  const startedAt = Date.now()
  rpc.handle(SERVER_METHODS.mirrorSnapshot, () => deps.mirror())
  rpc.handle(SERVER_METHODS.updateWorkspaceAgent, (params) => {
    const input = params as { workspaceId: string; agentId: string; patch: unknown; actor?: string; stamp?: number }
    return core.workspaceSyncService.updateWorkspaceAgent(
      input.workspaceId,
      input.agentId,
      input.patch as never,
      (input.actor ?? 'system') as never,
      ...(typeof input.stamp === 'number' ? [input.stamp] : []),
    )
  })
  // Only the shell asks this, and only for a terminal it is launching; no
  // client on any other channel reaches it.
  rpc.handle(SERVER_METHODS.resolveSecretForLaunch, (params) => {
    const cli = (params as { cli?: unknown } | null)?.cli
    if (typeof cli !== 'string') return { ok: false, message: 'A credential is resolved for a named CLI.' }
    return getSharedCredentialStore().resolveSecret(cli)
  })
  rpc.handle(SERVER_METHODS.githubToken, (params) => {
    const input = params as { op?: string; token?: unknown; explicit?: unknown } | null
    switch (input?.op) {
      case 'status':
        return deps.githubTokenStore.getStatus()
      case 'resolve':
        return deps.githubTokenStore.resolveToken(typeof input.explicit === 'string' ? input.explicit : null)
      case 'read':
        return deps.githubTokenStore.readToken()
      case 'write':
        return deps.githubTokenStore.writeToken(typeof input.token === 'string' ? input.token : '')
      case 'clear':
        return deps.githubTokenStore.clearToken()
      default:
        throw new Error('Unknown GitHub token operation.')
    }
  })
  rpc.handle(SERVER_METHODS.conversationPeekEvents, async (params) => {
    const sessionId = (params as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'string') return null
    const listed = core.conversations.listSessions()
    const summary = listed.ok ? listed.sessions.find((session) => session.sessionId === sessionId) : undefined
    if (!summary) return null
    const workspaceRoot = core.workspaceRegistry.getRecord(summary.workspaceId)?.folderPath
    if (!workspaceRoot) return []
    // The first message and the newest turn, never the whole transcript.
    return core.conversations
      .readPeekTranscript({ workspaceRoot, workspaceId: summary.workspaceId, agentId: summary.agentId })
      .catch(() => [])
  })
  rpc.handle(SERVER_METHODS.discoverModels, (params) =>
    discoverAndBroadcastCliModels((params ?? {}) as Parameters<typeof discoverAndBroadcastCliModels>[0]),
  )
  rpc.handle(SERVER_METHODS.conversationRoots, () => core.conversations.listLiveConversationRoots())
  rpc.handle(SERVER_METHODS.applyModuleEnablement, (params) =>
    deps.modules.applyEnablement((params as { overrides?: Record<string, boolean> } | null)?.overrides ?? {}),
  )
  const takePort = (params: unknown, shell: boolean): TunnelPort => {
    const clientId = (params as { clientId?: unknown } | null)?.clientId
    const pending = typeof clientId === 'string' ? pendingConnections.get(clientId) : undefined
    if (!pending || typeof clientId !== 'string' || pending.shell !== shell)
      throw new Error('No connection port arrived for this request.')
    pendingConnections.delete(clientId)
    return pending.port
  }
  rpc.handle(SERVER_METHODS.studioConnect, (params) =>
    deps.studioRpc.connectWindow(tunnelPortFrames(takePort(params, false))),
  )
  // The control channel is process-private, so whatever asks here is the
  // shell: its connection gets the shell role, which may offer the built-in
  // toolsets (phase 5, 7.2).
  rpc.handle(SERVER_METHODS.shellConnect, (params) =>
    deps.studioRpc.connectShell(tunnelPortFrames(takePort(params, true))),
  )
  rpc.handle(SERVER_METHODS.info, (): ServerInfo => {
    const status = deps.gateway.getStatus()
    return {
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      version: deps.envelope.app.version,
      gatewaySocket: status.running ? status.socketPath : null,
      tailnetBound: null,
      cipher: deps.cipherKind === 'shell' ? 'desktop keychain (through the shell)' : 'key file',
      rssMb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
    }
  })
  return { pendingConnections }
}

/** A utility process's `MessagePortMain` as the frames a Studio connection reads and writes. */
function tunnelPortFrames(port: TunnelPort) {
  const closeListeners: Array<() => void> = []
  let closed = false
  const end = () => {
    if (closed) return
    closed = true
    for (const listener of closeListeners.splice(0)) listener()
  }
  port.on('close', end)
  return {
    post: (frame: string) => {
      if (!closed) port.postMessage(frame)
    },
    onFrame: (listener: (frame: string) => void) => {
      port.on('message', (event) => {
        if (typeof event.data === 'string') listener(event.data)
      })
      port.start()
    },
    onClose: (listener: () => void) => {
      if (closed) listener()
      else closeListeners.push(listener)
    },
    close: () => {
      port.close()
      end()
    },
  }
}
