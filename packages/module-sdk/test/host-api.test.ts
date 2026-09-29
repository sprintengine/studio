import assert from 'node:assert/strict'
import { test } from 'vitest'

import { HOST_API_MIN_SUPPORTED, HOST_API_VERSION, checkHostApiCompatibility } from '../src/host-api.js'
import type { CapabilityManifest } from '../src/index.js'

type Manifest = Pick<CapabilityManifest, 'engines' | 'source'>

function codeOf(manifest: Manifest): string {
  const result = checkHostApiCompatibility(manifest)
  return result.ok ? 'ok' : result.code
}

test('a third-party module built for this host API loads', () => {
  assert.deepEqual(checkHostApiCompatibility({ source: 'third-party', engines: { hostApi: HOST_API_VERSION } }), {
    ok: true,
  })
  assert.equal(codeOf({ source: 'third-party', engines: { hostApi: HOST_API_MIN_SUPPORTED } }), 'ok')
})

test('a third-party module that names no host API is refused, and told what to add', () => {
  const result = checkHostApiCompatibility({ source: 'third-party' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'host_api_missing')
  assert.match(result.message, /"engines": \{ "hostApi": 1 \}/)
})

test('a bundled module needs no engines field: it ships with the host it runs on', () => {
  assert.equal(codeOf({}), 'ok')
  assert.equal(codeOf({ source: 'bundled' }), 'ok')
})

test('a host API newer than this host provides is refused as too new', () => {
  assert.equal(codeOf({ source: 'third-party', engines: { hostApi: HOST_API_VERSION + 1 } }), 'host_api_too_new')
  // A declared version is checked on a bundled manifest too.
  assert.equal(codeOf({ source: 'bundled', engines: { hostApi: HOST_API_VERSION + 1 } }), 'host_api_too_new')
})

test('a host API older than the supported floor is refused as too old', () => {
  assert.equal(codeOf({ source: 'third-party', engines: { hostApi: HOST_API_MIN_SUPPORTED - 1 } }), 'host_api_too_old')
})

test('a hostApi that is not a whole number is no version at all', () => {
  for (const hostApi of [1.5, Number.NaN, '1' as unknown as number]) {
    assert.equal(codeOf({ source: 'third-party', engines: { hostApi } }), 'host_api_missing', String(hostApi))
  }
})
