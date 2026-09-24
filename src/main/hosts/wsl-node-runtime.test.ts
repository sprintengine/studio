// The Linux Node download: fetched on this PC once, checked against its pinned
// SHA-256 before anything uses it, re-checked from the cache, and a named
// error for no network or a wrong checksum.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { ensureWslNodeArchive, wslNodePackage, type WslNodePackage } from './wsl-node-runtime'
import { WslSetupError } from './wsl-setup-error'

let temp = ''
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-wsl-node-'))
})
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const BODY = Buffer.from('pretend this is node-v24-linux-x64.tar.xz')

function pinned(body: Buffer): WslNodePackage {
  return { ...wslNodePackage('x64', 'xz'), sha256: createHash('sha256').update(body).digest('hex') }
}

test('a download matching its pin is kept and reused without asking the network again', async () => {
  const cacheDir = join(temp, 'ok')
  let fetches = 0
  const fetch = async () => {
    fetches += 1
    return new Response(BODY)
  }
  const pkg = pinned(BODY)
  const path = await ensureWslNodeArchive(pkg, { cacheDir, fetch })
  assert.equal(path, join(cacheDir, pkg.fileName))
  assert.equal(await ensureWslNodeArchive(pkg, { cacheDir, fetch }), path)
  assert.equal(fetches, 1)
  // A cached file that no longer matches (a partial write, a disk error) is fetched again.
  writeFileSync(path, 'corrupt')
  await ensureWslNodeArchive(pkg, { cacheDir, fetch })
  assert.equal(fetches, 2)
})

test('a download that does not match is refused and removed', async () => {
  const cacheDir = join(temp, 'bad')
  const pkg = pinned(Buffer.from('the real thing'))
  await assert.rejects(
    ensureWslNodeArchive(pkg, { cacheDir, fetch: async () => new Response(BODY) }),
    (error: unknown) =>
      error instanceof WslSetupError && error.fatal && /did not match its checksum/u.test(error.message),
  )
  assert.deepEqual(existsSync(cacheDir) ? readdirSync(cacheDir) : [], [], 'nothing unverified stays on disk')
})

test('no network is a named, fatal reason', async () => {
  await assert.rejects(
    ensureWslNodeArchive(pinned(BODY), {
      cacheDir: join(temp, 'offline'),
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND nodejs.org') })
      },
    }),
    (error: unknown) =>
      error instanceof WslSetupError &&
      error.code === 'node-download' &&
      /Couldn't set up WSL: no network to download Node\.js .*ENOTFOUND/u.test(error.message),
  )
  await assert.rejects(
    ensureWslNodeArchive(pinned(BODY), {
      cacheDir: join(temp, 'offline'),
      fetch: async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
    }),
    /downloading Node\.js failed \(404 Not Found\)/u,
  )
})

test('a download that stalls is abandoned with a named reason', async () => {
  await assert.rejects(
    ensureWslNodeArchive(pinned(BODY), {
      cacheDir: join(temp, 'stall'),
      stallTimeoutMs: 100,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]))
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
            },
          }),
        ),
    }),
    /Node\.js download was interrupted .*stopped receiving data/u,
  )
})
