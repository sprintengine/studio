import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createModuleSecretsRegistry, deleteModuleSecrets } from './module-secrets'
import type { SecretCipher } from '../../server/platform/secret-cipher'
import type { BrokerFetch } from './broker-http'

const SECRET = 'sk-live-5ecret-value-123'

// A stand-in for the secret cipher whose output never contains the plaintext, so a
// test can tell "sealed" from "written as is".
function fakeCipher(available = true): SecretCipher {
  return {
    available: () => available,
    seal: (value) => Buffer.from(`sealed:${Buffer.from(value, 'utf8').toString('base64')}`),
    open: (value) => {
      const text = value.toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('not sealed by this cipher')
      return Buffer.from(text.slice('sealed:'.length), 'base64').toString('utf8')
    },
  }
}

type Call = { url: string; init: RequestInit }

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function harness(
  options: {
    permissions?: Record<string, string[]>
    respond?: (call: Call) => Response | Promise<Response>
    cipher?: SecretCipher | null
  } = {},
) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'module-secrets-'))
  dirs.push(userDataDir)
  const calls: Call[] = []
  const fetchImpl: BrokerFetch = async (url, init) => {
    calls.push({ url, init })
    return options.respond ? options.respond({ url, init }) : new Response('{"ok":true}', { status: 200 })
  }
  const secrets = createModuleSecretsRegistry({
    userDataDir,
    cipher: options.cipher === undefined ? fakeCipher() : options.cipher,
    getModulePermissions: (id) => (options.permissions ?? { weather: ['secrets'], other: ['secrets'] })[id],
    fetch: fetchImpl,
  })
  return { userDataDir, calls, secrets }
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string>
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

test('a stored secret is sealed on disk and never handed back', async () => {
  const { userDataDir, secrets } = await harness()
  const weather = secrets.forModule('weather')
  assert.deepEqual(await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] }), { ok: true })
  assert.equal(await weather.has('api-key'), true)
  assert.equal(await weather.has('other-key'), false)

  const files = await readdir(join(userDataDir, 'module-secrets'))
  assert.deepEqual(files, ['weather.bin'])
  const onDisk = await readFile(join(userDataDir, 'module-secrets', 'weather.bin'), 'utf8')
  assert.equal(onDisk.includes(SECRET), false)
  assert.equal(onDisk.includes('api.example.com'), false, 'the allow-list is sealed with the value')
})

