// The provider photo cache behind `SessionUser.photoUrl`. The
// contract: same source → cached bytes without a fetch; stale → refreshed but
// kept on failure; new source → fetched, and null (never the old photo) when
// that fails or the network is off-limits; anything that is not a small https
// image → null.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPhotoCache } from './account-photo-cache'
import { test } from 'vitest'

test('account-photo-cache', async () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`

  type FetchCall = { url: string }

  function fetchStub(handler: (url: string) => Response | Promise<Response>): {
    fetchImpl: typeof fetch
    calls: FetchCall[]
  } {
    const calls: FetchCall[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url })
      return handler(url)
    }) as typeof fetch
    return { fetchImpl, calls }
  }

  // A Node Buffer is not a DOM `BodyInit` to the type checker; hand Response the
  // bytes as a fresh ArrayBuffer.
  function body(bytes: Buffer): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  function image(bytes: Buffer = PNG, contentType = 'image/png'): Response {
    return new Response(body(bytes), { status: 200, headers: { 'content-type': contentType } })
  }

  async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'account-photo-'))
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const SOURCE = 'https://lh3.googleusercontent.com/a/photo=s96-c'
  const quiet = () => {}

  async function main(): Promise<void> {
    // Fetches once, writes the cache, and serves the second call from disk.
    await withDir(async (dir) => {
      const stub = fetchStub(() => image())
      const cachePath = join(dir, 'nested', 'photo.json')
      const cache = new AccountPhotoCache({ cachePath: () => cachePath, fetchImpl: stub.fetchImpl, log: quiet })

      assert.equal(await cache.resolve(SOURCE), PNG_DATA_URL)
      assert.equal(stub.calls.length, 1, 'first resolve fetches')
      assert.equal(await cache.resolve(SOURCE), PNG_DATA_URL)
      assert.equal(stub.calls.length, 1, 'a fresh cache hit does not fetch again')

      const onDisk = JSON.parse(await readFile(cachePath, 'utf8')) as { sourceUrl: string; dataUrl: string }
      assert.equal(onDisk.sourceUrl, SOURCE)
      assert.equal(onDisk.dataUrl, PNG_DATA_URL)

      // A fresh instance (next boot) reads the file: no fetch, no flash.
      const rebooted = new AccountPhotoCache({ cachePath: () => cachePath, fetchImpl: stub.fetchImpl, log: quiet })
      assert.equal(await rebooted.resolve(SOURCE, { allowNetwork: false }), PNG_DATA_URL)
      assert.equal(stub.calls.length, 1, 'the rebooted cache serves from disk')
    })

    // needsFetch: a miss and a stale hit want the network; a fresh hit does not.
    await withDir(async (dir) => {
      let now = Date.parse('2026-09-01T00:00:00.000Z')
      const stub = fetchStub(() => image())
      const cache = new AccountPhotoCache({
        cachePath: () => join(dir, 'photo.json'),
        fetchImpl: stub.fetchImpl,
        now: () => new Date(now),
        maxAgeMs: 1000,
        log: quiet,
      })
      assert.equal(await cache.needsFetch(null), false, 'no source: nothing to fetch')
      assert.equal(await cache.needsFetch(SOURCE), true, 'a miss wants the network')
      await cache.resolve(SOURCE)
      assert.equal(await cache.needsFetch(SOURCE), false, 'a fresh hit does not')
      assert.equal(await cache.needsFetch('https://example.com/other.png'), true, 'another source is a miss')
      now += 5000
      assert.equal(await cache.needsFetch(SOURCE), true, 'a stale hit wants a refresh')
      assert.equal(await cache.resolve(SOURCE, { allowNetwork: false }), PNG_DATA_URL, 'but still serves offline')
    })

    // A null source is no photo, and never a fetch.
    await withDir(async (dir) => {
      const stub = fetchStub(() => image())
      const cache = new AccountPhotoCache({
        cachePath: () => join(dir, 'photo.json'),
        fetchImpl: stub.fetchImpl,
        log: quiet,
      })
      assert.equal(await cache.resolve(null), null)
      assert.equal(stub.calls.length, 0)
    })

    // A changed source is fetched; when that fails the answer is null, never the
    // previous photo — and offline it is null too.
    await withDir(async (dir) => {
      let fail = false
      const stub = fetchStub(() => (fail ? new Response('nope', { status: 404 }) : image()))
      const cache = new AccountPhotoCache({
        cachePath: () => join(dir, 'photo.json'),
        fetchImpl: stub.fetchImpl,
        log: quiet,
      })
      assert.equal(await cache.resolve(SOURCE), PNG_DATA_URL)

      fail = true
      assert.equal(
        await cache.resolve('https://example.com/changed.png'),
        null,
        'a failed fetch of a new photo is no photo',
      )
      assert.equal(
        await cache.resolve('https://example.com/changed.png', { allowNetwork: false }),
        null,
        'offline, a new photo is no photo',
      )
      assert.equal(
        await cache.resolve(SOURCE, { allowNetwork: false }),
        PNG_DATA_URL,
        'the old source still resolves from disk',
      )
    })

    // Stale entries are refreshed; a failed refresh keeps the cached bytes.
    await withDir(async (dir) => {
      let now = Date.parse('2026-09-01T00:00:00.000Z')
      let response: () => Response = () => image()
      const stub = fetchStub(() => response())
      const cache = new AccountPhotoCache({
        cachePath: () => join(dir, 'photo.json'),
        fetchImpl: stub.fetchImpl,
        now: () => new Date(now),
        maxAgeMs: 1000,
        log: quiet,
      })
      assert.equal(await cache.resolve(SOURCE), PNG_DATA_URL)
      now += 5000
      response = () => {
        throw new Error('offline')
      }
      assert.equal(await cache.resolve(SOURCE), PNG_DATA_URL, 'a failed refresh keeps the stale photo')
      assert.equal(stub.calls.length, 2, 'the stale entry was refreshed once')

      const JPEG = Buffer.from([0xff, 0xd8, 0xff])
      response = () => image(JPEG, 'image/jpeg')
      assert.equal(
        await cache.resolve(SOURCE),
        `data:image/jpeg;base64,${JPEG.toString('base64')}`,
        'a successful refresh replaces the bytes',
      )
    })

    // Anything that is not a small https raster image is refused.
    await withDir(async (dir) => {
      let response: () => Response = () => image()
      const stub = fetchStub(() => response())
      const cache = new AccountPhotoCache({
        cachePath: () => join(dir, 'photo.json'),
        fetchImpl: stub.fetchImpl,
        maxBytes: 16,
        log: quiet,
      })
      assert.equal(await cache.resolve('http://example.com/a.png'), null, 'plain http is refused')
      assert.equal(stub.calls.length, 0, 'and never fetched')

      response = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
      assert.equal(await cache.resolve('https://example.com/a.png'), null, 'non-image content is refused')
      response = () => image(Buffer.from('<svg/>'), 'image/svg+xml')
      assert.equal(await cache.resolve('https://example.com/b.png'), null, 'svg is refused')
      response = () => image(Buffer.alloc(17, 1))
      assert.equal(await cache.resolve('https://example.com/c.png'), null, 'oversize bodies are refused')
      response = () => image(Buffer.alloc(0))
      assert.equal(await cache.resolve('https://example.com/d.png'), null, 'empty bodies are refused')
      response = () => {
        const redirected = image()
        Object.defineProperty(redirected, 'url', { value: 'http://cdn.example.com/plain.png' })
        return redirected
      }
      assert.equal(await cache.resolve('https://example.com/f.png'), null, 'a redirect off https is refused')
      response = () =>
        new Response(body(PNG), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '99999' } })
      assert.equal(
        await cache.resolve('https://example.com/e.png'),
        null,
        'a declared oversize body is refused before download',
      )
    })

    // A fetch that never answers is cut off at the timeout.
    await withDir(async (dir) => {
      const fetchImpl = ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as typeof fetch
      const cache = new AccountPhotoCache({
        cachePath: () => join(dir, 'photo.json'),
        fetchImpl,
        timeoutMs: 20,
        log: quiet,
      })
      assert.equal(await cache.resolve(SOURCE), null)
    })

    // Clear removes the file so the next account cannot inherit the photo.
    await withDir(async (dir) => {
      const stub = fetchStub(() => image())
      const cachePath = join(dir, 'photo.json')
      const cache = new AccountPhotoCache({ cachePath: () => cachePath, fetchImpl: stub.fetchImpl, log: quiet })
      assert.equal(await cache.resolve(SOURCE), PNG_DATA_URL)
      await cache.clear()
      assert.equal(await cache.resolve(SOURCE, { allowNetwork: false }), null, 'cleared: nothing offline')
      await assert.rejects(readFile(cachePath), 'the file is gone')
    })

    // A corrupt cache file is treated as empty.
    await withDir(async (dir) => {
      const { writeFile } = await import('node:fs/promises')
      const cachePath = join(dir, 'photo.json')
      await writeFile(cachePath, '{"sourceUrl": 1}', 'utf8')
      const stub = fetchStub(() => image())
      const cache = new AccountPhotoCache({ cachePath: () => cachePath, fetchImpl: stub.fetchImpl, log: quiet })
      assert.equal(await cache.resolve(SOURCE, { allowNetwork: false }), null)
      assert.equal(await cache.resolve(SOURCE), PNG_DATA_URL)
    })

    console.log('account-photo-cache: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
