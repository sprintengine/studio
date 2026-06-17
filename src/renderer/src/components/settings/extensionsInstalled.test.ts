import assert from 'node:assert/strict'

import type {
  CapabilityManifest,
  ModuleTrustStatus,
  ThirdPartyModuleListResult,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import type { SkillPackEntry } from '../../../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../../../shared/plugin-manifest'
import type { McpServerConfig } from '../../types/workspace'
import {
  deriveInstalledExtensions,
  mcpToInstalled,
  modulesToInstalled,
  type ExtensionsInstalledInput,
  type LoadedSource,
} from './extensionsInstalled'

// The Installed inventory is the single canonical surface across four
// primitives, so the mapping must read real state (trust, enablement,
// provenance) faithfully, and a missing/unavailable/failing source must surface
// as an explicit notice — never as an empty list.

function mcp(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'context7',
    name: 'Context7',
    transport: 'stdio',
    enabled: true,
    clients: ['claude-code'],
    scope: 'workspace',
    source: 'bundled',
    riskLevel: 'low',
    ...overrides,
  } as McpServerConfig
}

function moduleView(
  trust: ModuleTrustStatus,
  manifest: Partial<CapabilityManifest> = {},
): ThirdPartyModuleView {
  return {
    manifest: {
      id: 'demo-module',
      displayName: 'Demo Module',
      version: 1,
      defaultEnabled: true,
      source: 'third-party',
      ...manifest,
    } as CapabilityManifest,
    trust,
    launch: { status: 'trusted_executable', hasMainEntry: true, expectedToLoad: true },
  }
}

function modulesResult(modules: ThirdPartyModuleView[], rejected: ThirdPartyModuleListResult['rejected'] = []): ThirdPartyModuleListResult {
  return { modules, rejected }
}

function skillPack(overrides: Partial<SkillPackEntry> = {}): SkillPackEntry {
  return {
    id: 'pack-1',
    slug: 'frontend-pack',
    name: 'Frontend Pack',
    harnesses: ['claude-code'],
    source: 'bundled',
    ...overrides,
  } as SkillPackEntry
}

function cli(overrides: Partial<PluginRegistryListEntry> = {}): PluginRegistryListEntry {
  return {
    id: 'codex',
    displayName: 'Codex',
    source: 'user',
    version: 2,
    binary: 'codex',
    ...overrides,
  } as PluginRegistryListEntry
}

function input(overrides: Partial<ExtensionsInstalledInput> = {}): ExtensionsInstalledInput {
  return {
    mcpServers: [],
    modules: { status: 'ok', value: modulesResult([]) },
    moduleOverrides: {},
    skillPacks: { status: 'ok', value: [] },
    clis: { status: 'ok', value: [] },
    ...overrides,
  }
}

// --- mapping ---------------------------------------------------------------

{
  const rows = mcpToInstalled([mcp({ enabled: true }), mcp({ id: 'brave', name: 'Brave', enabled: false, source: 'custom' })])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'mcp')
  assert.equal(rows[0].source, 'Bundled')
  assert.equal(rows[0].enabled, true)
  assert.equal(rows[1].source, 'Custom')
  assert.equal(rows[1].enabled, false)
  assert.ok(rows[0].detail?.includes('stdio'), 'mcp detail names the transport')
  assert.equal(rows[0].key, 'mcp:context7')
}

{
  // Trusted+enabled, trusted+disabled (override), and trust-blocked all map honestly.
  const rows = modulesToInstalled(
    modulesResult([
      moduleView('trusted', { id: 'a', displayName: 'A', defaultEnabled: true }),
      moduleView('trusted', { id: 'b', displayName: 'B', defaultEnabled: true }),
      moduleView('unsigned', { id: 'c', displayName: 'C', defaultEnabled: true }),
    ]),
    { b: false },
  )
  assert.deepEqual(
    rows.map((r) => [r.id, r.trust, r.enabled]),
    [
      ['a', 'trusted', true],
      ['b', 'trusted', false],
      // Trust-blocked module never loads regardless of defaultEnabled.
      ['c', 'unsigned', false],
    ],
  )
  assert.equal(rows[0].source, 'Custom')
}

// --- populated state -------------------------------------------------------

