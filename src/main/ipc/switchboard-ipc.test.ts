import assert from 'node:assert/strict'

import type { McpSettings } from '../../shared/electron-api'
import type { SwitchboardRunnerWorkspaceInput, WatchtowerStartReviewInput, WatchtowerStartTriageInput } from '../../shared/switchboard'
import { registerSwitchboardIpc } from './switchboard-ipc'

type Handler = (_event: unknown, input?: unknown) => Promise<unknown>

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle(channel: string, handler: Handler): void {
      handlers.set(channel, handler)
    },
  }
}

function createDeps(): {
  calls: {
    runnerState?: string | SwitchboardRunnerWorkspaceInput
    review?: WatchtowerStartReviewInput
    triage?: WatchtowerStartTriageInput
  }
  deps: Parameters<typeof registerSwitchboardIpc>[1]
} {
  const calls: {
    runnerState?: string | SwitchboardRunnerWorkspaceInput
    review?: WatchtowerStartReviewInput
    triage?: WatchtowerStartTriageInput
  } = {}
  const deps = {
    initialize: async () => ({ ok: true, state: null, tasks: [], problems: [] }),
    readAll: async () => ({ ok: true, state: null, tasks: [], problems: [] }),
    createTask: async () => ({ ok: false, message: 'unused' }),
    updateTask: async () => ({ ok: false, message: 'unused' }),
    moveTask: async () => ({ ok: false, message: 'unused' }),
    addComment: async () => ({ ok: false, message: 'unused' }),
    claimTask: async () => ({ ok: false, message: 'unused' }),
    cancelTask: async () => ({ ok: false, message: 'unused' }),
    recoverLock: async () => ({ ok: false, message: 'unused' }),
    requeueTask: async () => ({ ok: false, message: 'unused' }),
    publishTask: async () => ({ ok: false, message: 'unused' }),
    promoteInboxTask: async () => ({ ok: false, message: 'unused' }),
    startRunner: async () => ({ ok: false, message: 'unused' }),
    pauseRunner: async () => ({ ok: false, message: 'unused' }),
    resumeRunner: async () => ({ ok: false, message: 'unused' }),
    stopRunner: async () => ({ ok: false, message: 'unused' }),
    tickRunner: async () => ({ ok: false, message: 'unused' }),
    getRunnerState: async (input) => {
      calls.runnerState = input
      return { ok: false, message: 'unused' }
    },
    stopExecution: async () => ({ ok: false, message: 'unused' }),
    getExecutionStatus: async () => ({ ok: false, message: 'unused' }),
    getExecutionLogs: async () => ({ ok: false, message: 'unused' }),
    startWatchtowerReview: async (input) => {
      calls.review = input
      return { ok: false, message: 'unused' }
    },
    startWatchtowerTriage: async (input) => {
      calls.triage = input
      return { ok: false, message: 'unused' }
    },
    getWatchtowerRun: async () => ({ ok: false, message: 'unused' }),
    listWatchtowerRuns: async () => ({ ok: true, runs: [] }),
    importGitHubIssues: async () => ({ ok: false, message: 'unused' }),
    importJiraIssues: async () => ({ ok: false, message: 'unused' }),
  } as unknown as Parameters<typeof registerSwitchboardIpc>[1]

  return {
    calls,
    deps,
  }
}

async function main(): Promise<void> {
  const ipcMain = createIpcMain()
  const { calls, deps } = createDeps()
  registerSwitchboardIpc(ipcMain as unknown as Parameters<typeof registerSwitchboardIpc>[0], deps)

  const mcpSettings: McpSettings = {
    syncEnabled: true,
    servers: {
      context7: {
        id: 'context7',
        name: 'Context7',
        transport: 'stdio',
        command: 'npx',
        enabled: true,
        clients: ['codex'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'network',
      },
    },
  }

  await ipcMain.handlers.get('switchboard:runner:state')?.(null, {
    workspaceRoot: '/tmp/workspace',
    workspaceId: 'workspace-1',
    mcpSettings,
  })
  assert.deepEqual(calls.runnerState, {
    workspaceRoot: '/tmp/workspace',
    workspaceId: 'workspace-1',
    mcpSettings,
  })

  await ipcMain.handlers.get('switchboard:watchtower:start-review')?.(null, {
    workspaceRoot: '/tmp/workspace',
    workspaceId: 'workspace-1',
    preset: 'default',
    mcpSettings,
  })
  assert.equal(calls.review?.mcpSettings, mcpSettings)

  await ipcMain.handlers.get('switchboard:watchtower:start-triage')?.(null, {
    workspaceRoot: '/tmp/workspace',
    workspaceId: 'workspace-1',
    scope: 'all',
    mcpSettings,
  })
  assert.equal(calls.triage?.mcpSettings, mcpSettings)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
