import assert from 'node:assert/strict'
import type { IpcStatsSnapshot } from '../../../../shared/electron-api'
import { diffIpcSnapshots } from './ipcThroughputStore'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = 1_700_000_000_000

run('diffs monotonic counters into per-second rates', () => {
  const prev: IpcStatsSnapshot = {
    sampledAt: NOW - 1000,
    channels: [{ name: 'onTerminalData', calls: 1, outBytes: 0, inEvents: 100, inBytes: 50_000 }],
  }
  const current: IpcStatsSnapshot = {
    sampledAt: NOW,
    channels: [{ name: 'onTerminalData', calls: 1, outBytes: 0, inEvents: 140, inBytes: 70_000 }],
  }
  const throughput = diffIpcSnapshots(prev, current)
  assert.equal(throughput.elapsedMs, 1000)
  assert.equal(throughput.channels[0].inEventsPerSec, 40, '40 events in 1s')
  assert.equal(throughput.channels[0].inBytesPerSec, 20_000)
  assert.equal(throughput.channels[0].totalCalls, 1)
})

run('first snapshot (no prev) yields zero rates, not NaN', () => {
  const current: IpcStatsSnapshot = {
    sampledAt: NOW,
    channels: [{ name: 'readSprintEngineProjection', calls: 5, outBytes: 100, inEvents: 0, inBytes: 0 }],
  }
  const throughput = diffIpcSnapshots(null, current)
  assert.equal(throughput.channels[0].callsPerSec, 0)
  assert.equal(throughput.channels[0].outBytesPerSec, 0)
})

run('sorts busiest-by-bytes channel first', () => {
  const prev: IpcStatsSnapshot = { sampledAt: NOW - 1000, channels: [] }
  const current: IpcStatsSnapshot = {
    sampledAt: NOW,
    channels: [
      { name: 'quiet', calls: 2, outBytes: 10, inEvents: 0, inBytes: 0 },
      { name: 'chatty', calls: 1, outBytes: 0, inEvents: 5, inBytes: 99_000 },
    ],
  }
  const throughput = diffIpcSnapshots(prev, current)
  assert.equal(throughput.channels[0].name, 'chatty')
})

console.log('ipc throughput store tests passed')
