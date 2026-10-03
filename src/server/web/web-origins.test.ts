import { expect, test } from 'vitest'

import { gateWebRequest, normalizeOrigin, type WebOriginPolicy, type WebRequestFacts } from './web-origins'

const policy: WebOriginPolicy = { port: 4791, publicOrigins: ['https://studio.example.ts.net'] }

const facts = (overrides: Partial<WebRequestFacts>): WebRequestFacts => ({
  method: 'POST',
  host: '127.0.0.1:4791',
  origin: 'http://127.0.0.1:4791',
  upgrade: false,
  ticket: false,
  ...overrides,
})

// The `Origin` and `Host` matrix (phase 9 spec, 8.1): one row per case.
const rows: Array<[string, Partial<WebRequestFacts>, WebOriginPolicy, string | null]> = [
  ['the loopback origin', {}, policy, null],
  ['localhost, as its own origin', { host: 'localhost:4791', origin: 'http://localhost:4791' }, policy, null],
  ['IPv6 loopback', { host: '[::1]:4791', origin: 'http://[::1]:4791' }, policy, null],
  [
    'another port on 127.0.0.1 (same site, other origin)',
    { origin: 'http://127.0.0.1:3000' },
    policy,
    'origin_not_allowed',
  ],
  ['localhost posting to 127.0.0.1', { origin: 'http://localhost:4791' }, policy, null],
  [
    'a rebinding Host',
    { host: 'rebind.example:4791', origin: 'http://rebind.example:4791' },
    policy,
    'host_not_allowed',
  ],
  [
    'a rebinding Host on a GET',
    { method: 'GET', host: 'rebind.example', origin: undefined },
    policy,
    'host_not_allowed',
  ],
  ['no Host at all', { host: undefined }, policy, 'host_not_allowed'],
  ['a POST with no Origin', { origin: undefined }, policy, 'origin_required'],
  [
    'an upgrade with no Origin and no ticket',
    { method: 'GET', upgrade: true, origin: undefined },
    policy,
    'origin_required',
  ],
  [
    'an upgrade with no Origin and a ticket',
    { method: 'GET', upgrade: true, origin: undefined, ticket: true },
    policy,
    null,
  ],
  [
    'an upgrade from another site with a ticket',
    { method: 'GET', upgrade: true, origin: 'https://evil.example', ticket: true },
    policy,
    'origin_not_allowed',
  ],
  ['Origin: null', { origin: 'null' }, policy, 'origin_not_allowed'],
  [
    'the configured public origin',
    { host: 'studio.example.ts.net', origin: 'https://studio.example.ts.net' },
    policy,
    null,
  ],
  [
    'the public name over plain HTTP',
    { host: 'studio.example.ts.net', origin: 'http://studio.example.ts.net' },
    policy,
    'origin_not_allowed',
  ],
  ['a GET with no Origin', { method: 'GET', origin: undefined }, policy, null],
  ['the dev server without --dev', { origin: 'http://127.0.0.1:5173' }, policy, 'origin_not_allowed'],
  [
    'the dev server with --dev',
    { origin: 'http://127.0.0.1:5173' },
    { ...policy, devOrigin: 'http://127.0.0.1:5173' },
    null,
  ],
  [
    'the dev server proxying with its own Host',
    { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
    { ...policy, devOrigin: 'http://127.0.0.1:5173' },
    null,
  ],
]

for (const [name, overrides, rowPolicy, refused] of rows) {
  test(`origin and host: ${name}`, () => {
    const gate = gateWebRequest(facts(overrides), rowPolicy)
    expect(gate.ok ? null : gate.code).toBe(refused)
  })
}

test('an origin is normalized as a browser sends it, and anything else is not one', () => {
  expect(normalizeOrigin('https://studio.example.ts.net:443')).toBe('https://studio.example.ts.net')
  expect(normalizeOrigin('https://studio.example.ts.net/path')).toBeNull()
  expect(normalizeOrigin('file:///Users/dev')).toBeNull()
  expect(normalizeOrigin('https://user:secret@studio.example.ts.net')).toBeNull()
})
