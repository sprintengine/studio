import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCheckpointIndex } from './checkpoint-index'
import { createCheckpointReactor } from './checkpoint-reactor'
import { checkpointRefFor } from './checkpoint-store'

// The reactor that turns phase transitions into captures
// (the-diff-an-agent-made / checkpoint-turn-reactor). Git is injected, so what
// is under test here is the wiring and the concurrency — not the plumbing.

let failures = 0
async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

type Harness = ReturnType<typeof harness>

function harness(options: { capture?: (ref: string) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-reactor-'))
  const captured: string[] = []
  const deleted: string[] = []
  let inFlight = 0
  let maxConcurrent = 0
  let clock = 1000

  const index = createCheckpointIndex({ resolveUserDataDir: () => dir })
  const reactor = createCheckpointReactor({
    index,
    now: () => (clock += 1),
    captureCheckpoint: async ({ ref }) => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      // A real capture spans several awaits; one is enough to expose a reactor
      // that starts a second before the first finishes.
      await Promise.resolve()
      await Promise.resolve()
      inFlight -= 1
      const ok = options.capture ? options.capture(ref) : true
      if (ok) captured.push(ref)
      return ok
    },
    deleteCheckpointRefs: async ({ refs }) => {
      deleted.push(...refs)
    },
  })

  return {
    index,
    reactor,
    captured,
    deleted,
    get maxConcurrent() {
      return maxConcurrent
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const CWD = '/repo'
const W = 'workspace_1'

async function turn(h: Harness, from: 'idle' | 'awaiting_input', to: 'idle' | 'awaiting_input'): Promise<void> {
  h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: from, next: 'thinking' })
  await h.reactor.whenSettled()
  h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'thinking', next: to })
  await h.reactor.whenSettled()
}

void main()

