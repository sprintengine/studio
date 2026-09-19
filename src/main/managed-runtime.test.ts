import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  bundledNpmCliPath,
  managedNodeBinary,
  managedNodeEnv,
  withManagedRuntimePath,
  type RuntimeEnv,
} from './managed-runtime'
import { test } from 'vitest'

test('managed-runtime', async () => {
  function makeEnv(overrides: Partial<RuntimeEnv> & { present?: string[] } = {}): RuntimeEnv {
    const present = new Set(overrides.present ?? [])
    return {
      platform: overrides.platform ?? 'linux',
      resourcesPath: overrides.resourcesPath ?? '/app/resources',
      isPackaged: overrides.isPackaged ?? true,
      execPath: overrides.execPath ?? '/app/multicode',
      cwd: overrides.cwd ?? '/checkout',
      exists: overrides.exists ?? ((p: string) => present.has(p)),
    }
  }

  // --- node / npm ------------------------------------------------------------

  {
    const env = makeEnv({ execPath: '/app/Multicode' })
    assert.equal(managedNodeBinary(env), '/app/Multicode', 'managed node is the electron binary')
  }

  {
    const result = managedNodeEnv({ FOO: 'bar' })
    assert.equal(result.ELECTRON_RUN_AS_NODE, '1', 'sets ELECTRON_RUN_AS_NODE')
    assert.equal(result.FOO, 'bar', 'preserves existing env')
  }

  {
    const npm = join('/app/resources', 'runtime', 'npm', 'bin', 'npm-cli.js')
    const env = makeEnv({ present: [npm] })
    assert.equal(bundledNpmCliPath(env), npm, 'finds bundled npm cli')
    assert.equal(bundledNpmCliPath(makeEnv({ present: [] })), null, 'null when npm not vendored')
  }

  // --- PATH shim injection ---------------------------------------------------

  {
    const env = withManagedRuntimePath({ PATH: '/usr/bin:/bin' }, '/shim', 'linux')
    assert.equal(env.PATH, `/shim:/usr/bin:/bin`, 'prepends shim dir to PATH')
  }

  {
    const already = withManagedRuntimePath({ PATH: '/shim:/usr/bin' }, '/shim', 'linux')
    assert.equal(already.PATH, '/shim:/usr/bin', 'idempotent when shim already present')
  }

  {
    // Windows uses the case-insensitive Path key and `;` delimiter (delimiter is
    // platform-dependent at runtime; assert structure rather than separator).
    const env = withManagedRuntimePath({ Path: 'C:\\Windows' }, 'C:\\shim', 'win32')
    assert.ok(env.Path?.startsWith('C:\\shim'), 'prepends shim dir on windows Path key')
  }

  console.log('managed-runtime.test.ts ok')
})
