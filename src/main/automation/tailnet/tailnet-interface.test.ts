import assert from 'node:assert/strict'
import { test } from 'vitest'

import { isInsideWsl } from './tailnet-interface'

test('a process knows it is inside WSL by its distribution name or the interop entry, and only on Linux', () => {
  const none = () => false
  assert.equal(isInsideWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, exists: none }), true)
  assert.equal(
    isInsideWsl({ platform: 'linux', env: {}, exists: (path) => path === '/proc/sys/fs/binfmt_misc/WSLInterop' }),
    true,
  )
  assert.equal(isInsideWsl({ platform: 'linux', env: {}, exists: none }), false)
  assert.equal(isInsideWsl({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, exists: none }), false)
  assert.equal(isInsideWsl({ platform: 'darwin', env: {}, exists: () => true }), false)
})
