// The provenance mapping: a source's declared server becomes a settings entry
// that says which source it came from, so Sync can refresh it and can leave
// everything else alone (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { McpServerConfig } from '../electron-api'
import type { ScannedMcpServer } from '../skills'
import { isOwnedBySource, mcpServerConfigFromScanned, serversUnchangedDuringSync } from './server-from-scanned'
import { normalizeMcpServerConfig, normalizeMcpSourceRef } from './normalize-server'

function scanned(over: Partial<ScannedMcpServer> = {}): ScannedMcpServer {
  return {
    id: 'context7',
    name: 'Context7',
    description: '',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    url: '',
    env: {},
    envVarNames: [],
    headers: {},
    declaredIn: '.mcp.json',
    declaredBy: 'docs',
    ...over,
  }
}

const REF = { sourceId: 'github:acme/plugins', itemId: 'context7', commitSha: 'b81f77a' }

function run(name: string, body: () => void): void {
  body()
  console.log(`ok - ${name}`)
}

run('a server installed from a source records the source, the item and the commit', () => {
  const config = mcpServerConfigFromScanned(scanned(), ['claude-code', 'codex'], REF)
  assert.equal(config.source, 'source')
  assert.deepEqual(config.sourceRef, REF)
  assert.equal(config.riskLevel, 'local-command', 'a stdio server runs a process on this machine')
  assert.deepEqual(config.clients, ['claude-code', 'codex'])
  assert.equal(config.description, 'Declared by the docs plugin.', 'a server with no blurb says who ships it')
})

run('the same mapping with no reference is a custom server, never a source-owned one', () => {
  const config = mcpServerConfigFromScanned(scanned(), ['codex'])
  assert.equal(config.source, 'custom')
  assert.equal(config.sourceRef, undefined)
  // The point of the rule: nothing a sync would act on can be produced by
  // accident. Sync only ever rewrites entries that name a source.
  assert.equal(isOwnedBySource(config, 'github:acme/plugins'), false)
})

run('ownership is by the reference, not by the id', () => {
  const owned = mcpServerConfigFromScanned(scanned(), ['codex'], REF)
  assert.equal(isOwnedBySource(owned, 'github:acme/plugins'), true)
  assert.equal(isOwnedBySource(owned, 'github:other/plugins'), false, 'another source never claims it')
  const typed: McpServerConfig = { ...owned, source: 'custom', sourceRef: undefined }
  assert.equal(isOwnedBySource(typed, 'github:acme/plugins'), false, 'a hand-typed entry of the same id is not owned')
})

run('a remote server is scored by what it reaches, and keeps its url', () => {
  const http = mcpServerConfigFromScanned(
    scanned({ transport: 'http', command: '', url: 'https://mcp.example.com/mcp', envVarNames: ['EXAMPLE_TOKEN'] }),
    ['codex'],
    REF
  )
  assert.equal(http.transport, 'http')
  assert.equal(http.url, 'https://mcp.example.com/mcp')
  assert.equal(http.command, undefined)
  assert.equal(http.riskLevel, 'secrets', 'it wants a token, which is louder than plain network')
})

// ── The round trip ───────────────────────────────────────────────────────────
// Provenance is only useful if it survives being written down and read back;
// the normalizer is where every config the app stores passes through.

run('normalization keeps the reference and the source it implies', () => {
  const config = normalizeMcpServerConfig(mcpServerConfigFromScanned(scanned(), ['codex'], REF))
  assert.ok(config)
  assert.equal(config.source, 'source')
  assert.deepEqual(config.sourceRef, REF)
})

run('a source-owned entry that lost its reference is a hand-maintained one', () => {
  const config = normalizeMcpServerConfig({
    ...mcpServerConfigFromScanned(scanned(), ['codex'], REF),
    sourceRef: { sourceId: '', itemId: '', commitSha: '' },
  })
  assert.ok(config)
  assert.equal(config.source, 'custom', 'so no sync goes hunting for an item id no source names')
  assert.equal(config.sourceRef, undefined)
})

run('a reference survives a folder source, which has no commit to pin', () => {
  assert.deepEqual(normalizeMcpSourceRef({ sourceId: 'local:1', itemId: 'thing', commitSha: '' }), {
    sourceId: 'local:1',
    itemId: 'thing',
    commitSha: '',
  })
  assert.equal(normalizeMcpSourceRef({ sourceId: 'local:1' }), undefined, 'half a reference is no reference')
  assert.equal(normalizeMcpSourceRef(null), undefined)
})

run('the missing mark survives normalization, because the row is drawn from it', () => {
  const config = normalizeMcpServerConfig({
    ...mcpServerConfigFromScanned(scanned(), ['codex'], REF),
    sourceRef: { ...REF, missing: true },
  })
  assert.equal(config?.sourceRef?.missing, true)
})

// ── The write-back race ──────────────────────────────────────────────────────
// A sync sends the settings as they stand, then spends seconds fetching. What
// comes back may no longer be safe to write.

function stored(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return { ...mcpServerConfigFromScanned(scanned(), ['codex'], REF), ...over }
}

run('an entry somebody edited mid-sync keeps their edit', () => {
  const sent = stored()
  const edited = stored({ enabled: false, env: { CONTEXT7_TOKEN: 'typed-while-syncing' } })
  const refreshed = stored({ args: ['-y', '@upstash/context7-mcp@2'] })
  const result = serversUnchangedDuringSync({ sent: [sent], current: [edited], updated: [refreshed] })
  assert.deepEqual(result.write, [], 'the sync does not write over what they just did')
  assert.deepEqual(result.skipped, ['context7'], 'and the surface counts one fewer update rather than claiming it')
})

run('an untouched entry is written', () => {
  const sent = stored()
  const refreshed = stored({ args: ['-y', '@upstash/context7-mcp@2'] })
  const result = serversUnchangedDuringSync({ sent: [sent], current: [stored()], updated: [refreshed] })
  assert.deepEqual(result.write, [refreshed])
  assert.deepEqual(result.skipped, [])
})

run('an entry removed mid-sync is not resurrected', () => {
  const sent = stored()
  const result = serversUnchangedDuringSync({ sent: [sent], current: [], updated: [stored()] })
  assert.deepEqual(result.write, [])
  assert.deepEqual(result.skipped, ['context7'])
})

// ── The twin declarations ────────────────────────────────────────────────────
// `McpServerConfig` is declared twice — in the IPC contract and in the renderer's
// agent-state module, which re-exports it. They are structurally identical on
// purpose, and a provenance field added to one and not the other is a config
// that loses its source somewhere between the two. This guard is cheap; the
// drift it catches is not.

run('the MCP provenance types are identical in both declarations', () => {
  const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')
  const contract = read('src/shared/electron-api.ts')
  const twin = read('src/shared/sprintengine/agent-state.ts')
  for (const source of [contract, twin]) {
    assert.match(source, /export type McpServerSource = 'bundled' \| 'custom' \| 'source'/)
    assert.match(source, /sourceRef\?: McpServerSourceRef/)
  }
  const fields = (source: string): string[] => {
    const block = source.match(/export type McpServerSourceRef = \{([\s\S]*?)\n\}/)
    assert.ok(block, 'both files declare McpServerSourceRef')
    return [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1])
  }
  assert.deepEqual(fields(twin), fields(contract), 'the two McpServerSourceRef declarations have drifted')
})

console.log('mcp server-from-scanned tests passed')
