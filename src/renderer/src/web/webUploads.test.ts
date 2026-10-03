// @vitest-environment jsdom
import { expect, test } from 'vitest'

import { uploadFilesToServer } from './webUploads'

test('each file is posted on its own, and the paths come back in order', async () => {
  const seen: string[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    const name = new URL(url).searchParams.get('name')
    seen.push(`${init.method} ${new URL(url).pathname} ${name}`)
    return new Response(JSON.stringify({ ok: true, path: `/srv/uploads/${name}` }), { status: 200 })
  }) as unknown as typeof fetch
  const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.pdf')]
  expect(await uploadFilesToServer(files, fetcher)).toEqual(['/srv/uploads/a.txt', '/srv/uploads/b.pdf'])
  expect(seen).toEqual(['POST /api/upload a.txt', 'POST /api/upload b.pdf'])
})

test("a refusal comes back as the server's words", async () => {
  const fetcher = (async () =>
    new Response(JSON.stringify({ ok: false, message: 'That file is over 50 MB, too large to upload.' }), {
      status: 413,
    })) as unknown as typeof fetch
  await expect(uploadFilesToServer([new File(['x'], 'x.bin')], fetcher)).rejects.toThrow(/over 50 MB/u)
  const offline = (async () => {
    throw new TypeError('Failed to fetch')
  }) as unknown as typeof fetch
  await expect(uploadFilesToServer([new File(['x'], 'x.bin')], offline)).rejects.toThrow(/did not answer/u)
})
