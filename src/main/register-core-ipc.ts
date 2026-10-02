import { app, BrowserWindow, shell } from 'electron'
import type { IpcMain } from 'electron'
import { registerAgentConfigImportIpc } from './ipc/agent-config-import-ipc'
import { registerAppearanceIpc } from './ipc/appearance-ipc'
import { registerBackgroundModeIpc } from './ipc/background-mode-ipc'
import { registerTelemetryIpc } from './ipc/telemetry-ipc'
import { registerAuthIpc } from './ipc/auth-ipc'
import {
  registerRemoteStudioConnectionIpc,
  registerStudioConnectionIpc,
  type RemoteWindowConnector,
} from './ipc/studio-connection-ipc'
import { assertAppSender } from './ipc/ipc-sender'
import { registerAppMenuIpc } from './app-menu'
import { registerBuiltinSkillsIpc } from './ipc/builtin-skills-ipc'
import { registerStudioPluginIpc } from './ipc/studio-plugin-ipc'
import { registerStudioAreaSkillsIpc } from './ipc/studio-area-skills-ipc'
import { registerCliRuntimeIpc } from './ipc/cli-runtime-ipc'
import { registerTextGenerationIpc } from './ipc/text-generation-ipc'
import { registerClipboardIpc } from './ipc/clipboard-ipc'
import { registerConversationPeekIpc } from './ipc/conversation-peek-ipc'
import { registerAgentCompactIpc } from './ipc/agent-compact-ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics-ipc'
import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'
import { registerFilesystemReadIpc } from './ipc/filesystem-read-ipc'
import { registerFilesystemWatchSearchIpc } from './ipc/filesystem-watch-search-ipc'
import { registerGitRepoWatchIpc } from './ipc/git-repo-watch-ipc'
import { listLiveTerminalSessions } from './terminal-runtime'
import { createFolderOpenIpcDependencies, registerFolderOpenIpc } from './ipc/folder-open-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerDesignSystemIpc } from './ipc/design-system-ipc'
import { registerMcpIpc } from './ipc/mcp-ipc'
import { registerMemoryActivityIpc } from './ipc/memory-activity-ipc'
import { registerMemoryIpc } from './ipc/memory-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerMarketplacePluginIpc } from './ipc/marketplace-plugin-ipc'
import { registerMarketplaceRegistryIpc } from './ipc/marketplace-registry-ipc'
import { registerHostedSourcesFeedIpc } from './ipc/hosted-feed-ipc'
import { registerHostedCardFeedIpc } from './ipc/card-feed-ipc'
import { registerCardsIpc } from './ipc/cards-ipc'
import { registerCliVersionIpc } from './ipc/cli-version-ipc'
import { registerModuleEnablementIpc, type ModuleEnablementLiveApplier } from './ipc/module-enablement-ipc'
import { registerModuleRegistryIpc } from './ipc/module-registry-ipc'
import { registerPluginIpc } from './ipc/plugins-ipc'
import { registerPullRequestIpc } from './ipc/pull-request-ipc'
import { registerSkillsIpc } from './ipc/skills-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerWorkspaceSkillsIpc } from './ipc/workspace-skills-ipc'
import { registerThirdPartyModuleIpc } from './ipc/third-party-module-ipc'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerVersionControlIpc } from './ipc/version-control-ipc'
import { registerVoiceIpc } from './ipc/voice-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { registerCanvasIpc } from './ipc/canvas-ipc'
import { registerEditorRevealIpc } from './ipc/editor-reveal-ipc'
import { registerToursIpc } from './ipc/tours-ipc'
import { pickCanvasExportDirectory, revealCanvasBoardFile } from './ipc/canvas-export-dialog'
import { registerExtensionScaffoldIpc } from './ipc/extension-scaffold-ipc'
import {
  confirmWorkspaceWindowClose,
  createDiagnosticsWindow,
  createMainWindow,
  isAuxWindow,
  isWorkspaceWindowWebContents,
  openAuxWindow,
} from './window-factory'
import type { AppServices } from './app-services'
import { registerServerDomainIpc } from '../server/desktop/server-ipc'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createProjectLogoIo } from './project-logo-io'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { openDiagnosticsLogsFolder } from './diagnostics-folder'
import { writeDiagnosticLog } from './diagnostics-service'

export type CoreIpcOptions = {
  includeDevModules?: boolean
  applyModuleEnablementLive?: ModuleEnablementLiveApplier
  /**
   * The Studio server in a process of its own: its domains register there, on
   * its IPC tunnel, and a chat view's protocol connection is brokered to it.
   */
  server?: { studioConnections: RemoteWindowConnector }
}

/** What registration hands back for the app's shutdown to finish. */
export type CoreIpcHandles = {
  conversationCommands: { dispose(): Promise<void> }
}

