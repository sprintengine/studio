import assert from 'node:assert/strict'
import { planReapSweep, type SweepCandidate } from './terminal-reap-sweep'
import { DEFAULT_SUSPEND_IDLE_AFTER_MS } from './terminal-reap-policy'

function run(name: string, body: () => Promise<void>): Promise<void> {
  return body().then(
    () => console.log(`ok - ${name}`),
    (error) => {
      console.error(`not ok - ${name}`)
      throw error
    }
  )
}

const NOW = 1_700_000_000_000
const STALE = NOW - DEFAULT_SUSPEND_IDLE_AFTER_MS - 60_000

function candidate(overrides: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-cold',
    kind: 'agent',
    cli: 'claude',
    activityKind: 'idle',
    visible: false,
    processAlive: true,
    lastSeenAt: STALE,
    rootPid: 1000,
    ...overrides,
  }
}

const noLiveChildren = async (roots: number[]) => new Map(roots.map((pid) => [pid, false]))

async function main(): Promise<void> {
  await run('reaps an idle cold agent with no live children and no busy sibling', async () => {
    const decision = await planReapSweep(
      [candidate()],
      { probeSubtrees: noLiveChildren },
      { now: NOW, hotWorkspaceLimit: 0 }
    )
    assert.deepEqual(decision.reapableSessionIds, ['sess-1'])
  })

  await run('keeps a terminal alive when the probe is undetermined (root absent from map)', async () => {
    const decision = await planReapSweep(
      [candidate()],
      { probeSubtrees: async () => new Map() }, // empty = undetermined
      { now: NOW, hotWorkspaceLimit: 0 }
    )
    assert.deepEqual(decision.reapableSessionIds, [])
  })

  await run('keeps a terminal alive when its subtree has a live child', async () => {
    const decision = await planReapSweep(
      [candidate()],
      { probeSubtrees: async (roots) => new Map(roots.map((p) => [p, true])) },
      { now: NOW, hotWorkspaceLimit: 0 }
    )
    assert.deepEqual(decision.reapableSessionIds, [])
  })

  await run('keeps an idle agent alive while a SIBLING in the same workspace is working', async () => {
    const decision = await planReapSweep(
      [
        candidate({ sessionId: 'idle-sibling', workspaceId: 'ws-busy' }),
        candidate({ sessionId: 'worker', workspaceId: 'ws-busy', activityKind: 'working', lastSeenAt: NOW }),
      ],
      { probeSubtrees: noLiveChildren },
      { now: NOW, hotWorkspaceLimit: 0 }
    )
    // worker isn't reapable (working); idle-sibling is kept because its workspace is active.
    assert.deepEqual(decision.reapableSessionIds, [])
  })

  await run('reaps the idle agent once the whole workspace has gone quiet', async () => {
    const decision = await planReapSweep(
      [
        candidate({ sessionId: 'a', workspaceId: 'ws-quiet' }),
        candidate({ sessionId: 'b', workspaceId: 'ws-quiet' }),
      ],
      { probeSubtrees: noLiveChildren },
      { now: NOW, hotWorkspaceLimit: 0 }
    )
    assert.deepEqual(decision.reapableSessionIds.sort(), ['a', 'b'])
  })

  await run('only probes alive agents, not shells or dead sessions', async () => {
    const probed: number[][] = []
    await planReapSweep(
      [
        candidate({ sessionId: 'a', rootPid: 10 }),
        candidate({ sessionId: 'b', kind: 'terminal', rootPid: 20 }), // plain shell — skip
        candidate({ sessionId: 'c', processAlive: false, rootPid: 30 }), // dead — skip
      ],
      {
        probeSubtrees: async (roots) => {
          probed.push([...roots].sort((x, y) => x - y))
          return new Map(roots.map((p) => [p, false]))
        },
      },
      { now: NOW, hotWorkspaceLimit: 0 }
    )
    assert.deepEqual(probed, [[10]])
  })

  console.log('terminal-reap-sweep tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
