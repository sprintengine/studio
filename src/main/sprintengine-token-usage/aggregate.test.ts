import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { computeSprintEngineTokenUsage, computeSprintEngineRunTokenUsage } from './index'
import type { ModelTokenUsage, SessionTokenUsage } from './types'

const NOW = '2026-06-28T00:00:00.000Z'

async function run(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function measured(cli: string, cliSessionId: string, perModel: ModelTokenUsage[]): SessionTokenUsage {
  return { cli, cliSessionId, measured: true, perModel, sampledAt: NOW }
}

function unmeasured(cli: string, cliSessionId: string): SessionTokenUsage {
  return { cli, cliSessionId, measured: false, perModel: [], sampledAt: NOW }
}

// Stub the adapter dispatcher keyed by cliSessionId so the aggregation logic is
// tested independently of transcript/HTTP parsing (covered by the T1/T2 tests).
function stubReader(sessions: Record<string, SessionTokenUsage>) {
  return async (cli: string, cliSessionId: string): Promise<SessionTokenUsage> =>
    sessions[cliSessionId] ?? unmeasured(cli, cliSessionId)
}

function model(name: string, input: number, output: number, cacheRead: number, cacheCreation: number): ModelTokenUsage {
  return { model: name, input, output, cacheRead, cacheCreation }
}

async function main(): Promise<void> {
  await run('all-measured sprint: per-model merge + grand total + full coverage', async () => {
    const usage = await computeSprintEngineTokenUsage(
      [
        { agentId: 'dev-1', cli: 'claude-code', cliSessionIds: ['C1'] },
        { agentId: 'cdx-1', cli: 'codex', cliSessionIds: ['X1'] },
      ],
      {
        now: () => NOW,
        readUsage: stubReader({
          C1: measured('claude-code', 'C1', [model('opus', 100, 10, 50, 5)]),
          X1: measured('codex', 'X1', [model('gpt-5.5', 200, 20, 0, 0)]),
        }),
      },
    )
    assert.equal(usage.perModel.length, 2)
    assert.deepEqual(usage.total, { input: 300, output: 30, cacheRead: 50, cacheCreation: 5 })
    assert.deepEqual(usage.coverage, { measuredAgents: 2, unmeasuredAgents: 0, unmeasured: [] })
    assert.equal(usage.computedAt, NOW)
  })

  await run('resumed agent: sums per-model across its cliSessionIds', async () => {
    const usage = await computeSprintEngineTokenUsage(
      [{ agentId: 'dev-1', cli: 'claude-code', cliSessionIds: ['C1', 'C2'] }],
      {
        now: () => NOW,
        readUsage: stubReader({
          C1: measured('claude-code', 'C1', [model('opus', 100, 10, 1000, 200)]),
          C2: measured('claude-code', 'C2', [model('opus', 50, 5, 300, 0), model('sonnet', 5, 1, 0, 0)]),
        }),
      },
    )
    const opus = usage.perModel.find((m) => m.model === 'opus')
    assert.deepEqual(opus, model('opus', 150, 15, 1300, 200), 'opus summed across both sessions')
    const sonnet = usage.perModel.find((m) => m.model === 'sonnet')
    assert.deepEqual(sonnet, model('sonnet', 5, 1, 0, 0))
    assert.equal(usage.coverage.measuredAgents, 1)
    // Cache stays distinct from input/output in the grand total.
    assert.deepEqual(usage.total, { input: 155, output: 16, cacheRead: 1300, cacheCreation: 200 })
  })

  await run('mixed coverage: unmeasured agents are named, not zeroed into measured', async () => {
    const usage = await computeSprintEngineTokenUsage(
      [
        { agentId: 'dev-1', cli: 'claude-code', cliSessionIds: ['C1'] },
        // opencode session that read measured:false (e.g. server down)
        { agentId: 'oc-1', cli: 'opencode', cliSessionIds: ['O1'] },
        // recorded at attach but never reported a session id (unmeasured CLI)
        { agentId: 'ghost', cli: 'weirdcli', cliSessionIds: [] },
      ],
      {
        now: () => NOW,
        readUsage: stubReader({
          C1: measured('claude-code', 'C1', [model('opus', 100, 10, 0, 0)]),
          O1: unmeasured('opencode', 'O1'),
        }),
      },
    )
    assert.deepEqual(usage.total, { input: 100, output: 10, cacheRead: 0, cacheCreation: 0 })
    assert.equal(usage.coverage.measuredAgents, 1)
    assert.equal(usage.coverage.unmeasuredAgents, 2)
    assert.deepEqual(usage.coverage.unmeasured, [
      { agentId: 'oc-1', cli: 'opencode' },
      { agentId: 'ghost', cli: 'weirdcli' },
    ])
  })

  await run('empty / zero-agent sprint: zero total, empty coverage, never throws', async () => {
    const usage = await computeSprintEngineTokenUsage([], { now: () => NOW })
    assert.deepEqual(usage.perModel, [])
    assert.deepEqual(usage.total, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
    assert.deepEqual(usage.coverage, { measuredAgents: 0, unmeasuredAgents: 0, unmeasured: [] })
    assert.equal(usage.computedAt, NOW)
  })

  await run('recompute path reads the durable ledger from projection.json', async () => {
    const teamDir = await mkdtemp(path.join(os.tmpdir(), 'se-run-'))
    const statePath = path.join(teamDir, 'run.yaml')
    await writeFile(
      path.join(teamDir, 'projection.json'),
      JSON.stringify({
        ledger: [
          { agentId: 'dev-1', role: 'developer', cli: 'claude-code', cliSessionIds: ['C1', 'C2'], firstSeenAt: NOW, lastSeenAt: NOW },
          { agentId: 'oc-1', role: 'frontend', cli: 'opencode', cliSessionIds: ['O1'], firstSeenAt: NOW, lastSeenAt: NOW },
        ],
      }),
    )
    const usage = await computeSprintEngineRunTokenUsage(statePath, {
      now: () => NOW,
      readUsage: stubReader({
        C1: measured('claude-code', 'C1', [model('opus', 100, 10, 0, 0)]),
        C2: measured('claude-code', 'C2', [model('opus', 1, 2, 3, 4)]),
        O1: unmeasured('opencode', 'O1'),
      }),
    })
    assert.deepEqual(usage.total, { input: 101, output: 12, cacheRead: 3, cacheCreation: 4 })
    assert.equal(usage.coverage.measuredAgents, 1)
    assert.deepEqual(usage.coverage.unmeasured, [{ agentId: 'oc-1', cli: 'opencode' }])
  })

  await run('recompute path tolerates a missing/unreadable projection', async () => {
    const teamDir = await mkdtemp(path.join(os.tmpdir(), 'se-empty-'))
    const usage = await computeSprintEngineRunTokenUsage(path.join(teamDir, 'run.yaml'), { now: () => NOW })
    assert.deepEqual(usage.total, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
    assert.deepEqual(usage.coverage, { measuredAgents: 0, unmeasuredAgents: 0, unmeasured: [] })
  })

  console.log('sprintengine token-usage aggregation tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
