import assert from 'node:assert/strict'
import { createSprintPowerManager, type PowerSaveBlockerLike } from './sprint-power-manager'

type FakeBlocker = PowerSaveBlockerLike & {
  counts: { start: number; stop: number }
  started: Set<number>
}

function fakeBlocker(): FakeBlocker {
  const started = new Set<number>()
  const counts = { start: 0, stop: 0 }
  let nextId = 1
  return {
    counts,
    started,
    start() {
      counts.start += 1
      const id = nextId++
      started.add(id)
      return id
    },
    stop(id: number) {
      counts.stop += 1
      started.delete(id)
    },
    isStarted(id: number) {
      return started.has(id)
    },
  }
}

// acquire on first active run; hold across additional runs; release on last
{
  const blocker = fakeBlocker()
  const manager = createSprintPowerManager({ powerSaveBlocker: blocker })
  assert.equal(manager.isHolding(), false)

  manager.markRunActive('/a/run.yaml')
  assert.equal(manager.isHolding(), true)
  assert.equal(blocker.counts.start, 1)

  manager.markRunActive('/b/run.yaml')
  manager.markRunActive('/a/run.yaml') // idempotent
  assert.equal(blocker.counts.start, 1, 'one blocker covers all active runs')
  assert.equal(manager.activeRunCount(), 2)

  manager.markRunInactive('/a/run.yaml')
  assert.equal(manager.isHolding(), true, 'still one active run')

  manager.markRunInactive('/b/run.yaml')
  assert.equal(manager.isHolding(), false)
  assert.equal(blocker.counts.stop, 1)
  assert.equal(blocker.started.size, 0)
}

// double release + unknown run are harmless
{
  const blocker = fakeBlocker()
  const manager = createSprintPowerManager({ powerSaveBlocker: blocker })
  manager.markRunInactive('/never-active/run.yaml')
  assert.equal(manager.isHolding(), false)
  manager.markRunActive('/a/run.yaml')
  manager.markRunInactive('/a/run.yaml')
  manager.markRunInactive('/a/run.yaml')
  assert.equal(blocker.counts.stop, 1)
}

// re-acquire after release
{
  const blocker = fakeBlocker()
  const manager = createSprintPowerManager({ powerSaveBlocker: blocker })
  manager.markRunActive('/a/run.yaml')
  manager.markRunInactive('/a/run.yaml')
  manager.markRunActive('/a/run.yaml')
  assert.equal(manager.isHolding(), true)
  assert.equal(blocker.counts.start, 2)
}

// shutdown releases unconditionally
{
  const blocker = fakeBlocker()
  const manager = createSprintPowerManager({ powerSaveBlocker: blocker })
  manager.markRunActive('/a/run.yaml')
  manager.markRunActive('/b/run.yaml')
  manager.shutdown()
  assert.equal(manager.isHolding(), false)
  assert.equal(blocker.started.size, 0)
  assert.equal(manager.activeRunCount(), 0)
}

// externally-stopped blocker (e.g. OS revoked) is re-acquired on the next transition
{
  const blocker = fakeBlocker()
  const manager = createSprintPowerManager({ powerSaveBlocker: blocker })
  manager.markRunActive('/a/run.yaml')
  blocker.started.clear() // simulate the blocker dying externally
  manager.markRunActive('/b/run.yaml')
  assert.equal(manager.isHolding(), true, 're-acquired')
  assert.equal(blocker.counts.start, 2)
}

console.log('sprint-power-manager tests passed')