{
  const view = deriveInstalledExtensions(
    input({
      mcpServers: [mcp()],
      skillPacks: { status: 'ok', value: [skillPack()] },
      clis: { status: 'ok', value: [cli()] },
      modules: { status: 'ok', value: modulesResult([moduleView('trusted')]) },
    }),
  )
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.equal(view.total, 4)
  // Group order: mcp, skill-pack, cli, module.
  assert.deepEqual(view.groups.map((g) => g.kind), ['mcp', 'skill-pack', 'cli', 'module'])
  assert.equal(view.notices.length, 0)
}

// --- empty state (only a clean, fully-loaded zero-row result) --------------

{
  // All three IPC sources ok with zero rows, no MCP servers, nothing rejected.
  const view = deriveInstalledExtensions(input())
  assert.equal(view.status, 'empty')
}

{
  // Zero rows but skill packs were unavailable (no workspace): NOT empty — a
  // degraded state, so "Nothing installed yet" never renders under a notice.
  const view = deriveInstalledExtensions(
    input({
      skillPacks: { status: 'unavailable', reason: 'Open a workspace to see its installed skill packs.' },
    }),
  )
  assert.equal(view.status, 'degraded')
  if (view.status !== 'degraded') throw new Error('unreachable')
  assert.deepEqual(view.notices.map((n) => `${n.kind}:${n.tone}`), ['skill-pack:warn'])
}

{
  // Zero rows but a module folder was rejected: degraded, not empty.
  const view = deriveInstalledExtensions(
    input({
      modules: {
        status: 'ok',
        value: modulesResult([], [{ path: 'mods/bad', issues: [{ path: '.', message: 'bad manifest' }] }]),
      },
    }),
  )
  assert.equal(view.status, 'degraded')
}

// --- failed / unavailable sources surface as notices, never empty ----------

{
  // One source errored, one unavailable, one unsupported, but MCP has an item:
  // the list still renders AND every degraded source is announced.
  const view = deriveInstalledExtensions(
    input({
      mcpServers: [mcp()],
      skillPacks: { status: 'unavailable', reason: 'Open a workspace to see its installed skill packs.' },
      clis: { status: 'error', message: 'plugin registry unreadable' },
      modules: { status: 'unsupported' },
    }),
  )
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.equal(view.groups.length, 1, 'only MCP has items')
  const tones = view.notices.map((n) => `${n.kind}:${n.tone}`)
  assert.ok(tones.includes('skill-pack:warn'))
  assert.ok(tones.includes('cli:error'))
  assert.ok(tones.includes('module:warn'))
}

{
  // Everything failed and no MCP servers: a degraded state (never a silent
  // blank or a misleading "nothing installed"), carrying every error notice.
  const view = deriveInstalledExtensions(
    input({
      skillPacks: { status: 'error', message: 'boom' },
      clis: { status: 'error', message: 'boom' },
      modules: { status: 'error', message: 'boom' },
    }),
  )
  assert.equal(view.status, 'degraded')
  if (view.status !== 'degraded') throw new Error('unreachable')
  assert.equal(view.notices.filter((n) => n.tone === 'error').length, 3)
}

// --- rejected module folders are an honest "could not load" notice ---------

{
  const view = deriveInstalledExtensions(
    input({
      mcpServers: [mcp()],
      modules: {
        status: 'ok',
        value: modulesResult([moduleView('trusted')], [{ path: 'mods/bad', issues: [{ path: '.', message: 'bad manifest' }] }]),
      },
    }),
  )
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.ok(view.notices.some((n) => n.kind === 'module' && /could not be loaded/.test(n.message)))
}

// --- loading + unsupported gating ------------------------------------------

{
  const loading: LoadedSource<never> = { status: 'loading' }
  const view = deriveInstalledExtensions(input({ clis: loading }))
  assert.equal(view.status, 'loading')
}

{
  // Old build: every IPC source predates the API and no MCP servers exist.
  const view = deriveInstalledExtensions(
    input({
      modules: { status: 'unsupported' },
      skillPacks: { status: 'unsupported' },
      clis: { status: 'unsupported' },
    }),
  )
  assert.equal(view.status, 'unsupported')
}

{
  // Same unsupported sources but MCP servers exist (store-backed): not the
  // "unsupported build" state — render what we have.
  const view = deriveInstalledExtensions(
    input({
      mcpServers: [mcp()],
      modules: { status: 'unsupported' },
      skillPacks: { status: 'unsupported' },
      clis: { status: 'unsupported' },
    }),
  )
  assert.equal(view.status, 'ready')
}

console.log('extensionsInstalled.test.ts passed')
