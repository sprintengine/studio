import assert from 'node:assert/strict'
import { test } from 'vitest'

import { updateInstallProgress, type UpdateInstallStage } from './update-install-progress'

test('the bar only moves forward, from getting ready to the hand-over', () => {
  const total = 15
  const stages: UpdateInstallStage[] = [
    { stage: 'preparing' },
    ...Array.from({ length: total + 1 }, (_, done) => ({ stage: 'saving' as const, done, total })),
    { stage: 'starting-installer' },
    { stage: 'handing-over', platform: 'win32', version: '0.7.0' },
  ]
  const positions = stages.map((stage) => updateInstallProgress(stage).progress)
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index]! >= positions[index - 1]!, `step ${index} does not move the bar back`)
  }
  assert.equal(positions.at(-1), 1)
  assert.ok(positions[0]! > 0 && positions[0]! < 0.1)
})

test('each finished shutdown leg advances "Saving your work…" by its share', () => {
  const first = updateInstallProgress({ stage: 'saving', done: 0, total: 4 })
  const half = updateInstallProgress({ stage: 'saving', done: 2, total: 4 })
  const all = updateInstallProgress({ stage: 'saving', done: 4, total: 4 })
  assert.equal(first.status, 'Saving your work…')
  assert.ok(Math.abs(half.progress - (first.progress + all.progress) / 2) < 1e-9, 'linear in legs done')
  assert.ok(all.progress < updateInstallProgress({ stage: 'starting-installer' }).progress)
  // Out-of-range counts clamp rather than overshoot or divide by zero.
  assert.equal(updateInstallProgress({ stage: 'saving', done: 9, total: 4 }).progress, all.progress)
  assert.equal(updateInstallProgress({ stage: 'saving', done: -1, total: 0 }).progress, first.progress)
})

test('the words name the step and the version', () => {
  assert.equal(updateInstallProgress({ stage: 'preparing' }).status, 'Getting ready to update…')
  assert.equal(updateInstallProgress({ stage: 'starting-installer' }).status, 'Starting the installer…')
  assert.equal(
    updateInstallProgress({ stage: 'handing-over', platform: 'win32', version: '0.7.0' }).status,
    'Installing SprintEngine Studio 0.7.0…',
  )
  assert.equal(
    updateInstallProgress({ stage: 'handing-over', platform: 'darwin', version: null }).status,
    'Restarting into the update…',
  )
})
