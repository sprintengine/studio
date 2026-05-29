import { registerSwitchboardIpc } from '../ipc/switchboard-ipc'
import { GitHubTokenStoreToken, TerminalRuntimeToken } from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import { importGitHubIssuesIntoWatchtower } from '../switchboard-github'
import { importJiraIssuesIntoWatchtower } from '../switchboard-jira'
import {
  addSwitchboardComment,
  cancelSwitchboardTask,
  claimSwitchboardTask,
  configureSwitchboardExecutionStopper,
  configureSwitchboardRuntimeInventoryProvider,
  configureSwitchboardSessionSpawner,
  configureSwitchboardSessionStopper,
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
} from '../switchboard-files'

// Switchboard + Watchtower as a capability module. Its Python core
// (`switchboard_core`) is spawned per command, not as a daemon, so disabling
// this module skips all switchboard IPC registration — the renderer can't
// trigger a command, so the Python process is never spawned. Depends on the
// agent runtime for spawning/stopping/inventorying agent sessions.
export const switchboardModule: CapabilityModule = {
  manifest: {
    id: 'switchboard',
    displayName: 'Switchboard & Watchtower',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Durable task board (Switchboard) and triage/review inbox (Watchtower).',
    defaultEnabled: true,
  },
  registerMain(host) {
    const terminalRuntime = host.requireService(TerminalRuntimeToken)
    const githubTokenStore = host.requireService(GitHubTokenStoreToken)

    configureSwitchboardSessionSpawner(terminalRuntime.spawnAgentSession)
    configureSwitchboardSessionStopper(terminalRuntime.killAgentSession)
    configureSwitchboardRuntimeInventoryProvider(() => terminalRuntime.getLiveAgentExecutionIds())
    configureSwitchboardExecutionStopper(terminalRuntime.killAgentSession)

    host.registerSidecar({
      id: 'switchboard-core',
      kind: 'python-on-demand',
      module: 'switchboard_core',
      description: 'Spawned per command; never runs while this module is disabled.',
    })

    registerSwitchboardIpc(host.ipcMain, {
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
      importGitHubIssues: (workspaceRoot) =>
        importGitHubIssuesIntoWatchtower({ workspaceRoot, tokenStore: githubTokenStore }),
      importJiraIssues: (workspaceRoot) => importJiraIssuesIntoWatchtower({ workspaceRoot }),
    })
  },
}
