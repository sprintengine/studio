import { shell, ipcMain } from 'electron'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics-ipc'
import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'
import { registerFilesystemReadIpc } from './ipc/filesystem-read-ipc'
import { registerFilesystemWatchSearchIpc } from './ipc/filesystem-watch-search-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerMemoryIpc } from './ipc/memory-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerMobileBridgeIpc } from './ipc/mobile-bridge-ipc'
import { registerMultiloopIpc } from './ipc/multiloop-ipc'
import { registerSoulsIpc } from './ipc/souls-ipc'
import {
  registerSprintEngineIpc,
} from './ipc/sprintengine-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { initializeMultiloopState } from './multiloop-init'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'
import { openDiagnosticsLogsFolder, writeDiagnosticLog } from './diagnostics-service'
import { readMultiloopPrompt, readSpecialistSoul } from './souls-service'
import { discoverMobileSwarmStatePaths } from './mobile-swarm-discovery'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { MulticodeAuthBridge, parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createMainDiagnostics } from './main-diagnostics'
import { createTerminalRuntime } from './terminal-runtime'
import {
  MobileBridge,
} from './mobile/bridge'
import { MobileSwarmSnapshotService } from './mobile/sprintengine/snapshot'

const MULTICODE_DIAGNOSTICS = process.env['MULTICODE_DIAGNOSTICS'] === '1'
const { logMainPerfEvent, withIpcDiagnostics } = createMainDiagnostics({
  enabled: MULTICODE_DIAGNOSTICS,
})

const multicodeAuth = new MulticodeAuthBridge()
const terminalRuntime = createTerminalRuntime({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  requireAuthenticatedUser: requireAuthenticatedMulticodeUser,
  logMainPerfEvent,
})
const mobileSnapshotService = new MobileSwarmSnapshotService()
let mobileWorkspaceRoots: string[] = []
const mobileBridge = new MobileBridge(() => multicodeAuth.getSession(), {
  accessTokenProvider: () => multicodeAuth.getRelayAccessToken(),
  commandService: terminalRuntime.commandService,
  snapshotService: mobileSnapshotService,
  statePathsProvider: () => discoverMobileSwarmStatePaths(mobileWorkspaceRoots),
})

function getAuthenticatedMulticodeUserId(): string | null {
  const state = multicodeAuth.getState()
  if (!state.authenticated) return null
  return state.user?.id?.trim() || state.entitlements?.userId?.trim() || null
}

function requireAuthenticatedMulticodeUser(message: string): void {
  if (!getAuthenticatedMulticodeUserId()) {
    throw new Error(message)
  }
}

registerWindowIpc(ipcMain)

registerAuthIpc(ipcMain, multicodeAuth)

registerMobileBridgeIpc(ipcMain, {
  bridge: mobileBridge,
  getWorkspaceRoots: () => mobileWorkspaceRoots,
  setWorkspaceRoots: (roots) => {
    mobileWorkspaceRoots = roots
  },
})

registerTerminalIpc(ipcMain, terminalRuntime.ipcHandlers)

const sprintEngineArtifacts = createSprintEngineArtifactHandlers({
  getAuthenticatedUserId: getAuthenticatedMulticodeUserId,
  openExternal: (url) => shell.openExternal(url),
})

// ── SprintEngine artifact IPC handlers ──────────────────────────────────────────────
// Renderer IPC gets narrow artifact review commands only. The main process owns
// authenticated MCP authority, review actor selection, auto-run policy checks,
// and fresh state snapshots after mutations.

registerSprintEngineIpc(ipcMain, {
  openArtifact: sprintEngineArtifacts.openArtifact,
  reviewArtifact: sprintEngineArtifacts.reviewArtifact,
})

// ── File system IPC handlers ──────────────────────────────────────────────────

registerMultiloopIpc(ipcMain, {
  initializeMultiloopState,
})

registerFilesystemWatchSearchIpc(ipcMain, createFilesystemWatchSearchHandlers())

registerFilesystemReadIpc(ipcMain, createFilesystemReadHandlers())

registerMemoryIpc(ipcMain)

registerDiagnosticsIpc(ipcMain, {
  writeDiagnosticLog,
  openDiagnosticsLogsFolder,
})

registerSoulsIpc(ipcMain, {
  readSpecialistSoul,
  readMultiloopPrompt,
})

registerFilesystemMutationIpc(ipcMain, createFilesystemMutationHandlers())

registerGitIpc(ipcMain, {
  enabled: MULTICODE_DIAGNOSTICS,
  logMainPerfEvent,
  withIpcDiagnostics,
})

registerMenuDialogIpc(ipcMain)

registerAppLifecycle({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  mobileBridge,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(multicodeAuth, argv)
  },
})
