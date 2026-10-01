import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { createTrustTokenStore, TRUST_TOKEN_TTL_MS, trustPinsMatch, type TrustPin } from './trust-tokens'

const PIN: TrustPin = {
  commitSha: 'a'.repeat(40),
  manifestSha256: 'b'.repeat(64),
  componentDigests: { 'mcp/server.json': 'c'.repeat(64) },
}

const ENTRY = {
  id: 'from-github',
  name: 'From GitHub',
  publisher: { name: 'acme', verified: false },
  summary: 'An extension read from a repository.',
  category: 'dev-tools',
  icon: '',
  latest: 1,
  provides: ['module'],
  source: `https://github.com/acme/ext/tree/${'a'.repeat(40)}`,
} as MarketplacePluginEntry

test('a token is spent once, and only for the entry it names', () => {
  const store = createTrustTokenStore()
  const token = store.issue({ entryId: 'plugin-a', source: 'registry', pin: PIN })
  assert.deepEqual(store.peek(token), { entryId: 'plugin-a', source: 'registry' })

  const grant = store.consume(token, 'plugin-a')
  assert.deepEqual(grant, { entryId: 'plugin-a', source: 'registry', pin: PIN, allowUnsignedCode: false })
  assert.equal(store.consume(token, 'plugin-a'), null, 'a second install cannot reuse the approval')
  assert.equal(store.peek(token), null)

  // Presented for another entry: refused, and burned, so it cannot then be
  // replayed for the entry it was issued for.
  const other = store.issue({ entryId: 'plugin-a', source: 'registry', pin: PIN })
  assert.equal(store.consume(other, 'plugin-b'), null)
  assert.equal(store.consume(other, 'plugin-a'), null)

  assert.equal(store.consume('made-up', 'plugin-a'), null)
  assert.equal(store.consume('', 'plugin-a'), null)
})

test('a token expires ten minutes after the prompt', () => {
  let now = 1_000
  const store = createTrustTokenStore({ now: () => now })
  const token = store.issue({ entryId: 'plugin-a', source: 'registry', pin: PIN })
  now += TRUST_TOKEN_TTL_MS - 1
  assert.ok(store.peek(token))
  now += 1
  assert.equal(store.peek(token), null)
  assert.equal(store.consume(token, 'plugin-a'), null)
})

test('unsigned code is allowed only for a GitHub entry that asked for it', () => {
  const store = createTrustTokenStore()
  const registry = store.issue({ entryId: 'plugin-a', source: 'registry', pin: PIN, allowUnsignedCode: true })
  assert.equal(store.consume(registry, 'plugin-a')?.allowUnsignedCode, false)

  const github = store.issue({
    entryId: ENTRY.id,
    source: 'github',
    pin: PIN,
    allowUnsignedCode: true,
    entry: ENTRY,
  })
  const grant = store.consume(github, ENTRY.id)
  assert.equal(grant?.allowUnsignedCode, true)
  // The synthesised entry rides in the grant; it is in no registry.
  assert.deepEqual(grant?.entry, ENTRY)

  const unasked = store.issue({ entryId: ENTRY.id, source: 'github', pin: PIN })
  assert.equal(store.consume(unasked, ENTRY.id)?.allowUnsignedCode, false)
})

test('the issued pin cannot be changed by the caller afterwards', () => {
  const store = createTrustTokenStore()
  const pin: TrustPin = { manifestSha256: 'b'.repeat(64), componentDigests: { a: '1' } }
  const token = store.issue({ entryId: 'plugin-a', source: 'registry', pin })
  pin.componentDigests.a = '2'
  assert.equal(store.consume(token, 'plugin-a')?.pin.componentDigests.a, '1')
})

test('pins match on content, not on where it was fetched from', () => {
  assert.equal(trustPinsMatch(PIN, { ...PIN, commitSha: undefined }), true)
  assert.equal(trustPinsMatch(PIN, { ...PIN, manifestSha256: 'd'.repeat(64) }), false)
  assert.equal(trustPinsMatch(PIN, { ...PIN, componentDigests: { 'mcp/server.json': 'e'.repeat(64) } }), false)
  assert.equal(
    trustPinsMatch(PIN, { ...PIN, componentDigests: { ...PIN.componentDigests, 'mcp/extra.json': 'f' } }),
    false,
    'a file the prompt never listed',
  )
  assert.equal(trustPinsMatch(PIN, { ...PIN, componentDigests: {} }), false)
})
