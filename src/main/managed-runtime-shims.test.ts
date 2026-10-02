import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test, vi } from 'vitest'

// The shims land under the home directory; this suite's is a temporary one.
const home = mkdtempSync(join(tmpdir(), 'managed-runtime-shims-'))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), homedir: () => home }))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const { ensureManagedRuntimeShims } = await import('./managed-runtime')

function env(execPathIsElectron: boolean | undefined) {
  const npmCli = join('/app/resources', 'runtime', 'npm', 'bin', 'npm-cli.js')
  return {
    platform: 'linux' as const,
    resourcesPath: '/app/resources',
    isPackaged: true,
    execPath: execPathIsElectron === false ? '/usr/local/bin/node' : '/app/sprintengine',
    ...(execPathIsElectron === undefined ? {} : { execPathIsElectron }),
    cwd: '/checkout',
    exists: (path: string) => path === npmCli,
  }
}

test.skipIf(process.platform === 'win32')(
  'the shims turn Electron into Node, and leave a plain Node exactly as it is',
  () => {
    const electron = ensureManagedRuntimeShims(env(undefined))
    assert.ok(electron)
    assert.match(
      readFileSync(join(electron.shimDir, 'node'), 'utf8'),
      /exec env ELECTRON_RUN_AS_NODE=1 '\/app\/sprintengine'/,
    )

    const node = ensureManagedRuntimeShims(env(false))
    assert.ok(node)
    const nodeShim = readFileSync(join(node.shimDir, 'node'), 'utf8')
    const npmShim = readFileSync(join(node.shimDir, 'npm'), 'utf8')
    assert.doesNotMatch(nodeShim + npmShim, /ELECTRON_RUN_AS_NODE/)
    assert.match(nodeShim, /^exec '\/usr\/local\/bin\/node' "\$@"$/m)
  },
)
