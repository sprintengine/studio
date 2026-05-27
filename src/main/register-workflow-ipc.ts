import type { IpcMain } from 'electron'
import { registerMobileBridgeIpc } from './ipc/mobile-bridge-ipc'
import { registerMultiloopIpc } from './ipc/multiloop-ipc'
import { registerSprintEngineIpc } from './ipc/sprintengine-ipc'
import { registerSwitchboardIpc } from './ipc/switchboard-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import type { AppServices } from './app-services'
import { initializeMultiloopState } from './multiloop-init'
import { importGitHubIssuesIntoWatchtower } from './switchboard-github'
import { importJiraIssuesIntoWatchtower } from './switchboard-jira'
import {
  addSwitchboardComment,
  cancelSwitchboardTask,
  claimSwitchboardTask,
  configureSwitchboardExecutionStopper,
  createSwitchboardTask,
  getSwitchboardExecutionLogs,
  getSwitchboardExecutionStatus,
  getSwitchboardRunnerState,
  getWatchtowerRun,
  initializeSwitchboard,
  listWatchtowerRuns,
  moveSwitchboardTask,
  pauseSwitchboardRunner,
  promoteSwitchboardInboxTask,
  publishSwitchboardTask,
  readAllSwitchboardTasks,
  recoverSwitchboardLock,
  requeueSwitchboardTask,
  resumeSwitchboardRunner,
  startSwitchboardRunner,
  startWatchtowerReview,
  startWatchtowerTriage,
  stopSwitchboardExecution,
  stopSwitchboardRunnerAndExecutions,
  tickSwitchboardRunner,
  updateSwitchboardTask,
} from './switchboard-files'

export function registerWorkflowIpc(ipcMain: IpcMain, services: AppServices): void {
  registerMobileBridgeIpc(ipcMain, {
    bridge: services.mobileBridge,
    getWorkspaceRoots: services.getMobileWorkspaceRoots,
    setWorkspaceRoots: services.setMobileWorkspaceRoots,
  })
  registerTerminalIpc(ipcMain, services.terminalRuntime.ipcHandlers)
  registerSprintEngineIpc(ipcMain, {
    openArtifact: services.sprintEngineArtifacts.openArtifact,
    reviewArtifact: services.sprintEngineArtifacts.reviewArtifact,
    readyTask: services.sprintEngineArtifacts.readyTask,
    initializeSprintEngineState: services.sprintEngineArtifacts.initializeSprintEngineState,
    updateTask: services.sprintEngineArtifacts.updateTask,
    createTask: services.sprintEngineArtifacts.createTask,
    commentTask: services.sprintEngineArtifacts.commentTask,
    setRunnerMode: services.sprintEngineArtifacts.setRunnerMode,
    replenishRoster: services.sprintEngineArtifacts.replenishRoster,
    readProjection: services.sprintEngineArtifacts.readProjection,
    readRegistryRoles: services.sprintEngineArtifacts.readRegistryRoles,
    readRegistryRole: services.sprintEngineArtifacts.readRegistryRole,
    readDispatch: services.sprintEngineArtifacts.readDispatch,
  })
  configureSwitchboardExecutionStopper(services.terminalRuntime.killAgentSession)
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
    stopExecution: stopSwitchboardExecution,
    getExecutionStatus: getSwitchboardExecutionStatus,
    getExecutionLogs: getSwitchboardExecutionLogs,
    startWatchtowerReview,
    startWatchtowerTriage,
    getWatchtowerRun,
    listWatchtowerRuns,
    importGitHubIssues: (workspaceRoot) => importGitHubIssuesIntoWatchtower({ workspaceRoot, tokenStore: services.githubTokenStore }),
    importJiraIssues: (workspaceRoot) => importJiraIssuesIntoWatchtower({ workspaceRoot }),
  })
  registerMultiloopIpc(ipcMain, {
    initializeMultiloopState,
  })
}
