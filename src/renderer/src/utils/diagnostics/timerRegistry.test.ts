import assert from 'node:assert/strict'
import { registerTimer, getTimerRegistrations, summarizeTimers } from './timerRegistry'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

run('registers, records ticks, and computes avg/max sorted by cost', () => {
  const cheap = registerTimer('cheap-loop', 4000, 1000)
  const spiky = registerTimer('spiky-loop', 4000, 1000)
  cheap.recordTick(2, 1100)
  cheap.recordTick(4, 1200)
  spiky.recordTick(100, 1300)

  const rows = summarizeTimers(getTimerRegistrations())
  assert.equal(rows[0].label, 'spiky-loop', 'highest avg cost first')
  const cheapRow = rows.find((row) => row.label === 'cheap-loop')!
  assert.equal(cheapRow.tickCount, 2)
  assert.equal(cheapRow.avgMs, 3, 'avg of 2 and 4')
  assert.equal(cheapRow.maxMs, 4)

  cheap.unregister()
  spiky.unregister()
  assert.equal(getTimerRegistrations().length, 0, 'unregister removes entries')
})

run('avg/max null before any tick', () => {
  const handle = registerTimer('idle-loop', 1000, 1000)
  const row = summarizeTimers(getTimerRegistrations()).find((r) => r.label === 'idle-loop')!
  assert.equal(row.avgMs, null)
  assert.equal(row.maxMs, null)
  handle.unregister()
})

console.log('timer registry tests passed')
