import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { TRUSTED_PUBLISHERS_DEV_FILENAME, readTrustedMarketplacePublisherFingerprintsSync } from './trusted-publishers'
import { test } from 'vitest'

test('trusted-publishers', async () => {
  const RELEASE_FP = 'a'.repeat(64)
  const DEV_FP = 'b'.repeat(64)

  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-trusted-publishers-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  function publishersFile(fingerprint: string): string {
    return JSON.stringify({
      schemaVersion: 1,
      publishers: [{ name: 'Multicode Labs', verified: true, publicKey: 'k', fingerprint }],
    })
  }

  function resolverFor(dir: string): (relative: string) => string | null {
    return (relative) => {
      const path = join(dir, relative)
      return existsSync(path) ? path : null
    }
  }

  async function main(): Promise<void> {
    // A source build unions the gitignored dev file, so a contributor's own key
    // can install a publisher-locked first-party module id on their own machine.
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'trusted-publishers.json'), publishersFile(RELEASE_FP))
      await writeFile(join(dir, TRUSTED_PUBLISHERS_DEV_FILENAME), publishersFile(DEV_FP))
      const resolveResourcePath = resolverFor(dir)

      const source = readTrustedMarketplacePublisherFingerprintsSync({ isPackaged: false, resolveResourcePath })
      assert.deepEqual([...source].sort(), [RELEASE_FP, DEV_FP].sort())

      // A packaged build never reads it, whatever happens to be on disk beside it.
      const packaged = readTrustedMarketplacePublisherFingerprintsSync({ isPackaged: true, resolveResourcePath })
      assert.deepEqual([...packaged], [RELEASE_FP])
    })

    // No dev file is the ordinary case, packaged or not: the release publishers
    // stand alone and nothing throws looking for a file that is not there.
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'trusted-publishers.json'), publishersFile(RELEASE_FP))
      assert.deepEqual(
        [
          ...readTrustedMarketplacePublisherFingerprintsSync({
            isPackaged: false,
            resolveResourcePath: resolverFor(dir),
          }),
        ],
        [RELEASE_FP],
      )
    })

    // A malformed dev file is ignored rather than fatal, and never takes the
    // release publishers down with it.
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'trusted-publishers.json'), publishersFile(RELEASE_FP))
      await writeFile(join(dir, TRUSTED_PUBLISHERS_DEV_FILENAME), '{ not json')
      assert.deepEqual(
        [
          ...readTrustedMarketplacePublisherFingerprintsSync({
            isPackaged: false,
            resolveResourcePath: resolverFor(dir),
          }),
        ],
        [RELEASE_FP],
      )
    })

    // The registry verifier must never see the dev file: it opens
    // trusted-publishers.json by name, so a dev key cannot become a publisher CI
    // accepts. Asserted here rather than only in review.
    const verifierPath = resolve(process.cwd(), 'resources/marketplace/verify-marketplace.ts')
    assert.equal(
      readFileSync(verifierPath, 'utf8').includes(TRUSTED_PUBLISHERS_DEV_FILENAME),
      false,
      'verify-marketplace.ts must not read trusted-publishers.dev.json',
    )

    console.log('trusted-publishers guard passed')
  }

  const suiteRun = main()

  await suiteRun
})
