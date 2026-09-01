import assert from 'node:assert/strict'

import type {
  CapabilityManifest,
  ModuleTrustStatus,
  ThirdPartyModuleListResult,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import type { WorkspaceSkill } from '../../../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../../../shared/plugin-manifest'
import type { McpServerConfig } from '../../types/workspace'
import {
  deriveInstalledExtensions,
  mcpToInstalled,
  modulesToInstalled,
  skillsToInstalled,
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

function skill(overrides: Partial<WorkspaceSkill> = {}): WorkspaceSkill {
  return {
    id: 'frontend-design',
    name: 'Frontend Design',
    source: 'custom',
    harnesses: ['claude'],
    installState: 'installed',
    ...overrides,
  }
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
    skills: { status: 'ok', value: [] },
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
  // The kind label is the chip, as on Browse rows. Transport and provenance are
  // plumbing, not decisions: neither is chipped (the record keeps `source` for
  // the icon lookup).
  assert.deepEqual(rows[0].chips, ['MCP server'], 'transport stays off the row face')
  assert.deepEqual(rows[1].chips, ['MCP server'], 'provenance carries no chip')
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

{
  // The inventory answers "what do I have": a bundled skill that is only
  // available must not be listed as installed, and an update is stated.
  const rows = skillsToInstalled([
    skill(),
    skill({ id: 'tdd', name: 'TDD', source: 'builtin', installState: 'available' }),
    skill({ id: 'debug', name: 'Debug', source: 'builtin', installState: 'update-available' }),
  ])
  assert.deepEqual(rows.map((row) => row.id), ['frontend-design', 'debug'])
  assert.equal(rows[0].kind, 'skill')
  assert.equal(rows[0].key, 'skill:frontend-design')
  assert.deepEqual(rows[0].chips, ['Skill'], 'provenance carries no chip')
  assert.deepEqual(rows[1].chips, ['Skill', 'Update available'], 'the second chip is a state the user can act on')
}

// --- populated state -------------------------------------------------------

{
  const view = deriveInstalledExtensions(
    input({
      mcpServers: [mcp()],
      skills: { status: 'ok', value: [skill()] },
      clis: { status: 'ok', value: [cli()] },
      modules: { status: 'ok', value: modulesResult([moduleView('trusted')]) },
    }),
  )
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.equal(view.total, 4)
  // Group order: mcp, skill, cli, module.
  assert.deepEqual(view.groups.map((g) => g.kind), ['mcp', 'skill', 'cli', 'module'])
  assert.equal(view.notices.length, 0)
}

// --- empty state (only a clean, fully-loaded zero-row result) --------------

{
  // All three IPC sources ok with zero rows, no MCP servers, nothing rejected.
  const view = deriveInstalledExtensions(input())
  assert.equal(view.status, 'empty')
}

{
  // Zero rows but skills were unavailable (no workspace): NOT empty — a
  // degraded state, so "Nothing installed yet" never renders under a notice.
  const view = deriveInstalledExtensions(
    input({
      skills: { status: 'unavailable', reason: 'Open a workspace to see the skills installed in it.' },
    }),
  )
  assert.equal(view.status, 'degraded')
  if (view.status !== 'degraded') throw new Error('unreachable')
  assert.deepEqual(view.notices.map((n) => `${n.kind}:${n.tone}`), ['skill:warn'])
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
      skills: { status: 'unavailable', reason: 'Open a workspace to see the skills installed in it.' },
      clis: { status: 'error', message: 'plugin registry unreadable' },
      modules: { status: 'unsupported' },
    }),
  )
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.equal(view.groups.length, 1, 'only MCP has items')
  const tones = view.notices.map((n) => `${n.kind}:${n.tone}`)
  assert.ok(tones.includes('skill:warn'))
  assert.ok(tones.includes('cli:error'))
  assert.ok(tones.includes('module:warn'))
}

{
  // Everything failed and no MCP servers: a degraded state (never a silent
  // blank or a misleading "nothing installed"), carrying every error notice.
  const view = deriveInstalledExtensions(
    input({
      skills: { status: 'error', message: 'boom' },
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
      skills: { status: 'unsupported' },
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
      skills: { status: 'unsupported' },
      clis: { status: 'unsupported' },
    }),
  )
  assert.equal(view.status, 'ready')
}

console.log('extensionsInstalled.test.ts passed')
