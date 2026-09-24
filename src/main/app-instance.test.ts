import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import { allowsMultipleInstances, claimAppInstance, configureDevUserData } from './app-instance'

const VARIABLES = ['SPRINTENGINE_USER_DATA_DIR', 'SPRINTENGINE_ALLOW_MULTI_INSTANCE'] as const

afterEach(() => {
  for (const name of VARIABLES) delete process.env[name]
})

function fakeApp(options: { isPackaged?: boolean; lock?: boolean } = {}) {
  const calls = { setPath: [] as Array<[string, string]>, locks: 0 }
  return {
    calls,
    app: {
      isPackaged: options.isPackaged ?? false,
      setPath: (name: string, value: string) => {
        calls.setPath.push([name, value])
      },
      requestSingleInstanceLock: () => {
        calls.locks += 1
        return options.lock ?? true
      },
    },
  }
}

test('a dev build pinned to a profile moves there, a packaged build never does', () => {
  process.env.SPRINTENGINE_USER_DATA_DIR = ' /Users/dev/profiles/one '
  const dev = fakeApp()
  configureDevUserData(dev.app as never)
  assert.deepEqual(dev.calls.setPath, [['userData', '/Users/dev/profiles/one']])

  const packaged = fakeApp({ isPackaged: true })
  configureDevUserData(packaged.app as never)
  assert.deepEqual(packaged.calls.setPath, [])

  delete process.env.SPRINTENGINE_USER_DATA_DIR
  const unpinned = fakeApp()
  configureDevUserData(unpinned.app as never)
  assert.deepEqual(unpinned.calls.setPath, [])
})

test('multiple instances need a dev build, the opt-in and a profile of its own', () => {
  assert.equal(allowsMultipleInstances({ isPackaged: false }), false)
  process.env.SPRINTENGINE_ALLOW_MULTI_INSTANCE = '1'
  assert.equal(allowsMultipleInstances({ isPackaged: false }), false, 'no profile of its own')
  process.env.SPRINTENGINE_USER_DATA_DIR = '/Users/dev/profiles/two'
  assert.equal(allowsMultipleInstances({ isPackaged: false }), true)
  assert.equal(allowsMultipleInstances({ isPackaged: true }), false, 'never a packaged build')
})

test('the first launch takes the lock and a second one is told to exit', () => {
  const first = fakeApp({ lock: true })
  assert.equal(claimAppInstance(first.app), true)
  assert.equal(first.calls.locks, 1)

  const second = fakeApp({ lock: false })
  assert.equal(claimAppInstance(second.app), false)
  assert.equal(second.calls.locks, 1)
})

test('a dev build allowed to run beside another never asks for the lock', () => {
  process.env.SPRINTENGINE_ALLOW_MULTI_INSTANCE = '1'
  process.env.SPRINTENGINE_USER_DATA_DIR = '/Users/dev/profiles/three'
  const side = fakeApp({ lock: false })
  assert.equal(claimAppInstance(side.app), true)
  assert.equal(side.calls.locks, 0)
})
