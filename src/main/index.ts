import { shell, ipcMain } from 'electron'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerBuiltinSkillsIpc } from './ipc/builtin-skills-ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics-ipc'
import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'
import { registerFilesystemReadIpc } from './ipc/filesystem-read-ipc'
import { registerFilesystemWatchSearchIpc } from './ipc/filesystem-watch-search-ipc'
import { registerGitHubTokenIpc } from './ipc/github-token-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerMemoryActivityIpc } from './ipc/memory-activity-ipc'
import { registerMemoryIpc } from './ipc/memory-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerMobileBridgeIpc } from './ipc/mobile-bridge-ipc'
import { registerMultiloopIpc } from './ipc/multiloop-ipc'
import { registerSoulsIpc } from './ipc/souls-ipc'
import {
  registerSprintEngineIpc,
} from './ipc/sprintengine-ipc'
import { registerSwitchboardIpc } from './ipc/switchboard-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerBackendSessionIpc } from './backend-session-bridge'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { initializeMultiloopState } from './multiloop-init'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'
import { openDiagnosticsLogsFolder, writeDiagnosticLog } from './diagnostics-service'
import { readMultiloopPrompt, readSpecialistSoul } from './souls-service'
import { discoverMobileSprintEngineStatePaths } from './mobile-sprintengine-discovery'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { GitHubTokenStore } from './github-token-store'
import { MulticodeAuthBridge, parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createMainDiagnostics } from './main-diagnostics'
import { createTerminalRuntime } from './terminal-runtime'
import { MulticodeUpdateService } from './update-service'
import { createBuiltinSkillManager } from './builtin-skills'
import {
  MobileBridge,
} from './mobile/bridge'
import { MobileSprintEngineSnapshotService } from './mobile/sprintengine/snapshot'
import { importGitHubIssuesIntoWatchtower } from './switchboard-github'
import { importJiraIssuesIntoWatchtower } from './switchboard-jira'
import {
  addSwitchboardComment,
  cancelSwitchboardTask,
  claimSwitchboardTask,
  configureSwitchboardSessionSpawner,
  createSwitchboardTask,
  getSwitchboardExecutionLogs,
  getSwitchboardExecutionStatus,
  getWatchtowerRun,
  initializeSwitchboard,
  listWatchtowerRuns,
  moveSwitchboardTask,
  promoteSwitchboardInboxTask,
  publishSwitchboardTask,
  recordSwitchboardSessionExit,
  getSwitchboardRunnerState,
  readAllSwitchboardTasks,
  recoverSwitchboardLock,
  requeueSwitchboardTask,
  pauseSwitchboardRunner,
  resumeSwitchboardRunner,
  startSwitchboardRunner,
  startWatchtowerReview,
  startWatchtowerTriage,
  stopSwitchboardExecution,
  stopSwitchboardRunner,
  tickSwitchboardRunner,
  updateSwitchboardTask,
} from './switchboard-files'

const MULTICODE_DIAGNOSTICS = process.env['MULTICODE_DIAGNOSTICS'] === '1'
const { logMainPerfEvent, withIpcDiagnostics } = createMainDiagnostics({
  enabled: MULTICODE_DIAGNOSTICS,
})

const multicodeAuth = new MulticodeAuthBridge()
const terminalRuntime = createTerminalRuntime({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  requireAuthenticatedUser: requireAuthenticatedMulticodeUser,
  logMainPerfEvent,
  onAgentSessionExit: (input) => {
    if (input.workspaceRoot) void recordSwitchboardSessionExit(input)
  },
})
const mobileSnapshotService = new MobileSprintEngineSnapshotService()
const updateService = new MulticodeUpdateService({ writeDiagnosticLog })
const builtinSkillManager = createBuiltinSkillManager()
const githubTokenStore = new GitHubTokenStore()
let mobileWorkspaceRoots: string[] = []
const mobileBridge = new MobileBridge(() => multicodeAuth.getSession(), {
  accessTokenProvider: () => multicodeAuth.getRelayAccessToken(),
  commandService: terminalRuntime.commandService,
  snapshotService: mobileSnapshotService,
  statePathsProvider: () => discoverMobileSprintEngineStatePaths(mobileWorkspaceRoots),
})

configureSwitchboardSessionSpawner(terminalRuntime.spawnAgentSession)

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

registerBuiltinSkillsIpc(ipcMain, builtinSkillManager)

registerMobileBridgeIpc(ipcMain, {
  bridge: mobileBridge,
  getWorkspaceRoots: () => mobileWorkspaceRoots,
  setWorkspaceRoots: (roots) => {
    mobileWorkspaceRoots = roots
  },
})

registerTerminalIpc(ipcMain, terminalRuntime.ipcHandlers)

registerBackendSessionIpc(ipcMain)

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
  readyTask: sprintEngineArtifacts.readyTask,
  initializeSprintEngineState: sprintEngineArtifacts.initializeSprintEngineState,
  updateTask: sprintEngineArtifacts.updateTask,
  createTask: sprintEngineArtifacts.createTask,
  commentTask: sprintEngineArtifacts.commentTask,
})

registerSwitchboardIpc(ipcMain, {
  initialize: initializeSwitchboard,
  readAll: readAllSwitchboardTasks,
  createTask: createSwitchboardTask,
  updateTask: updateSwitchboardTask,
  moveTask: moveSwitchboardTask,
  promoteInboxTask: promoteSwitchboardInboxTask,
  cancelTask: cancelSwitchboardTask,
  addComment: addSwitchboardComment,
  claimTask: claimSwitchboardTask,
  publishTask: publishSwitchboardTask,
  recoverLock: recoverSwitchboardLock,
  requeueTask: requeueSwitchboardTask,
  startRunner: startSwitchboardRunner,
  pauseRunner: pauseSwitchboardRunner,
  resumeRunner: resumeSwitchboardRunner,
  stopRunner: stopSwitchboardRunner,
  tickRunner: tickSwitchboardRunner,
  getRunnerState: getSwitchboardRunnerState,
  stopExecution: stopSwitchboardExecution,
  getExecutionStatus: getSwitchboardExecutionStatus,
  getExecutionLogs: getSwitchboardExecutionLogs,
  startWatchtowerReview,
  startWatchtowerTriage,
  getWatchtowerRun,
  listWatchtowerRuns,
  importGitHubIssues: (workspaceRoot) => importGitHubIssuesIntoWatchtower({ workspaceRoot, tokenStore: githubTokenStore }),
  importJiraIssues: (workspaceRoot) => importJiraIssuesIntoWatchtower({ workspaceRoot }),
})

// ── File system IPC handlers ──────────────────────────────────────────────────

registerMultiloopIpc(ipcMain, {
  initializeMultiloopState,
})

registerFilesystemWatchSearchIpc(ipcMain, createFilesystemWatchSearchHandlers())

registerFilesystemReadIpc(ipcMain, createFilesystemReadHandlers())

registerMemoryIpc(ipcMain)

registerMemoryActivityIpc(ipcMain)

registerDiagnosticsIpc(ipcMain, {
  writeDiagnosticLog,
  openDiagnosticsLogsFolder,
})

registerUpdateIpc(ipcMain, { updateService })

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

registerGitHubTokenIpc(ipcMain, githubTokenStore)

registerMenuDialogIpc(ipcMain)

registerAppLifecycle({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  mobileBridge,
  updateService,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(multicodeAuth, argv)
  },
})
