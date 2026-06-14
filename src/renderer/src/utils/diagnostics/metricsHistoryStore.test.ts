import assert from 'node:assert/strict'
import type { ProcessMetricsSnapshot } from '../../../../shared/electron-api'
import {
  computeGrowthRates,
  deriveMetricsSample,
  diffMetricsSamples,
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
    ],
  }
}

run('derives per-kind sums and total, folding multiple renderers', () => {
  const sample = deriveMetricsSample(snapshot(NOW), { usedBytes: 500 * MIB, totalBytes: 900 * MIB })
  assert.equal(sample.rendererCpuPercent, 10, 'renderer cpu summed across both Tabs')
  assert.equal(sample.rendererRssBytes, 1200 * MIB)
  assert.equal(sample.mainRssBytes, 120 * MIB)
  assert.equal(sample.gpuRssBytes, 70 * MIB)
  assert.equal(sample.totalRssBytes, 1390 * MIB)
  assert.equal(sample.rendererHeapUsedBytes, 500 * MIB)
})

run('null heap when performance.memory absent', () => {
  const sample = deriveMetricsSample(snapshot(NOW), null)
  assert.equal(sample.rendererHeapUsedBytes, null)
  assert.equal(sample.rendererHeapTotalBytes, null)
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

console.log('metrics history store tests passed')