export function registerCoreIpc(
  ipcMain: IpcMain,
  services: AppServices,
  diagnosticsEnabled: boolean,
  options: CoreIpcOptions = {},
): CoreIpcHandles {
  registerWindowIpc(ipcMain, {
    createWorkspaceWindow: ({ windowId, bounds, isMaximized }) => {
      createMainWindow({ diagnosticsEnabled, windowId, bounds, isMaximized })
    },
    confirmWindowClose: confirmWorkspaceWindowClose,
    openAuxWindow,
    isAuxWindow,
  })
  registerBrowserIpc(ipcMain, services.browserManager)
  registerCanvasIpc(ipcMain, services.canvasService, services.canvasSubscribers, {
    pickExportDirectory: pickCanvasExportDirectory,
    revealFile: revealCanvasBoardFile,
  })
  registerEditorRevealIpc(ipcMain, services.editorRevealBroker, {
    // The answering window, never a name the message carries; only workspace
    // windows show a workspace, so only they are heard.
    senderId: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win && isWorkspaceWindowWebContents(event.sender) ? win : null
    },
  })
  registerToursIpc(ipcMain, services.tourService)
  if (options.server) registerRemoteStudioConnectionIpc(ipcMain, options.server.studioConnections)
  else if (services.studioRpcService) registerStudioConnectionIpc(ipcMain, services.studioRpcService)
  registerAppMenuIpc(ipcMain)
  registerClipboardIpc(ipcMain)
  registerCliRuntimeIpc(ipcMain)
  registerTextGenerationIpc(ipcMain)
  // Voice dictation is a dev-only capability (the `voice-dictation` module). Its
  // main IPC is not yet a capability module, so gate it on the build channel
  // here so `voice:transcribe` is genuinely absent in a packaged build, not just
  // orphaned behind a hidden renderer surface.
  if (options.includeDevModules ?? true) registerVoiceIpc(ipcMain)
  registerAuthIpc(ipcMain, services.sprintengineAuth)
  registerBuiltinSkillsIpc(ipcMain, services.builtinSkillManager)
  registerStudioPluginIpc(ipcMain, services.studioPluginService)
  registerStudioAreaSkillsIpc(ipcMain, services.studioAreaSkillStore)
  registerMcpIpc(ipcMain, services.mcpConfigService)
  registerAgentConfigImportIpc(ipcMain, services.agentConfigImportService)
  registerSkillsIpc(ipcMain, services.skillsService)
  registerWorkspaceSkillsIpc(ipcMain, {
    workspaceSkills: services.workspaceSkillsService,
    agentCapabilities: services.agentCapabilityService,
    agentSkillInstaller: services.agentSkillInstaller,
  })
  const filesystemSearchHandlers = createFilesystemWatchSearchHandlers()
  registerFilesystemWatchSearchIpc(ipcMain, filesystemSearchHandlers)
  const filesystemReadHandlers = createFilesystemReadHandlers({ opener: shell, projectLogoIo: createProjectLogoIo() })
  registerFilesystemReadIpc(ipcMain, filesystemReadHandlers)
  // The file-manager target of the open-in-editor control is the same reveal the
  // rest of the app already uses, so it is handed the very same handler.
  registerFolderOpenIpc(ipcMain, createFolderOpenIpcDependencies(filesystemReadHandlers.showItemInFolder))
  // Memory/knowledge-graph backend is foundational: agent context injection
  // (TerminalView) and the Knowledge Graph settings tab
  // depend on it, so it is always registered. The memory-graph capability
  // module gates only the visualization panel (renderer side).
  registerMemoryIpc(ipcMain)
  registerMemoryActivityIpc(ipcMain)
  registerDiagnosticsIpc(ipcMain, {
    writeDiagnosticLog,
    openDiagnosticsLogsFolder,
    openDiagnosticsWindow: () => {
      createDiagnosticsWindow()
    },
    listConversationRoots: () => services.conversations.listLiveConversationRoots(),
  })
  registerUpdateIpc(ipcMain, { updateService: services.updateService })
  registerFilesystemMutationIpc(ipcMain, createFilesystemMutationHandlers())
  registerGitIpc(
    ipcMain,
    {
      enabled: diagnosticsEnabled,
      logMainPerfEvent: services.logMainPerfEvent,
      withIpcDiagnostics: services.withIpcDiagnostics,
    },
    // The changelist store's home. Resolved here rather than inside the git
    // modules so those stay free of `electron.app` and remain testable against
    // a temp directory.
    {
      userDataDir: app.getPath('userData'),
      onChangelistsChanged: services.broadcastGitChangelistsChanged,
      livePaths: () =>
        listLiveTerminalSessions().flatMap((session) =>
          [session.cwd, session.observedCheckout?.cwd, session.observedCheckout?.gitRoot].filter(
            (path): path is string => typeof path === 'string' && path.length > 0,
          ),
        ),
    },
  )
  registerGitRepoWatchIpc(ipcMain)
  registerVersionControlIpc(ipcMain)
  registerMenuDialogIpc(ipcMain)
  registerModuleEnablementIpc(ipcMain, { applyLive: options.applyModuleEnablementLive })
  registerModuleRegistryIpc(ipcMain, services.moduleRegistryMirror)
  registerAppearanceIpc(ipcMain)
  registerBackgroundModeIpc(ipcMain, services.backgroundModeStore)
  registerTelemetryIpc(ipcMain, services.telemetryConsentStore)
  registerMarketplaceRegistryIpc(ipcMain)
  registerHostedSourcesFeedIpc(ipcMain)
  registerHostedCardFeedIpc(ipcMain)
  // Go, on a card on the Extensions home. Registered after the skills and MCP
  // services it composes, because it is those services said in one press.
  registerCardsIpc(ipcMain, {
    skillsService: services.skillsService,
    mcpConfigService: services.mcpConfigService,
    githubTokenStore: services.githubTokenStore,
  })
  registerCliVersionIpc(ipcMain)
  registerMarketplacePluginIpc(ipcMain, services)
  registerPluginIpc(ipcMain)
  // The domains the Studio server owns: registered here while it runs in
  // process, and by the server itself on its IPC tunnel when it runs in a
  // process of its own (src/server/desktop/server-ipc.ts).
  const { automationService, studioRpcService, workspaceBackupService, conversationTerminalHandoff } = services
  const { conversationCommands } =
    !options.server && automationService && studioRpcService && workspaceBackupService && conversationTerminalHandoff
      ? registerServerDomainIpc(ipcMain, {
          core: services.studioCore,
          gateway: automationService,
          studioRpc: studioRpcService,
          githubTokenStore: services.githubTokenStore,
          workspaceBackup: workspaceBackupService,
          terminalHandoff: (input) => conversationTerminalHandoff.handoff(input),
          files: { ...filesystemSearchHandlers, ...filesystemReadHandlers },
          assertAppSender,
        })
      : // The server registers them, and disposes its own command lists.
        { conversationCommands: { dispose: async () => undefined } }
  registerDesignSystemIpc(ipcMain)
  registerThirdPartyModuleIpc(ipcMain, services)

  // The terminal runtime (agent-runtime) is always on, so its IPC registers
  // with the core surfaces.
  registerTerminalIpc(ipcMain, {
    ...services.terminalRuntime.ipcHandlers,
    // One idle-suspend setting governs both agent runtimes: PTY terminals and
    // headless conversation child processes share the threshold.
    setIdleSuspendThresholdMs: (value: unknown): void => {
      services.terminalRuntime.ipcHandlers.setIdleSuspendThresholdMs(value)
      services.conversationOwner.setIdleThresholdMs(value)
    },
  })

  // The conversation peek reads a terminal session, so it registers alongside
  // the runtime that owns one rather than with the core surfaces.
  registerConversationPeekIpc(ipcMain, services.conversationPeek)

  // Compacting a terminal agent types at its prompt, so it registers beside
  // the runtime that owns the session and goes through the control plane that
  // owns typing at one.
  registerAgentCompactIpc(ipcMain, {
    findTerminal: (sessionId) =>
      services.terminalRuntime.ipcHandlers.listTerminals().find((session) => session.sessionId === sessionId) ?? null,
    sendPrompt: async (sessionId, text, precondition) => {
      const result = await services.agentControlPlane.send({ sessionId }, text, { submit: true, precondition })
      return result.ok ? { ok: true } : { ok: false, message: result.message }
    },
  })

  // Same reason: the pull request marks are read off a terminal session's
  // observed checkout, so their one refresh channel registers beside the
  // runtime that owns the session.
  registerPullRequestIpc(ipcMain, {
    refreshPullRequestsForSession: (sessionId) => services.pullRequestRecord.refreshForSession(sessionId),
    // Keyed by conversation, for the rows with nothing running in them.
    listForWorkspaces: (workspaceIds) => {
      const out: Record<string, ReturnType<typeof services.pullRequestRecord.forWorkspace>> = {}
      for (const id of workspaceIds) {
        const list = services.pullRequestRecord.forWorkspace(id)
        // Only conversations that have something. An empty array per id would
        // make every answer the size of the question.
        if (list.length > 0) out[id] = list
      }
      return out
    },
  })
  // ── extension-platform additions ──
  // Build your own extension: the SDK's templates, the machine check, the project.
  registerExtensionScaffoldIpc(ipcMain)
  return { conversationCommands }
}
