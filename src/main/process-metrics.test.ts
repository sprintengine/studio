import assert from 'node:assert/strict'
import { collectProcessMetrics, type RawProcessMetric } from './process-metrics'

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

run('maps Electron process types to roles and KB memory to bytes', () => {
  const raw: RawProcessMetric[] = [
    { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 12.34 }, memory: { workingSetSize: 1024 } },
    { pid: 2, type: 'Tab', cpu: { percentCPUUsage: 50 }, memory: { workingSetSize: 2048 } },
    { pid: 3, type: 'GPU', cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 512 } },
    { pid: 4, type: 'Utility', name: 'Network Service', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 256 } },
  ]
  const snapshot = collectProcessMetrics(() => raw, NOW)

  assert.equal(snapshot.sampledAt, NOW)
  const byPid = new Map(snapshot.processes.map((p) => [p.pid, p]))
  assert.equal(byPid.get(1)!.kind, 'main')
  assert.equal(byPid.get(2)!.kind, 'renderer')
  assert.equal(byPid.get(3)!.kind, 'gpu')
  assert.equal(byPid.get(4)!.kind, 'utility')
  assert.equal(byPid.get(4)!.name, 'Network Service')
  assert.equal(byPid.get(1)!.memoryBytes, 1024 * 1024, 'KB working set converted to bytes')
  assert.equal(byPid.get(1)!.cpuPercent, 12.3, 'cpu rounded to one decimal')
})

run('sorts main first, then renderer/gpu/utility, hottest within kind', () => {
  const raw: RawProcessMetric[] = [
    { pid: 10, type: 'Tab', cpu: { percentCPUUsage: 10 }, memory: { workingSetSize: 1 } },
    { pid: 11, type: 'Tab', cpu: { percentCPUUsage: 40 }, memory: { workingSetSize: 1 } },
    { pid: 12, type: 'Browser', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1 } },
  ]
  const snapshot = collectProcessMetrics(() => raw, NOW)
  assert.deepEqual(
    snapshot.processes.map((p) => p.pid),
    [12, 11, 10],
  )
})

run('degrades to empty processes when getAppMetrics throws', () => {
  const snapshot = collectProcessMetrics(() => {
    throw new Error('no metrics in this runtime')
  }, NOW)
  assert.deepEqual(snapshot, { sampledAt: NOW, processes: [] })
})

run('handles missing cpu/memory fields without NaN', () => {
  const snapshot = collectProcessMetrics(() => [{ pid: 99, type: 'Tab' }], NOW)
  assert.equal(snapshot.processes[0].cpuPercent, 0)
  assert.equal(snapshot.processes[0].memoryBytes, 0)
})

run('merges main heap usage onto the matching pid only', () => {
  const raw: RawProcessMetric[] = [
    { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1024 } },
    { pid: 200, type: 'Tab', cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 1024 } },
  ]
  const snapshot = collectProcessMetrics(() => raw, NOW, {
    pid: 100,
    heapUsedBytes: 40 * 1024 * 1024,
    heapTotalBytes: 64 * 1024 * 1024,
  })
  const byPid = new Map(snapshot.processes.map((p) => [p.pid, p]))
  assert.equal(byPid.get(100)!.heapUsedBytes, 40 * 1024 * 1024, 'main process gets heap detail')
  assert.equal(byPid.get(100)!.heapTotalBytes, 64 * 1024 * 1024)
  assert.equal(byPid.get(200)!.heapUsedBytes, undefined, 'renderer pid is untouched')
})

run('includes supplied child process metrics in sorted snapshot', () => {
  const raw: RawProcessMetric[] = [
    { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1024 } },
    { pid: 200, type: 'Tab', cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 1024 } },
  ]
  const snapshot = collectProcessMetrics(() => raw, NOW, undefined, undefined, [
    { pid: 300, kind: 'agent', type: 'Child', name: 'Claude CLI', cpuPercent: 2, memoryBytes: 300 * 1024 * 1024 },
    { pid: 400, kind: 'helper', type: 'Child', name: 'Playwright MCP', cpuPercent: 1, memoryBytes: 40 * 1024 * 1024 },
  ])

  assert.deepEqual(
    snapshot.processes.map((process) => process.pid),
    [100, 200, 300, 400],
  )
  assert.equal(
    snapshot.processes.reduce((total, process) => total + process.memoryBytes, 0),
    (2 + 300 + 40) * 1024 * 1024,
  )
})

console.log('process-metrics tests passed')
