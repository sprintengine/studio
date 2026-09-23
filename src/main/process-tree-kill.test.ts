import assert from 'node:assert/strict'
import { test } from 'vitest'

import { killProcessTree } from './process-tree-kill'

function fakeChild(pid: number | undefined) {
  const signals: Array<NodeJS.Signals | number | undefined> = []
  return {
    child: {
      pid,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal)
        return true
      },
    },
    signals,
  }
}

test('on Windows the whole tree is ended through taskkill, not only the wrapper', () => {
  const { child, signals } = fakeChild(4242)
  const killed: number[] = []
  killProcessTree(child, { platform: 'win32', runTaskkill: (pid) => killed.push(pid) })
  assert.deepEqual(killed, [4242])
  assert.deepEqual(signals, [], 'the single-process kill is not needed')
})

test('on Windows a taskkill that cannot start falls back to killing the one process', () => {
  const { child, signals } = fakeChild(4242)
  killProcessTree(child, {
    platform: 'win32',
    runTaskkill: () => {
      throw new Error('spawn taskkill ENOENT')
    },
  })
  assert.deepEqual(signals, ['SIGKILL'])
})

test('a child that never got a pid is killed directly, on any platform', () => {
  const { child, signals } = fakeChild(undefined)
  let taskkills = 0
  killProcessTree(child, { platform: 'win32', runTaskkill: () => (taskkills += 1) })
  assert.equal(taskkills, 0)
  assert.deepEqual(signals, ['SIGKILL'])
})

test('POSIX keeps the plain SIGKILL', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const { child, signals } = fakeChild(99)
    let taskkills = 0
    killProcessTree(child, { platform, runTaskkill: () => (taskkills += 1) })
    assert.equal(taskkills, 0)
    assert.deepEqual(signals, ['SIGKILL'])
  }
})

test('a child that is already gone does not throw', () => {
  const child = {
    pid: 7,
    kill(): boolean {
      throw new Error('ESRCH')
    },
  }
  assert.doesNotThrow(() => killProcessTree(child, { platform: 'darwin' }))
})
