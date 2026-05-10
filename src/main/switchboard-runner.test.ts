import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import type {
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardTask,
  SwitchboardTaskRecord,
} from '../shared/switchboard'
import type { TerminalSessionSnapshot, TerminalSpawnResult } from '../shared/electron-api'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import { createSwitchboardRunner } from './switchboard-runner'

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertRunnerClaimsUpToMaxConcurrency()
  await assertPauseStopsFutureClaimsWithoutKillingActiveSessions()
}

function taskRecord(id: string): SwitchboardTaskRecord {
  const now = '2026-05-09T12:00:00Z'
  const task: SwitchboardTask = {
    schemaVersion: 1,
    id,
    identifier: `SB-${id.slice(0, 8)}`,
    title: `Task ${id}`,
    description: '',
    priority: null,
    state: 'in_progress',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    source: { type: 'manual', externalId: null, externalKey: null, externalUrl: null },
    claim: { owner: 'switchboard-developer', sessionId: null, claimedAt: now },
    execution: { attempts: [], worktreePath: null, activeSessionId: null },
    evidence: { summary: '', artifacts: [], commandsRun: [], touchedFiles: [] },
    comments: [],
    createdAt: now,
    updatedAt: now,
  }
  return {
    task,
    location: {
      folderStatus: 'in_progress',
      path: `.multi-code/switchboard/tasks/in_progress/${id}.json`,
    },
    warnings: [],
  }
}

function createHarness(taskIds: string[]) {
  const remaining = [...taskIds]
  const spawned: TerminalSpawnPayload[] = []
  const running = new Set<string>()
  const claims: SwitchboardClaimTaskInput[] = []
  const runner = createSwitchboardRunner({
    async claimTask(input): Promise<SwitchboardClaimTaskResult> {
      claims.push(input)
      const next = remaining.shift()
      if (!next) return { ok: false, message: 'No eligible task.' }
      return { ok: true, record: taskRecord(next) }
    },
    async spawnTerminal(_sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult> {
      spawned.push(payload)
      running.add(payload.sessionId)
      return { ok: true, sessionId: payload.sessionId }
    },
    listTerminals(): TerminalSessionSnapshot[] {
      return [...running].map((sessionId) => ({
        sessionId,
        running: true,
        kind: 'agent',
        startedAt: Date.now(),
        lastOutputAt: null,
        outputBufferLength: 0,
        retainedOutputBytes: 0,
      }))
    },
  })
  return { runner, spawned, running, claims }
}

async function assertRunnerClaimsUpToMaxConcurrency(): Promise<void> {
  const { runner, spawned, claims } = createHarness([
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ])

  const state = await runner.start({} as WebContents, {
    workspaceRoot: '/tmp/switchboard-runner',
    maxConcurrency: 2,
    queues: ['ready'],
  })

  assert.equal(state.ok, true)
  assert.equal(state.ok && state.activeSessions.length, 2)
  assert.equal(spawned.length, 2)
  assert.equal(claims.length, 2)
  assert.equal(spawned[0].cwd, '/tmp/switchboard-runner')
  assert.equal(spawned[0].cliPermissionPreset, 'auto_workspace')
  assert.match(spawned[0].initialPrompt ?? '', /switchboard publish --workspace \./)
}

async function assertPauseStopsFutureClaimsWithoutKillingActiveSessions(): Promise<void> {
  const { runner, spawned, running, claims } = createHarness([
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
  ])
  await runner.start({} as WebContents, {
    workspaceRoot: '/tmp/switchboard-runner',
    maxConcurrency: 1,
    queues: ['ready'],
  })

  const paused = await runner.pause('/tmp/switchboard-runner')

  assert.equal(paused.ok, true)
  assert.equal(paused.ok && paused.paused, true)
  assert.equal(spawned.length, 1)
  assert.equal(claims.length, 1)
  assert.equal(running.size, 1)
}
