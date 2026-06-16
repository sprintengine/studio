import assert from 'node:assert/strict'
import type { ProcessMetricsSnapshot } from '../../../../shared/electron-api'
import {
  appendMetricsSample,
  computeGrowthRates,
  deriveMetricsSample,
  diffMetricsSamples,
  getMetricsPeaks,
  resetMetricsPeaks,
  type MetricsSample,
} from './metricsHistoryStore'

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
const MIB = 1024 * 1024

function snapshot(sampledAt: number): ProcessMetricsSnapshot {
  return {
    sampledAt,
    processes: [
      { pid: 1, kind: 'main', type: 'Browser', cpuPercent: 1, memoryBytes: 120 * MIB },
      { pid: 2, kind: 'renderer', type: 'Tab', cpuPercent: 6, memoryBytes: 1000 * MIB },
      { pid: 3, kind: 'renderer', type: 'Tab', cpuPercent: 4, memoryBytes: 200 * MIB },
      { pid: 4, kind: 'gpu', type: 'GPU', cpuPercent: 2, memoryBytes: 70 * MIB },
      { pid: 5, kind: 'agent', type: 'Child', name: 'Claude CLI', cpuPercent: 3, memoryBytes: 300 * MIB },
      { pid: 6, kind: 'helper', type: 'Child', name: 'Playwright MCP', cpuPercent: 1, memoryBytes: 40 * MIB },
    ],
  }
}

run('derives per-kind sums and total, folding multiple renderers', () => {
  const sample = deriveMetricsSample(snapshot(NOW), { usedBytes: 500 * MIB, totalBytes: 900 * MIB })
  assert.equal(sample.rendererCpuPercent, 10, 'renderer cpu summed across both Tabs')
  assert.equal(sample.rendererRssBytes, 1200 * MIB)
  assert.equal(sample.mainRssBytes, 120 * MIB)
  assert.equal(sample.gpuRssBytes, 70 * MIB)
  assert.equal(sample.childRssBytes, 340 * MIB)
  assert.equal(sample.totalRssBytes, 1730 * MIB)
  assert.equal(sample.rendererHeapUsedBytes, 500 * MIB)
})

run('null heap when performance.memory absent', () => {
  const sample = deriveMetricsSample(snapshot(NOW), null)
  assert.equal(sample.rendererHeapUsedBytes, null)
  assert.equal(sample.rendererHeapTotalBytes, null)
})

run('systemMemory is null when the snapshot omits it', () => {
  const sample = deriveMetricsSample(snapshot(NOW), null)
  assert.equal(sample.systemMemory, null)
})

run('systemMemory is carried through from the snapshot', () => {
  const withSystem: ProcessMetricsSnapshot = {
    ...snapshot(NOW),
    systemMemory: {
      totalBytes: 16 * 1024 * MIB,
      availableBytes: 4 * 1024 * MIB,
      usedBytes: 12 * 1024 * MIB,
      compressedBytes: 5 * 1024 * MIB,
      swapUsedBytes: 1024 * MIB,
      pressure: 0.75,
      source: 'vm_stat',
    },
  }
  const sample = deriveMetricsSample(withSystem, null)
  assert.equal(sample.systemMemory?.source, 'vm_stat')
  assert.equal(sample.systemMemory?.pressure, 0.75)
  assert.equal(sample.systemMemory?.availableBytes, 4 * 1024 * MIB)
})

run('diff reports deltas against a baseline', () => {
  const base = deriveMetricsSample(snapshot(NOW - 10_000), { usedBytes: 400 * MIB, totalBytes: 900 * MIB })
  const heavier = snapshot(NOW)
  heavier.processes[1].memoryBytes = 1400 * MIB
  const cur = deriveMetricsSample(heavier, { usedBytes: 650 * MIB, totalBytes: 900 * MIB })
  const diff = diffMetricsSamples(base, cur)
  assert.equal(diff.elapsedMs, 10_000)
  assert.equal(diff.rendererRssBytes, 400 * MIB)
  assert.equal(diff.rendererHeapUsedBytes, 250 * MIB)
})

run('growth rate is bytes/min from first vs last in window', () => {
  const a: MetricsSample = deriveMetricsSample(snapshot(NOW - 60_000), { usedBytes: 100 * MIB, totalBytes: 900 * MIB })
  const bSnap = snapshot(NOW)
  bSnap.processes[1].memoryBytes = 1060 * MIB // baseline renderer was 1000 MiB → +60 MiB total over 1 min
  const b: MetricsSample = deriveMetricsSample(bSnap, { usedBytes: 130 * MIB, totalBytes: 900 * MIB })
  const growth = computeGrowthRates([a, b], { now: NOW, windowMs: 120_000 })
  assert.equal(growth.sampleCount, 2)
  assert.equal(growth.rssBytesPerMin, 60 * MIB, '+60 MiB over 1 minute')
  assert.equal(growth.heapBytesPerMin, 30 * MIB, '+30 MiB heap over 1 minute')
})

run('growth rate null with fewer than two samples in window', () => {
  const only: MetricsSample = deriveMetricsSample(snapshot(NOW), null)
  const growth = computeGrowthRates([only], { now: NOW })
  assert.equal(growth.rssBytesPerMin, null)
  assert.equal(growth.heapBytesPerMin, null)
})

run('high-water marks track the max across appended samples, surviving a later dip', () => {
  resetMetricsPeaks()
  const big = snapshot(NOW)
  big.processes[1].memoryBytes = 5000 * MIB // big renderer spike
  appendMetricsSample(deriveMetricsSample(big, null))
  const smaller = snapshot(NOW + 1000)
  smaller.processes[1].memoryBytes = 200 * MIB // reclaimed afterwards
  appendMetricsSample(deriveMetricsSample(smaller, null))

  const peaks = getMetricsPeaks()
  // Peak holds the earlier spike even though the latest sample is far lower.
  // big totals: main 120 + renderers (5000+200) + gpu 70 + agent 300 + helper 40.
  assert.equal(peaks.totalRssBytes, (120 + 5000 + 200 + 70 + 300 + 40) * MIB)
  assert.equal(peaks.totalRssAt, NOW)
  assert.equal(peaks.childRssBytes, 340 * MIB)
})

run('high-water marks capture peak OS pressure from system memory samples', () => {
  resetMetricsPeaks()
  const withSystem: ProcessMetricsSnapshot = {
    ...snapshot(NOW),
    systemMemory: {
      totalBytes: 16 * 1024 * MIB,
      availableBytes: 2 * 1024 * MIB,
      usedBytes: 14 * 1024 * MIB,
      compressedBytes: 6 * 1024 * MIB,
      swapUsedBytes: 2 * 1024 * MIB,
      pressure: 0.88,
      source: 'vm_stat',
    },
  }
  appendMetricsSample(deriveMetricsSample(withSystem, null))
  appendMetricsSample(deriveMetricsSample(snapshot(NOW + 1000), null)) // no system memory
  const peaks = getMetricsPeaks()
  assert.equal(peaks.systemPressure, 0.88)
  assert.equal(peaks.systemPressureAt, NOW)
  assert.equal(peaks.systemUsedBytes, 14 * 1024 * MIB)
  resetMetricsPeaks()
})

console.log('metrics history store tests passed')
