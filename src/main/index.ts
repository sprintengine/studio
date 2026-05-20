import { app, shell, ipcMain } from 'electron'
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
import { registerMcpIpc } from './ipc/mcp-ipc'
import { registerSkillPackIpc } from './ipc/skill-pack-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerMobileBridgeIpc } from './ipc/mobile-bridge-ipc'
import { registerMultiloopIpc } from './ipc/multiloop-ipc'
import { registerSoulsIpc } from './ipc/souls-ipc'
import {
  registerSprintEngineIpc,
} from './ipc/sprintengine-ipc'
import { registerSwitchboardIpc } from './ipc/switchboard-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerWorkspaceBackupIpc } from './ipc/workspace-backup-ipc'
import { createWorkspaceBackupService } from './workspace-backup'
import type { SwitchboardRunnerExecution } from '../shared/switchboard'
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
import { createMcpConfigService } from './mcp-config-service'
import { createSkillPackService } from './skill-pack-service'
import { createTerminalRuntime } from './terminal-runtime'
import { MulticodeUpdateService } from './update-service'
import { createBuiltinSkillManager } from './builtin-skills'
import { installMulticodeCliTools } from './cli-install'
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
  configureSwitchboardRuntimeInventoryProvider,
  configureSwitchboardSessionSpawner,
  configureSwitchboardSessionStopper,
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
const cliInstallResult = installMulticodeCliTools()
if (!cliInstallResult.ok) {
  void writeDiagnosticLog({
    level: 'warning',
    source: 'workspace',
    title: 'Multicode CLI install failed',
    message: `Unable to install all Multicode CLI tools into ${cliInstallResult.binDir}.`,
    details: cliInstallResult.errors.join('; '),
  })
}

const multicodeAuth = new MulticodeAuthBridge()
const mcpConfigService = createMcpConfigService()
const skillPackService = createSkillPackService()
const terminalRuntime = createTerminalRuntime({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  requireAuthenticatedUser: requireAuthenticatedMulticodeUser,
  logMainPerfEvent,
  onAgentSessionExit: (input) => input.workspaceRoot ? recordSwitchboardSessionExit(input) : undefined,
  syncMcpConfig: async (input) => {
    const result = mcpConfigService.sync(input)
    return result.ok ? { ok: true } : { ok: false, message: result.message }
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
  workspaceRootsProvider: async () => mobileWorkspaceRoots,
})

configureSwitchboardSessionSpawner(terminalRuntime.spawnAgentSession)
configureSwitchboardSessionStopper(terminalRuntime.killAgentSession)
configureSwitchboardRuntimeInventoryProvider(() => terminalRuntime.getLiveAgentExecutionIds())

function isLiveSwitchboardTaskExecution(execution: SwitchboardRunnerExecution): boolean {
  return (
    execution.kind === 'switchboard_task'
    && (!execution.status || execution.status === 'active' || execution.status === 'launching')
  )
}

async function stopSwitchboardRunnerAndExecutions(workspaceRoot: string) {
  const stopResult = await stopSwitchboardRunner(workspaceRoot)
  if (stopResult.ok === false) return stopResult

  const failures: string[] = []
  const executions = stopResult.activeExecutions.filter(isLiveSwitchboardTaskExecution)
  for (const execution of executions) {
    const executionResult = await stopSwitchboardExecution({
      workspaceRoot,
      executionId: execution.executionId,
      reason: 'Stopped with Switchboard runner.',
    })
    if (executionResult.ok === false) {
      failures.push(`${execution.executionId}: ${executionResult.message}`)
      continue
    }
    terminalRuntime.killAgentSession({
      workspaceRoot,
      executionId: execution.executionId,
    })
  }

  if (failures.length > 0) {
    return {
      ok: false as const,
      message: `Runner stopped, but ${failures.length} active execution${failures.length === 1 ? '' : 's'} could not be stopped. ${failures.join(' ')}`,
    }
  }

  return getSwitchboardRunnerState(workspaceRoot)
}

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

const workspaceBackupService = createWorkspaceBackupService({
  resolveUserDataDir: () => app.getPath('userData'),
})
registerWorkspaceBackupIpc(ipcMain, workspaceBackupService)

registerAuthIpc(ipcMain, multicodeAuth)

registerBuiltinSkillsIpc(ipcMain, builtinSkillManager)
registerMcpIpc(ipcMain, mcpConfigService)
registerSkillPackIpc(ipcMain, skillPackService)

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
  readyTask: sprintEngineArtifacts.readyTask,
  initializeSprintEngineState: sprintEngineArtifacts.initializeSprintEngineState,
  updateTask: sprintEngineArtifacts.updateTask,
  createTask: sprintEngineArtifacts.createTask,
  commentTask: sprintEngineArtifacts.commentTask,
  setRunnerMode: sprintEngineArtifacts.setRunnerMode,
  replenishRoster: sprintEngineArtifacts.replenishRoster,
  readProjection: sprintEngineArtifacts.readProjection,
  readRegistryRoles: sprintEngineArtifacts.readRegistryRoles,
  readRegistryRole: sprintEngineArtifacts.readRegistryRole,
  readDispatch: sprintEngineArtifacts.readDispatch,
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
  stopRunner: stopSwitchboardRunnerAndExecutions,
  tickRunner: tickSwitchboardRunner,
  getRunnerState: getSwitchboardRunnerState,
  stopExecution: async (input) => {
    const result = await stopSwitchboardExecution(input)
    if (result.ok !== false) {
      terminalRuntime.killAgentSession({
        workspaceRoot: input.workspaceRoot,
        executionId: input.executionId,
      })
    }
    return result
  },
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
  terminalRuntime,
  updateService,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(multicodeAuth, argv)
  },
})