test('secrets are per module: another module neither sees nor uses them', async () => {
  const { secrets, calls } = await harness()
  await secrets.forModule('weather').set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const other = secrets.forModule('other')
  assert.equal(await other.has('api-key'), false)
  const result = await other.fetchWithSecret('api-key', 'https://api.example.com/v1', {
    placement: { header: 'X-Key' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'not_set')
  assert.equal(calls.length, 0)
})

test('the registry token shape takes the module id first', async () => {
  const { secrets } = await harness()
  await secrets.registry.set('weather', 'api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  assert.equal(await secrets.registry.has('weather', 'api-key'), true)
  assert.equal(await secrets.registry.has('other', 'api-key'), false)
})

test('every call needs the secrets permission', async () => {
  const { secrets } = await harness({ permissions: { weather: ['storage'] } })
  const weather = secrets.forModule('weather')
  const set = await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  assert.equal(set.ok === false && set.code, 'permission_missing')
  await assert.rejects(weather.has('api-key'), /"secrets" permission/)
  const removed = await weather.delete('api-key')
  assert.equal(removed.ok === false && removed.code, 'permission_missing')
  const fetched = await weather.fetchWithSecret('api-key', 'https://api.example.com', { placement: { query: 'key' } })
  assert.equal(fetched.ok === false && fetched.code, 'permission_missing')
})

test('names and origins are validated when the secret is set', async () => {
  const { secrets } = await harness()
  const weather = secrets.forModule('weather')
  for (const name of ['', '../escape', 'a/b', 'x'.repeat(65), '.hidden']) {
    const result = await weather.set(name, SECRET, { allowedOrigins: ['https://api.example.com'] })
    assert.equal(result.ok === false && result.code, 'invalid_name', name)
  }
  for (const origins of [
    [],
    ['http://api.example.com'],
    ['https://api.example.com/v1'],
    ['https://user:pw@api.example.com'],
    ['*.example.com'],
    ['https://api.example.com?x=1'],
  ]) {
    const result = await weather.set('api-key', SECRET, { allowedOrigins: origins })
    assert.equal(result.ok === false && result.code, 'origin_not_allowed', JSON.stringify(origins))
    assert.equal(result.ok === false && result.message.includes(SECRET), false)
  }
  await assert.rejects(
    weather.set('api-key', 'line\nbreak', { allowedOrigins: ['https://api.example.com'] }),
    TypeError,
  )
  await assert.rejects(weather.set('api-key', '   ', { allowedOrigins: ['https://api.example.com'] }), TypeError)
})

test('without encryption nothing is stored', async () => {
  const { userDataDir, secrets } = await harness({ cipher: fakeCipher(false) })
  const result = await secrets
    .forModule('weather')
    .set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  assert.equal(result.ok === false && result.code, 'storage_unavailable')
  await assert.rejects(readdir(join(userDataDir, 'module-secrets')))

  const none = await harness({ cipher: null })
  const refused = await none.secrets
    .forModule('weather')
    .set('k', SECRET, { allowedOrigins: ['https://a.example.com'] })
  assert.equal(refused.ok === false && refused.code, 'storage_unavailable')
})

test('the secret goes in the named header, over the module header of the same name', async () => {
  const { secrets, calls } = await harness()
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const result = await weather.fetchWithSecret('api-key', 'https://api.example.com/v1/forecast?city=paris', {
    method: 'post',
    headers: { authorization: 'Bearer module-guess', 'Content-Type': 'application/json' },
    body: '{"days":3}',
    placement: { header: 'Authorization', scheme: 'Bearer' },
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.url, 'https://api.example.com/v1/forecast?city=paris')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.redirect, 'error')
  assert.equal(call.init.body, '{"days":3}')
  assert.equal(headerOf(call.init, 'authorization'), `Bearer ${SECRET}`)
  assert.equal(Object.keys(call.init.headers as object).filter((k) => k.toLowerCase() === 'authorization').length, 1)
})

test('the secret can ride a query parameter instead', async () => {
  const { secrets, calls } = await harness()
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  await weather.fetchWithSecret('api-key', 'https://api.example.com/v1?appid=guess&q=1', {
    placement: { query: 'appid' },
  })
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get('appid'), SECRET)
  assert.deepEqual(url.searchParams.getAll('appid'), [SECRET])
  assert.equal(url.searchParams.get('q'), '1')
})

test('a secret goes only to an origin it was stored for, and only over https', async () => {
  const { secrets, calls } = await harness()
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  for (const url of [
    'https://evil.example.net/steal',
    'https://api.example.com.evil.net/',
    'https://sub.api.example.com/',
    'https://api.example.com:8443/',
    'http://api.example.com/',
    'https://user:pw@api.example.com/',
    'not a url',
  ]) {
    const result = await weather.fetchWithSecret('api-key', url, { placement: { header: 'X-Key' } })
    assert.equal(result.ok === false && result.code, 'origin_not_allowed', url)
    assert.equal(result.ok === false && result.message.includes(SECRET), false)
  }
  assert.equal(calls.length, 0)
})

test('a redirect is refused, not followed', async () => {
  const { secrets, calls } = await harness({
    respond: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/' } }),
  })
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const result = await weather.fetchWithSecret('api-key', 'https://api.example.com/', {
    placement: { header: 'X-Key' },
  })
  assert.equal(result.ok === false && result.code, 'network_error')
  assert.match(result.ok === false ? result.message : '', /redirect/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.redirect, 'error')
})

test('a fetch failure says so without quoting the error, which may hold the secret', async () => {
  const { secrets } = await harness({
    respond: () => {
      throw new TypeError(`Headers.append: "${SECRET}" is an invalid header value.`)
    },
  })
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const result = await weather.fetchWithSecret('api-key', 'https://api.example.com/', {
    placement: { header: 'X-Key' },
  })
  assert.equal(result.ok === false && result.code, 'network_error')
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test('an answer over 1 MiB is not read', async () => {
  const big = 'x'.repeat(1024 * 1024 + 1)
  const { secrets } = await harness({ respond: () => new Response(big, { status: 200 }) })
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const result = await weather.fetchWithSecret('api-key', 'https://api.example.com/', {
    placement: { header: 'X-Key' },
  })
  assert.equal(result.ok === false && result.code, 'network_error')
  assert.match(result.ok === false ? result.message : '', /1 MiB/)

  const streamed = await harness({
    respond: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 20; i += 1) controller.enqueue(new Uint8Array(64 * 1024))
            controller.close()
          },
        }),
        { status: 200 },
      ),
  })
  const streamedWeather = streamed.secrets.forModule('weather')
  await streamedWeather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const capped = await streamedWeather.fetchWithSecret('api-key', 'https://api.example.com/', {
    placement: { header: 'X-Key' },
  })
  assert.equal(capped.ok === false && capped.code, 'network_error')
})

test('a request that runs past its deadline is abandoned', async () => {
  const { secrets } = await harness({
    respond: ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  })
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const result = await weather.fetchWithSecret('api-key', 'https://api.example.com/', {
    placement: { header: 'X-Key' },
    timeoutMs: 20,
  })
  assert.equal(result.ok === false && result.code, 'network_error')
  assert.match(result.ok === false ? result.message : '', /timed out/)
})

