// The PATH every terminal and agent the app starts inherits: the person's own,
// not launchd's. A Mac app opened from Finder or the Dock is handed
// `/usr/bin:/bin:/usr/sbin:/sbin`, and an agent's shell used to get exactly
// that (plus the managed runtime's bin), so `npx` and everything Homebrew
// installs were missing from it.

import assert from 'node:assert/strict'
import { delimiter } from 'node:path'

import { afterEach, test, vi } from 'vitest'

import { createLoginShellPathResolver, LOGIN_PATH_SENTINEL } from './login-shell-path'
import { getTerminalEnv } from './terminal-launch'
import { installElectronPlatformOver } from '../../tests/electron-platform'

vi.mock('electron', () => import('../../tests/stubs/electron'))
installElectronPlatformOver()

const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
})

test.skipIf(process.platform === 'win32')(
  'an agent started from a Finder launch sees the login shell PATH, ahead of launchd’s',
  async () => {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    const loginPath = '/Users/dev/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    await createLoginShellPathResolver({
      run: async () => ({ code: 0, stdout: `${LOGIN_PATH_SENTINEL}${loginPath}\n`, timedOut: false }),
      shell: () => '/bin/zsh',
    }).resolve({})

    const entries = (getTerminalEnv().PATH ?? '').split(delimiter)
    const login = loginPath.split(delimiter)
    for (const directory of login) assert.ok(entries.includes(directory), `${directory} is on the agent's PATH`)
    assert.ok(
      entries.indexOf('/opt/homebrew/bin') < entries.indexOf('/usr/sbin'),
      'the login shell’s entries come before the ones only launchd’s PATH had',
    )
    for (const directory of ['/usr/sbin', '/sbin']) {
      assert.ok(entries.includes(directory), `${directory}, which only the app's PATH had, is kept`)
    }
  },
)
