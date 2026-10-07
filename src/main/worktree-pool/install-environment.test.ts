import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { captureLoginEnv } from '../../../resources/wsl-helper/lib/login-env.mjs'
import { dependencyInstallEnvironment, isAppOwnVariable, type LoginEnvironmentCapture } from './install-environment'

const APP_ENV = {
  PATH: '/usr/bin:/bin:/Applications/SprintEngine Studio.app/Contents/Resources/bin',
  HOME: '/Users/dev',
  SHELL: '/bin/zsh',
  SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/x',
  SPRINTENGINE_AGENT_ID: 'agent-claude-1',
  ELECTRON_RUN_AS_NODE: '1',
  CLAUDECODE: '1',
}

test('the login environment is kept whole, its PATH first, with none of the app’s own variables', async () => {
  const seen: Array<{ shell: string; env: Record<string, string> }> = []
  const capture: LoginEnvironmentCapture = async ({ shell, env, keep }) => {
    seen.push({ shell, env })
    const printed: Record<string, string> = {
      PATH: '/Users/dev/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin',
      HOME: '/Users/dev',
      NPM_TOKEN: 'npm_secret',
      ACME_REGISTRY_TOKEN: 'from-zshrc',
      HTTPS_PROXY: 'http://proxy.example.com:3128',
      NODE_EXTRA_CA_CERTS: '/Users/dev/certs/corp.pem',
      SPRINTENGINE_FROM_PROFILE: 'x',
      PWD: '/',
    }
    return Object.fromEntries(Object.entries(printed).filter(([name]) => keep(name)))
  }
  const env = await dependencyInstallEnvironment({ platform: 'darwin', processEnv: APP_ENV, capture })

  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.shell, '/bin/zsh', 'the person’s own shell')
  assert.equal(seen[0]!.env.SPRINTENGINE_AGENT_ID, undefined, 'the probing shell starts without the app’s variables')
  assert.equal(seen[0]!.env.CLAUDECODE, undefined)

  assert.equal(env.NPM_TOKEN, 'npm_secret')
  assert.equal(env.ACME_REGISTRY_TOKEN, 'from-zshrc', 'a name nobody could list in advance')
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example.com:3128')
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/Users/dev/certs/corp.pem')
  assert.equal(
    env.PATH,
    '/Users/dev/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin:/Applications/SprintEngine Studio.app/Contents/Resources/bin',
    'the login PATH first, then what only the app had',
  )
  for (const name of Object.keys(env)) assert.equal(name.startsWith('SPRINTENGINE_'), false, name)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.PWD, undefined)
})

test('a login shell that cannot be read leaves the app’s environment, still cleaned', async () => {
  const env = await dependencyInstallEnvironment({
    platform: 'linux',
    processEnv: APP_ENV,
    capture: async () => {
      throw new Error('no shell')
    },
  })
  assert.equal(env.HOME, '/Users/dev')
  assert.equal(env.PATH, '/usr/bin:/bin:/Applications/SprintEngine Studio.app/Contents/Resources/bin')
  assert.equal(env.SPRINTENGINE_USER_DATA_DIR, undefined)
})

test('Windows asks no login shell and keeps the app’s environment, less its own variables', async () => {
  let asked = false
  const env = await dependencyInstallEnvironment({
    platform: 'win32',
    processEnv: { Path: 'C:\\Windows', SPRINTENGINE_AGENT_ID: 'a', USERPROFILE: 'C:\\Users\\dev' },
    capture: async () => {
      asked = true
      return {}
    },
  })
  assert.equal(asked, false)
  assert.deepEqual(env, { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\dev' })
})

test('the app’s own variables are its SPRINTENGINE_ names and the process’s bookkeeping', () => {
  assert.equal(isAppOwnVariable('SPRINTENGINE_WORKSPACE_ID'), true)
  assert.equal(isAppOwnVariable('ELECTRON_RUN_AS_NODE'), true)
  assert.equal(isAppOwnVariable('NPM_TOKEN'), false)
  assert.equal(isAppOwnVariable('npm_config_registry'), false)
})

test.skipIf(process.platform === 'win32')(
  'the shared capture keeps what the caller asks for and starts the shell with the environment given',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sprintengine-install-env-'))
    try {
      const shell = join(dir, 'fake-shell')
      // Prints what a login shell's `env -0` would, after the sentinel, plus
      // one variable it was started with, to show which environment it got.
      await writeFile(
        shell,
        '#!/bin/sh\nprintf \'\\000__SPRINTENGINE_ENV__\\000PATH=/opt/x/bin\\000NPM_TOKEN=t\\000GIVEN=%s\\000\' "$GIVEN"\n',
        { mode: 0o755 },
      )
      const kept = await captureLoginEnv({
        shell,
        env: { GIVEN: 'yes', PATH: '/usr/bin:/bin' },
        keep: (name) => name !== 'GIVEN',
        timeoutMs: 5_000,
      })
      assert.deepEqual(kept, { PATH: '/opt/x/bin', NPM_TOKEN: 't' })
      const everything = await captureLoginEnv({
        shell,
        env: { GIVEN: 'yes', PATH: '/usr/bin:/bin' },
        keep: () => true,
        timeoutMs: 5_000,
      })
      assert.equal(everything.GIVEN, 'yes')
      const fixedList = await captureLoginEnv({ shell, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000 })
      assert.equal(fixedList.NPM_TOKEN, undefined, 'the WSL helper’s fixed list is unchanged')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