test('an echoing server cannot hand the secret back', async () => {
  const { secrets } = await harness({
    respond: ({ url, init }) =>
      new Response(JSON.stringify({ url, key: headerOf(init, 'x-key') }), {
        status: 200,
        headers: { 'x-echo': SECRET, 'set-cookie': 'session=abc', 'content-type': 'application/json' },
      }),
  })
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const byHeader = await weather.fetchWithSecret('api-key', 'https://api.example.com/', {
    placement: { header: 'X-Key' },
  })
  assert.equal(byHeader.ok, true)
  assert.equal(JSON.stringify(byHeader).includes(SECRET), false)
  assert.equal(byHeader.ok && byHeader.headers['content-type'], 'application/json')
  assert.equal(byHeader.ok && 'set-cookie' in byHeader.headers, false)

  const tricky = 'k+y/with=chars&more'
  await weather.set('tricky', tricky, { allowedOrigins: ['https://api.example.com'] })
  const byQuery = await weather.fetchWithSecret('tricky', 'https://api.example.com/', { placement: { query: 'key' } })
  assert.equal(byQuery.ok, true)
  const text = JSON.stringify(byQuery)
  assert.equal(text.includes(tricky) || text.includes(encodeURIComponent(tricky)), false)

  // A query placement goes out form-encoded: a space as `+`, `~!'()` escaped.
  const spaced = "it's a key (v2)~!"
  await weather.set('spaced', spaced, { allowedOrigins: ['https://api.example.com'] })
  const bySpaced = await weather.fetchWithSecret('spaced', 'https://api.example.com/', { placement: { query: 'key' } })
  assert.equal(bySpaced.ok, true)
  const echoed = JSON.stringify(bySpaced)
  assert.equal(echoed.includes(new URLSearchParams([['', spaced]]).toString().slice(1)), false)
  assert.equal(echoed.includes(encodeURIComponent(spaced)), false)
})

test('a name an object inherits is not a stored secret', async () => {
  const { secrets, calls } = await harness()
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  for (const name of ['constructor', 'toString', 'valueOf']) {
    const fetched = await weather.fetchWithSecret(name, 'https://api.example.com/', { placement: { query: 'k' } })
    assert.equal(fetched.ok === false && fetched.code, 'not_set')
  }
  assert.equal(calls.length, 0)
})

test('a malformed request shape is refused before anything is sent', async () => {
  const { secrets, calls } = await harness()
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  const url = 'https://api.example.com/'
  await assert.rejects(weather.fetchWithSecret('api-key', url, { placement: { header: 'Bad Header' } }), TypeError)
  await assert.rejects(
    weather.fetchWithSecret('api-key', url, { method: 'TRACE', placement: { query: 'k' } }),
    TypeError,
  )
  await assert.rejects(
    weather.fetchWithSecret('api-key', url, { headers: { 'X-A': 'a\r\nX-B: b' }, placement: { query: 'k' } }),
    TypeError,
  )
  await assert.rejects(weather.fetchWithSecret('api-key', url, { body: 'x', placement: { query: 'k' } }), TypeError)
  await assert.rejects(weather.fetchWithSecret('api-key', url, {} as never), TypeError)
  assert.equal(calls.length, 0)
})

test('delete forgets one name; deleteModuleSecrets forgets the module', async () => {
  const { userDataDir, secrets } = await harness()
  const weather = secrets.forModule('weather')
  await weather.set('a', SECRET, { allowedOrigins: ['https://api.example.com'] })
  await weather.set('b', SECRET, { allowedOrigins: ['https://api.example.com'] })
  assert.deepEqual(await weather.delete('a'), { ok: true })
  assert.deepEqual(await weather.delete('a'), { ok: true })
  assert.equal(await weather.has('a'), false)
  assert.equal(await weather.has('b'), true)
  await deleteModuleSecrets(userDataDir, 'weather')
  assert.equal(await weather.has('b'), false)
})

test('concurrent sets on one module all land', async () => {
  const { secrets } = await harness()
  const weather = secrets.forModule('weather')
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      weather.set(`k${i}`, `${SECRET}-${i}`, { allowedOrigins: ['https://a.example.com'] }),
    ),
  )
  for (let i = 0; i < 8; i += 1) assert.equal(await weather.has(`k${i}`), true)
})

test('a record sealed elsewhere reads as nothing stored', async () => {
  const { userDataDir, secrets } = await harness()
  const weather = secrets.forModule('weather')
  await weather.set('api-key', SECRET, { allowedOrigins: ['https://api.example.com'] })
  await writeFile(join(userDataDir, 'module-secrets', 'weather.bin'), 'garbage')
  assert.equal(await weather.has('api-key'), false)
  const result = await weather.fetchWithSecret('api-key', 'https://api.example.com/', {
    placement: { header: 'X-Key' },
  })
  assert.equal(result.ok === false && result.code, 'not_set')
})
