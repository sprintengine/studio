import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendTokenLedgerRecord, readTokenLedger, tokenLedgerPath } from './ledger'
import { computeSprintEngineTokenUsageReport } from './report'
import type { ModelTokenUsage, SessionTokenUsage } from './types'

const NOW = '2026-07-09T00:00:00.000Z'

async function run(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function row(model: string, input: number, output: number): ModelTokenUsage {
  return {
    model,
    input,
    output,
    cacheRead: 0,
    cacheCreation: 0,
    total: input + output,
    split: true,
  }
}

function totalOnlyRow(model: string, total: number): ModelTokenUsage {
  return { model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total, split: false }
}

// A stub adapter dispatcher: usage keyed by cliSessionId; anything else is
// unmeasured (mirrors the real fail-closed contract).
function stubReadUsage(byanything: Record<string, ModelTokenUsage[]>) {
  return async (cli: string, cliSessionId: string): Promise<SessionTokenUsage> => {
    const perModel = byanything[cliSessionId]
    if (!perModel) return { cli, cliSessionId, measured: false, perModel: [], sampledAt: NOW }
    return { cli, cliSessionId, measured: true, perModel, sampledAt: NOW }
  }
}

async function buildTeamDir(input: {
  tasks?: unknown[]
  roster?: Record<string, unknown>
  writeProjection?: boolean
}): Promise<string> {
  const teamDir = await mkdtemp(path.join(os.tmpdir(), 'sprint-token-report-'))
  if (input.writeProjection !== false) {
    await writeFile(
      path.join(teamDir, 'projection.json'),
      JSON.stringify({ tasks: input.tasks ?? [], roster: input.roster ?? {} }),
      'utf8',
    )
  }
  return path.join(teamDir, 'run.yaml') // statePath: any file inside the team dir
}

async function main(): Promise<void> {
  await run('ledger: appends and folds session + sample records, last sample wins', async () => {
    const statePath = await buildTeamDir({})
    await appendTokenLedgerRecord(statePath, {
      kind: 'session',
      agentId: 'developer-1',
      role: 'developer',
      cli: 'claude-code',
      cliSessionId: 's1',
      at: NOW,
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'sample',
      agentId: 'developer-1',
      cli: 'claude-code',
      cliSessionId: 's1',
      measured: true,
      perModel: [row('claude-opus-4-8', 10, 5)],
      sampledAt: NOW,
      reason: 'session-end',
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'sample',
      agentId: 'developer-1',
      cli: 'claude-code',
      cliSessionId: 's1',
      measured: true,
      perModel: [row('claude-opus-4-8', 100, 50)],
      sampledAt: NOW,
      reason: 'teardown',
    })
    // A malformed trailing line must be tolerated.
    await writeFile(tokenLedgerPath(statePath), `${await readFile(tokenLedgerPath(statePath), 'utf8')}{oops`, 'utf8')

    const sessions = await readTokenLedger(statePath)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].agentId, 'developer-1')
    assert.equal(sessions[0].role, 'developer')
    assert.equal(sessions[0].cli, 'claude-code')
    assert.equal(sessions[0].lastSample?.perModel[0]?.input, 100) // last sample won
  })

  await run('report: per-task = owner sessions summed across a resume, per_task 1:1', async () => {
    const statePath = await buildTeamDir({
      tasks: [
        { id: 'T1', ownerAgentId: null, lastImplementedByAgentId: 'developer-1', cli: 'claude-code' },
        { id: 'T2', ownerAgentId: 'developer-2', lastImplementedByAgentId: null, cli: 'codex' },
      ],
      roster: {
        'developer-1': { role: 'developer', ownedTaskIds: ['T1'] },
        'developer-2': { role: 'developer', ownedTaskIds: ['T2'] },
      },
    })
    // developer-1 resumed once: two sessions, cumulative counters restart, so they sum.
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'developer-1', role: 'developer', cli: 'claude-code', cliSessionId: 's1', at: NOW,
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'developer-1', role: 'developer', cli: 'claude-code', cliSessionId: 's2', at: NOW,
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'developer-2', role: 'developer', cli: 'codex', cliSessionId: 's3', at: NOW,
    })

    const report = await computeSprintEngineTokenUsageReport(statePath, {
      now: () => NOW,
      readUsage: stubReadUsage({
        s1: [row('claude-opus-4-8', 100, 10)],
        s2: [row('claude-opus-4-8', 200, 20)],
        s3: [row('gpt-5.5', 50, 5)],
      }),
    })

    assert.equal(report.perTask.T1?.measured, true)
    assert.equal(report.perTask.T1?.agentId, 'developer-1')
    assert.equal(report.perTask.T1?.total.total, 330) // both sessions summed
    assert.equal(report.perTask.T2?.total.total, 55)
    assert.equal(report.run.total.total, 385)
    assert.equal(report.run.coverage.measuredAgents, 2)
    assert.equal(report.run.coverage.unmeasuredAgents, 0)
    assert.equal(report.computedAt, NOW)
  })

  await run('report: unmeasured live read falls back to the durable sample', async () => {
    const statePath = await buildTeamDir({
      tasks: [{ id: 'T1', ownerAgentId: 'developer-1', lastImplementedByAgentId: null, cli: 'opencode' }],
      roster: { 'developer-1': { role: 'developer', ownedTaskIds: ['T1'] } },
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'sample',
      agentId: 'developer-1',
      cli: 'opencode',
      cliSessionId: 's1',
      measured: true,
      perModel: [row('big-pickle', 40, 4)],
      sampledAt: NOW,
      reason: 'teardown',
    })
    const report = await computeSprintEngineTokenUsageReport(statePath, {
      now: () => NOW,
      readUsage: stubReadUsage({}), // live read always unmeasured
    })
    assert.equal(report.perTask.T1?.measured, true)
    assert.equal(report.perTask.T1?.total.total, 44)
  })

  await run('report: roster agents with nothing measurable appear in coverage, tasks stay unmeasured', async () => {
    const statePath = await buildTeamDir({
      tasks: [{ id: 'T1', ownerAgentId: null, lastImplementedByAgentId: null, cli: 'opencode' }],
      roster: {
        architect: { role: 'architect', ownedTaskIds: ['T0'] },
        'developer-1': { role: 'developer', ownedTaskIds: ['T1'] },
      },
    })
    const report = await computeSprintEngineTokenUsageReport(statePath, {
      now: () => NOW,
      readUsage: stubReadUsage({}),
    })
    assert.equal(report.run.coverage.measuredAgents, 0)
    assert.equal(report.run.coverage.unmeasuredAgents, 2)
    // Task owner resolved from the roster's durable ownedTaskIds, but unmeasured.
    assert.equal(report.perTask.T1?.agentId, 'developer-1')
    assert.equal(report.perTask.T1?.measured, false)
    // The ownerless-cli fallback labels the agent with its task's recorded CLI.
    const dev = report.perAgent.find((agent) => agent.agentId === 'developer-1')
    assert.equal(dev?.cli, 'opencode')
    assert.equal(report.run.total.total, 0)
  })

  await run('report: an agent owning multiple tasks is never double-counted per task', async () => {
    const statePath = await buildTeamDir({
      tasks: [
        { id: 'T1', ownerAgentId: null, lastImplementedByAgentId: 'developer-1', cli: 'claude-code' },
        { id: 'T2', ownerAgentId: null, lastImplementedByAgentId: 'developer-1', cli: 'claude-code' },
      ],
      roster: { 'developer-1': { role: 'developer', ownedTaskIds: ['T1', 'T2'] } },
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'developer-1', role: 'developer', cli: 'claude-code', cliSessionId: 's1', at: NOW,
    })
    const report = await computeSprintEngineTokenUsageReport(statePath, {
      now: () => NOW,
      readUsage: stubReadUsage({ s1: [row('claude-opus-4-8', 100, 10)] }),
    })
    // Run total counts the agent once; neither task claims the shared figure.
    assert.equal(report.run.total.total, 110)
    assert.equal(report.perTask.T1?.measured, false)
    assert.equal(report.perTask.T1?.ownerOwnsMultipleTasks, true)
    assert.equal(report.perTask.T2?.measured, false)
  })

  await run('report: a reopened task counts EVERY owner that ever worked it', async () => {
    // dev-1 implemented T1, the task was reopened and re-owned by dev-2 (both
    // roster ownedTaskIds sets list T1; lastImplementedByAgentId now dev-2).
    // The task's true cost is both agents' sessions; each owns only T1, so the
    // split is exact and the figure sums both. If either owner were
    // unmeasured, the task must report unmeasured, never a knowingly-partial
    // figure.
    const statePath = await buildTeamDir({
      tasks: [
        { id: 'T1', ownerAgentId: null, lastImplementedByAgentId: 'developer-2', cli: 'claude-code' },
      ],
      roster: {
        'developer-1': { role: 'developer', ownedTaskIds: ['T1'] },
        'developer-2': { role: 'developer', ownedTaskIds: ['T1'] },
      },
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'developer-1', cli: 'claude-code', cliSessionId: 's1', at: NOW,
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'developer-2', cli: 'claude-code', cliSessionId: 's2', at: NOW,
    })
    const report = await computeSprintEngineTokenUsageReport(statePath, {
      now: () => NOW,
      readUsage: stubReadUsage({
        s1: [row('claude-opus-4-8', 100, 10)],
        s2: [row('claude-opus-4-8', 200, 20)],
      }),
    })
    assert.equal(report.perTask.T1?.measured, true)
    assert.equal(report.perTask.T1?.agentId, 'developer-2') // primary = implementer
    assert.equal(report.perTask.T1?.total.total, 330) // both owners summed

    // Same shape but dev-1 unmeasured -> the task is unmeasured, not partial.
    const partial = await computeSprintEngineTokenUsageReport(statePath, {
      now: () => NOW,
      readUsage: stubReadUsage({ s2: [row('claude-opus-4-8', 200, 20)] }),
    })
    assert.equal(partial.perTask.T1?.measured, false)
    assert.equal(partial.run.total.total, 220) // run coverage still counts dev-2
    assert.equal(partial.run.coverage.unmeasuredAgents, 1)
  })

  await run('report: a live read that shrank (pruned transcript) never beats a fuller sample', async () => {
    const statePath = await buildTeamDir({
      tasks: [{ id: 'T1', ownerAgentId: 'developer-1', lastImplementedByAgentId: null, cli: 'claude-code' }],
      roster: { 'developer-1': { role: 'developer', ownedTaskIds: ['T1'] } },
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'sample',
      agentId: 'developer-1',
      cli: 'claude-code',
      cliSessionId: 's1',
      measured: true,
      perModel: [row('claude-opus-4-8', 1000, 100)], // fuller teardown sample
      sampledAt: NOW,
      reason: 'teardown',
    })
    const report = await computeSprintEngineTokenUsageReport(statePath, {
      now: () => NOW,
      // live read is measured but carries less (main transcript pruned,
      // subagent siblings survived)
      readUsage: stubReadUsage({ s1: [row('claude-opus-4-8', 40, 4)] }),
    })
    assert.equal(report.perTask.T1?.total.total, 1100) // the richer source won
  })

  await run('report: total-only rows (grok) poison split at every level, totals stay honest', async () => {
    const statePath = await buildTeamDir({
      tasks: [
        { id: 'T1', ownerAgentId: 'developer-1', lastImplementedByAgentId: null, cli: 'claude-code' },
        { id: 'T2', ownerAgentId: 'grok-1', lastImplementedByAgentId: null, cli: 'grok' },
      ],
      roster: {
        'developer-1': { role: 'developer', ownedTaskIds: ['T1'] },
        'grok-1': { role: 'developer', ownedTaskIds: ['T2'] },
      },
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'developer-1', cli: 'claude-code', cliSessionId: 's1', at: NOW,
    })
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'grok-1', cli: 'grok', cliSessionId: 's2', at: NOW,
    })
    const report = await computeSprintEngineTokenUsageReport(statePath, {
      now: () => NOW,
      readUsage: stubReadUsage({
        s1: [row('claude-opus-4-8', 100, 10)],
        s2: [totalOnlyRow('grok-4.5', 5000)],
      }),
    })
    assert.equal(report.run.total.total, 5110)
    assert.equal(report.run.total.split, false) // components undercount -> not safe to headline
    assert.equal(report.perTask.T1?.total.split, true) // claude-only task keeps its split
    assert.equal(report.perTask.T2?.total.split, false)
    assert.equal(report.perTask.T2?.total.total, 5000)
  })

  await run('report: missing ledger AND missing projection degrade to an empty report', async () => {
    const statePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'sprint-token-empty-')), 'run.yaml')
    const report = await computeSprintEngineTokenUsageReport(statePath, { now: () => NOW })
    assert.deepEqual(report.perAgent, [])
    assert.deepEqual(report.perTask, {})
    assert.equal(report.run.total.total, 0)
    assert.equal(report.run.coverage.measuredAgents, 0)
    assert.equal(report.run.coverage.unmeasuredAgents, 0)
  })

  await run('formatTokenCount: unit promotion at rounding boundaries', async () => {
    const { formatTokenCount } = await import('../../renderer/src/utils/sprintengineTokenUsage')
    assert.equal(formatTokenCount(0), '0')
    assert.equal(formatTokenCount(950), '950')
    assert.equal(formatTokenCount(12_340), '12.3k')
    assert.equal(formatTokenCount(999_960, ), '1M') // never a malformed '1000k'
    assert.equal(formatTokenCount(1_234_567), '1.23M')
    assert.equal(formatTokenCount(999_996_000), '1B') // never '1000M'
    assert.equal(formatTokenCount(4_500_000_000), '4.5B')
  })

  await run('source contract: the projection fields the report joins on exist in the Python writer', async () => {
    // The report hand-parses projection.json, a Python-owned contract. Pin the
    // field names against the actual writer sources so a rename over there
    // fails THIS test instead of silently zeroing the whole feature (the
    // report's never-throw posture would otherwise mask the drift as an
    // unmeasured run).
    const tasksPy = await readFile(path.join(process.cwd(), 'sprintengine_core/tool/tasks.py'), 'utf8')
    const storePy = await readFile(path.join(process.cwd(), 'sprintengine_core/store.py'), 'utf8')
    for (const field of ['lastImplementedByAgentId', 'ownerAgentId']) {
      assert.ok(tasksPy.includes(field), `tasks.py still writes ${field}`)
    }
    assert.ok(storePy.includes('ownedTaskIds'), 'store.py still projects roster ownedTaskIds')
    assert.ok(storePy.includes('"roster"') || storePy.includes("'roster'"), 'store.py still writes a roster block')
  })

  await run('ledger: appendTokenLedgerRecord creates the metrics dir on first write', async () => {
    const statePath = await buildTeamDir({ writeProjection: false })
    await appendTokenLedgerRecord(statePath, {
      kind: 'session', agentId: 'a', cli: 'claude-code', cliSessionId: 's', at: NOW,
    })
    await mkdir(path.dirname(tokenLedgerPath(statePath)), { recursive: true }) // idempotent
    const sessions = await readTokenLedger(statePath)
    assert.equal(sessions.length, 1)
  })

  console.log('sprintengine token-usage report tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
