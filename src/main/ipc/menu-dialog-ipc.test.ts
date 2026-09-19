import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { TEST_OPEN_DIR_ENV, resolveTestOpenDirOverride } from './menu-dialog-ipc'
import { test } from 'vitest'

test('menu-dialog-ipc', async () => {
  async function main(): Promise<void> {
    const tempRoot = await mkdtemp(join(tmpdir(), 'sprintengine-open-dir-'))
    const selectedDir = join(tempRoot, 'selected')

    try {
      assert.equal(
        await resolveTestOpenDirOverride({
          isPackaged: false,
          env: {},
        }),
        null,
        'unset test env var leaves the native dialog path active',
      )

      const existingDir = await mkdtemp(`${selectedDir}-`)
      assert.equal(
        await resolveTestOpenDirOverride({
          isPackaged: false,
          env: { [TEST_OPEN_DIR_ENV]: existingDir },
        }),
        existingDir,
        'dev/test override returns the exact existing directory path',
      )

      await assert.rejects(
        () =>
          resolveTestOpenDirOverride({
            isPackaged: false,
            env: { [TEST_OPEN_DIR_ENV]: join(tempRoot, 'missing') },
          }),
        new RegExp(`${TEST_OPEN_DIR_ENV} must point to an existing directory`),
        'invalid test override fails loudly instead of inventing a path',
      )

      let statCalled = false
      assert.equal(
        await resolveTestOpenDirOverride({
          isPackaged: true,
          env: { [TEST_OPEN_DIR_ENV]: existingDir },
          statPath: async () => {
            statCalled = true
            throw new Error('packaged builds must not inspect the override path')
          },
        }),
        null,
        'packaged builds ignore the test override',
      )
      assert.equal(statCalled, false, 'packaged-build guard is evaluated before filesystem access')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }

    console.log('menu-dialog-ipc.test.ts: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