async function main(): Promise<void> {
  await run('one turn produces a baseline and a turn checkpoint', async () => {
    const h = harness()
    try {
      await turn(h, 'idle', 'idle')
      assert.deepEqual(h.captured, [checkpointRefFor(W, 0), checkpointRefFor(W, 1)])
      assert.equal(h.index.nextTurn(W), 2)
    } finally {
      h.dispose()
    }
  })

  await run('the baseline is captured once, not on every turn', async () => {
    const h = harness()
    try {
      await turn(h, 'idle', 'idle')
      await turn(h, 'idle', 'awaiting_input')
      await turn(h, 'awaiting_input', 'idle')
      assert.deepEqual(h.captured, [
        checkpointRefFor(W, 0),
        checkpointRefFor(W, 1),
        checkpointRefFor(W, 2),
        checkpointRefFor(W, 3),
      ])
    } finally {
      h.dispose()
    }
  })

  await run('resuming a suspended terminal captures nothing at all', async () => {
    const h = harness()
    try {
      // `starting` is the lifecycle stamp every session is born with.
      h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: undefined, next: 'starting' })
      h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'starting', next: 'idle' })
      h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'idle', next: 'awaiting_input' })
      await h.reactor.whenSettled()
      assert.deepEqual(h.captured, [], 'no turn opened, so nothing was captured')
      assert.equal(h.index.timelineFor(W), null)
    } finally {
      h.dispose()
    }
  })

  await run('tool_use churn inside one turn captures nothing extra', async () => {
    const h = harness()
    try {
      h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'idle', next: 'thinking' })
      await h.reactor.whenSettled()
      for (let step = 0; step < 5; step += 1) {
        h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'thinking', next: 'tool_use' })
        h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'tool_use', next: 'thinking' })
      }
      await h.reactor.whenSettled()
      assert.deepEqual(h.captured, [checkpointRefFor(W, 0)], 'only the baseline so far')
      h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'thinking', next: 'idle' })
      await h.reactor.whenSettled()
      assert.deepEqual(h.captured, [checkpointRefFor(W, 0), checkpointRefFor(W, 1)])
    } finally {
      h.dispose()
    }
  })

  await run('two agents in one workspace advance ONE shared timeline', async () => {
    const h = harness()
    try {
      // Epic decision 2: this is the owner's "add their diffs together", and it
      // cannot double-count a file both agents touched.
      await turn(h, 'idle', 'idle')
      // A second agent's turn in the same workspace continues the numbering.
      await turn(h, 'idle', 'idle')
      assert.equal(h.index.timelineFor(W)?.turns.length, 3, 'baseline + two turns')
      assert.deepEqual(
        h.index.timelineFor(W)?.turns.map((entry) => entry.turn),
        [0, 1, 2]
      )
    } finally {
      h.dispose()
    }
  })

  await run('captures never overlap on one folder, and a burst coalesces', async () => {
    const h = harness()
    try {
      await turn(h, 'idle', 'idle')
      // Five closes in one tick: without coalescing this is five subprocesses
      // racing to snapshot trees that are all the same by the time they run.
      for (let index = 0; index < 5; index += 1) {
        h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'tool_use', next: 'idle' })
      }
      await h.reactor.whenSettled()
      assert.equal(h.maxConcurrent, 1, 'one capture at a time per folder')
      // Baseline, the first turn, then at most the one coalesced follow-up.
      assert.ok(h.captured.length <= 4, `burst coalesced (captured ${h.captured.length})`)
      // Whatever ran, the numbering has no duplicates and no gaps.
      const turns = h.index.timelineFor(W)?.turns.map((entry) => entry.turn) ?? []
      assert.deepEqual(turns, [...new Set(turns)], 'no turn recorded twice')
      assert.deepEqual(turns, [...turns].sort((a, b) => a - b))
    } finally {
      h.dispose()
    }
  })

  await run('a failed capture records nothing and is not retried', async () => {
    const h = harness({ capture: () => false })
    try {
      await turn(h, 'idle', 'idle')
      assert.deepEqual(h.captured, [], 'the fake capture refused')
      assert.equal(h.index.timelineFor(W), null, 'no entry points at a ref that was never written')
    } finally {
      h.dispose()
    }
  })

  await run('a close with no baseline takes the baseline instead of faking a span', async () => {
    const h = harness()
    try {
      // The app started mid-turn, or an open frame was lost.
      h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'tool_use', next: 'idle' })
      await h.reactor.whenSettled()
      assert.deepEqual(h.captured, [checkpointRefFor(W, 0)], 'turn 0, not turn 1')
      assert.equal(h.index.hasBaseline(W), true)
    } finally {
      h.dispose()
    }
  })

  await run('an agent dying mid-turn still gets its checkpoint', async () => {
    const h = harness()
    try {
      h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'idle', next: 'thinking' })
      await h.reactor.whenSettled()
      h.reactor.handlePhase({ workspaceId: W, cwd: CWD, previous: 'thinking', next: 'failed' })
      await h.reactor.whenSettled()
      assert.deepEqual(h.captured, [checkpointRefFor(W, 0), checkpointRefFor(W, 1)])
    } finally {
      h.dispose()
    }
  })

  await run('a workspace with no folder is ignored entirely', async () => {
    const h = harness()
    try {
      h.reactor.handlePhase({ workspaceId: W, cwd: '', previous: 'idle', next: 'thinking' })
      h.reactor.handlePhase({ workspaceId: '', cwd: CWD, previous: 'idle', next: 'thinking' })
      await h.reactor.whenSettled()
      assert.deepEqual(h.captured, [])
    } finally {
      h.dispose()
    }
  })

  await run('forgetting a workspace deletes its refs from the repo', async () => {
    const h = harness()
    try {
      await turn(h, 'idle', 'idle')
      await h.reactor.forgetWorkspace(W)
      assert.deepEqual(h.deleted, [checkpointRefFor(W, 0), checkpointRefFor(W, 1)])
      assert.equal(h.index.timelineFor(W), null)
      // Forgetting twice is harmless.
      await h.reactor.forgetWorkspace(W)
      assert.equal(h.deleted.length, 2)
    } finally {
      h.dispose()
    }
  })

  if (failures > 0) {
    console.error(`checkpoint-reactor.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('checkpoint-reactor.test.ts: ok')
}
