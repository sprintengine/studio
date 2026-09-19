import assert from 'node:assert/strict'

import { CANVAS_MAX_EXPORT_EDGE, CANVAS_MAX_EXPORT_SCALE, exportDimensions } from './exportSize'
import { test } from 'vitest'

test('exportSize', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  run('a board bigger than the budget is scaled down to it', () => {
    const size = exportDimensions(2000, 1000, 1024)
    assert.equal(size.width, 1024)
    assert.equal(size.height, 512)
    assert.equal(size.scale, 1024 / 2000)
  })

  run('a small board is doubled, not blown up to the budget', () => {
    const size = exportDimensions(200, 120, 1024)
    assert.equal(size.scale, CANVAS_MAX_EXPORT_SCALE)
    assert.equal(size.width, 400)
    assert.equal(size.height, 240)
  })

  run('doubling never takes a board past the budget', () => {
    // 600 doubled is 1200, which is over — so the budget wins.
    const size = exportDimensions(600, 300, 1024)
    assert.equal(size.width, 1024)
    assert.ok(size.scale < CANVAS_MAX_EXPORT_SCALE)
  })

  run('the browser canvas limit is honoured whatever was asked for', () => {
    const size = exportDimensions(40000, 100, 100000)
    assert.equal(size.width, CANVAS_MAX_EXPORT_EDGE)
  })

  run('a board of no size still produces a canvas', () => {
    assert.deepEqual(exportDimensions(0, 0, 1024), { width: 1, height: 1, scale: 1 })
    assert.deepEqual(exportDimensions(Number.NaN, 10, 1024), { width: 1, height: 1, scale: 1 })
  })

  run('a nonsense budget falls back to the browser limit rather than to nothing', () => {
    const size = exportDimensions(100, 100, 0)
    assert.equal(size.scale, CANVAS_MAX_EXPORT_SCALE)
  })
})
