import assert from 'node:assert/strict'
import { summarizeFrameStats, type FrameSample } from './frameStatsStore'
import { test } from 'vitest'

test('frameStatsStore', async () => {
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

  function frame(durationMs: number, recordedAt: number): FrameSample {
    return { durationMs, recordedAt }
  }

  run('empty input summarizes to zeroes with null fps/max/p95', () => {
    const summary = summarizeFrameStats([], { now: NOW })
    assert.equal(summary.frameCount, 0)
    assert.equal(summary.fps, null)
    assert.equal(summary.longFrameCount, 0)
    assert.equal(summary.longFramePercent, 0)
    assert.equal(summary.maxMs, null)
    assert.equal(summary.p95Ms, null)
    assert.equal(summary.lastAt, null)
  })

  run('smooth 60fps stream reports ~60 fps and no long frames', () => {
    const samples = Array.from({ length: 60 }, (_, i) => frame(16.7, NOW - (60 - i)))
    const summary = summarizeFrameStats(samples, { now: NOW })
    assert.equal(summary.frameCount, 60)
    assert.equal(summary.fps, 60) // 1000 / 16.7 ≈ 59.9 → rounds to 60
    assert.equal(summary.longFrameCount, 0)
    assert.equal(summary.longFramePercent, 0)
  })

  run('counts long frames over the 50ms threshold and computes percent', () => {
    // 8 smooth frames + 2 stutters (120ms, 80ms) = 10 frames, 2 long (20%).
    const samples = [
      ...Array.from({ length: 8 }, (_, i) => frame(16, NOW - (10 - i))),
      frame(120, NOW - 2),
      frame(80, NOW - 1),
    ]
    const summary = summarizeFrameStats(samples, { now: NOW })
    assert.equal(summary.frameCount, 10)
    assert.equal(summary.longFrameCount, 2)
    assert.equal(summary.longFramePercent, 20)
    assert.equal(summary.maxMs, 120)
    assert.equal(summary.lastAt, NOW - 1)
  })

  run('windowMs excludes stale frames', () => {
    const summary = summarizeFrameStats([frame(500, NOW - 30_000), frame(16, NOW - 1_000), frame(17, NOW - 500)], {
      now: NOW,
      windowMs: 5_000,
    })
    assert.equal(summary.frameCount, 2)
    assert.equal(summary.longFrameCount, 0)
    assert.equal(summary.maxMs, 17)
  })

  console.log('frame-stats store tests passed')
})
