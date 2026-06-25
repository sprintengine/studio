import assert from 'node:assert/strict'

import {
  buildAgentCliCatalog,
  buildCliRuntimeOptions,
  cliRuntimeForPlugin,
  filterCatalogByAvailability,
  isAgentCliAvailable,
  isAgentCliMissing,
  orderInstalledPlugins,
  pluginRegistryIdForCli,
  resolveAvailableAgentCli,
  resolveCliModel,
  resolveTemplateAgentCli,
  selectAgentCliCatalog,
} from './cliRuntimeOptions'
import type { AgentCliAvailabilityMap, PluginCatalogEntry } from '../../../types/workspace'

function availabilityMap(map: Record<string, boolean>): AgentCliAvailabilityMap {
  const out: AgentCliAvailabilityMap = {}
  for (const [cli, installed] of Object.entries(map)) {
    out[cli] = { cli, installed, resolvedPath: installed ? `/bin/${cli}` : null, version: installed ? '1' : null }
  }
  return out
}

const plugins: PluginCatalogEntry[] = [
  { id: 'opencode', displayName: 'OpenCode', source: 'user', version: 1, binary: 'opencode' },
  { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' },
  { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' },
  { id: 'codex', displayName: 'Codex Duplicate', source: 'user', version: 2, binary: 'codex-next' },
]

assert.deepEqual(
  buildAgentCliCatalog(plugins).map(({ value, label, source }) => ({ value, label, source })),
  [
    { value: 'codex', label: 'Codex', source: 'bundled' },
    { value: 'claude-code', label: 'Claude Code', source: 'bundled' },
    { value: 'opencode', label: 'OpenCode', source: 'user' },
  ],
  'catalog orders bundled before user entries, labels from displayName, and dedupes ids',
)
// Bundled CLIs ship NO seeded model ids (no speculative entitlement guesses):
// the fallback catalog exposes model UI via allowCustomId with an empty options
// list, so the bare CLI row is the only default and users add their own ids.
assert.deepEqual(
  buildAgentCliCatalog(plugins).find((option) => option.value === 'codex')?.modelSelection,
  { options: [], allowCustomId: true },
  'bundled Codex exposes the add-your-own model UI with no seeded options',
)
assert.deepEqual(
  buildAgentCliCatalog(plugins).find((option) => option.value === 'claude-code')?.modelSelection,
  { options: [], allowCustomId: true },
  'bundled Claude Code exposes the add-your-own model UI with no seeded options',
)

assert.deepEqual(
  buildAgentCliCatalog(null, {
    opencode: { command: 'opencode', useWsl: false },
    codex: { command: 'codex-next', useWsl: true },
  }).map(({ value, label }) => ({ value, label })),
  [
    { value: 'codex', label: 'Codex' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'opencode', label: 'Opencode' },
  ],
  'missing registry data falls back to canonical bundled plugins plus configured overrides',
)
assert.ok(
  buildAgentCliCatalog(null, {
    codex: { command: 'codex-next', useWsl: true, models: ['custom-codex'] },
  }).find((option) => option.value === 'codex')?.modelSelection?.options.some((model) => model.id === 'custom-codex'),
  'fallback bundled Codex model metadata includes user-added model ids',
)
assert.deepEqual(buildCliRuntimeOptions(undefined).map(({ value, label }) => ({ value, label })), [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
])
assert.deepEqual(buildAgentCliCatalog([]), [], 'loaded empty registry does not invent fallback entries')

assert.deepEqual(
  buildAgentCliCatalog([
    { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' },
    { id: 'generic-shell', displayName: 'Generic Shell', source: 'bundled', version: 1, binary: 'sh' },
  ]).map(({ value, label, source }) => ({ value, label, source })),
  [{ value: 'claude-code', label: 'Claude Code', source: 'bundled' }],
  'generic-shell is hidden from the agent CLI picker catalog',
)

const catalog = buildAgentCliCatalog(plugins)
assert.equal(pluginRegistryIdForCli('claude-code'), 'claude-code')
assert.equal(pluginRegistryIdForCli('aider'), 'aider')
assert.equal(isAgentCliAvailable('claude', catalog), false, 'legacy Claude CLI id is not available')
assert.equal(isAgentCliAvailable('opencode', catalog), true)
assert.equal(isAgentCliAvailable('aider', catalog), false)
assert.equal(resolveAvailableAgentCli('claude', catalog), 'claude-code')
assert.equal(resolveAvailableAgentCli('missing-cli', catalog, 'codex'), 'codex')
assert.equal(resolveAvailableAgentCli('missing-cli', catalog, 'aider'), 'codex')
assert.equal(isAgentCliMissing('claude', catalog), true)
assert.equal(isAgentCliMissing('aider', catalog), true)

// selectAgentCliCatalog: status gates whether registry entries are trusted.
assert.deepEqual(
  selectAgentCliCatalog('ready', plugins).map((option) => option.value),
  ['codex', 'claude-code', 'opencode'],
  'ready status surfaces installed plugins (incl. opencode) before user entries',
)
assert.deepEqual(
  selectAgentCliCatalog('loading', plugins, { opencode: { command: 'opencode', useWsl: false } })
    .map(({ value, label }) => ({ value, label })),
  [
    { value: 'codex', label: 'Codex' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'opencode', label: 'Opencode' },
  ],
  'loading status ignores registry entries and falls back to canonical bundled plugins + configured runtimes',
)
assert.deepEqual(
  selectAgentCliCatalog('error', plugins).map(({ value, label }) => ({ value, label })),
  [
    { value: 'codex', label: 'Codex' },
    { value: 'claude-code', label: 'Claude Code' },
  ],
  'registry error falls back to canonical bundled plugin options',
)
assert.deepEqual(
  selectAgentCliCatalog('ready', []),
  [],
  'ready status with no installed plugins returns an empty catalog instead of inventing fallbacks',
)
// A persisted `generic-shell` runtime key must not leak the hidden id into the
// loading/error fallback catalog — both catalog paths apply the picker hidden
// set, so the automation editor's fail-closed cli check never sees it as valid.
assert.deepEqual(
  selectAgentCliCatalog('loading', plugins, { 'generic-shell': { command: 'sh', useWsl: false } })
    .map((option) => option.value),
  ['codex', 'claude-code'],
  'loading fallback drops a configured generic-shell runtime key (hidden id)',
)
assert.deepEqual(
  selectAgentCliCatalog('error', null, { 'generic-shell': { command: 'sh', useWsl: false } })
    .map((option) => option.value),
  ['codex', 'claude-code'],
  'error fallback drops a configured generic-shell runtime key (hidden id)',
)
assert.equal(
  isAgentCliAvailable(
    'generic-shell',
    selectAgentCliCatalog('error', null, { 'generic-shell': { command: 'sh', useWsl: false } }),
  ),
  false,
  'generic-shell is unavailable in the fallback catalog even when configured as a runtime',
)

// orderInstalledPlugins: bundled-first, deduped, full entries preserved.
assert.deepEqual(
  orderInstalledPlugins(plugins).map((entry) => `${entry.id}:${entry.source}`),
  ['codex:bundled', 'claude-code:bundled', 'opencode:user'],
  'installed plugin rows order bundled before user and dedupe by id',
)
assert.deepEqual(orderInstalledPlugins(null), [], 'null entries yield no rows')
assert.equal(
  orderInstalledPlugins(plugins)[0].binary,
  'codex',
  'row entries keep the manifest binary for the blank-override placeholder',
)

// cliRuntimeForPlugin: direct plugin-id overrides only.
assert.deepEqual(
  cliRuntimeForPlugin('codex', { codex: { command: 'codex-next', useWsl: true } }),
  { command: 'codex-next', useWsl: true },
  'direct plugin-id override is used as-is',
)
assert.deepEqual(
  cliRuntimeForPlugin('claude-code', {
    'claude-code': { command: '', useWsl: false },
  }),
  { command: '', useWsl: false },
  'an explicit blank command on the plugin-id key means manifest binary',
)
assert.deepEqual(
  cliRuntimeForPlugin('opencode', undefined),
  { command: '', useWsl: false },
  'unknown plugin with no override reads as blank command',
)

// resolveTemplateAgentCli: plain New chat / template-agent fallback.
assert.equal(
  resolveTemplateAgentCli('opencode', 'codex', catalog),
  'opencode',
  'an explicit picker selection is honored as-is',
)
assert.equal(
  resolveTemplateAgentCli(null, 'aider', catalog),
  'codex',
  'a stale lastSelectedCli (uninstalled) falls back to the first available catalog entry',
)
assert.equal(
  resolveTemplateAgentCli(undefined, 'claude-code', catalog),
  'claude-code',
  'a canonical lastSelectedCli is preserved',
)
assert.equal(
  resolveTemplateAgentCli(null, 'aider', []),
  'aider',
  'an empty catalog returns lastSelectedCli unchanged instead of throwing',
)

// Model catalog merging: manifest seeds first, then user-added ids deduped;
// plugins without modelSelection never grow model UI from user runtimes.
const modelPlugins: PluginCatalogEntry[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    source: 'bundled',
    version: 1,
    binary: 'claude',
    modelSelection: {
      options: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
      allowCustomId: true,
    },
  },
  { id: 'opencode', displayName: 'OpenCode', source: 'user', version: 1, binary: 'opencode' },
]
const modelCatalog = buildAgentCliCatalog(modelPlugins, {
  'claude-code': { command: '', useWsl: false, models: [' opus ', 'haiku', 'haiku'] },
  opencode: { command: '', useWsl: false, models: ['some/model'] },
})
assert.deepEqual(
  modelCatalog.find((option) => option.value === 'claude-code')?.modelSelection,
  {
    options: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku' }],
    allowCustomId: true,
  },
  'user-added model ids merge after manifest seeds, trimmed and deduped',
)
assert.equal(
  modelCatalog.find((option) => option.value === 'opencode')?.modelSelection,
  undefined,
  'user models without a declared modelSelection never surface model UI',
)

// resolveCliModel: per-surface override wins only for its own CLI; otherwise
// undefined means CLI default, no flag.
assert.equal(
  resolveCliModel('claude-code', { cli: 'claude-code', model: 'opus' }),
  'opus',
  'a matching per-surface override wins',
)
assert.equal(
  resolveCliModel('codex', { cli: 'claude-code', model: 'opus' }),
  undefined,
  'an override for a different CLI is ignored and no fallback model is used',
)
assert.equal(resolveCliModel('codex', undefined), undefined, 'no selection means the CLI default')
assert.equal(resolveCliModel('codex', null), undefined, 'null selections mean the CLI default')

// --- availability filtering (deployment gating) --------------------------
const availCatalog = buildAgentCliCatalog(plugins) // codex, claude-code, opencode
// Only codex installed -> claude-code + opencode hidden; codex annotated.
assert.deepEqual(
  filterCatalogByAvailability(availCatalog, availabilityMap({ codex: true, 'claude-code': false, opencode: false }), 'ready')
    .map((option) => option.value),
  ['codex'],
  'ready availability hides CLIs whose binary is not installed',
)
assert.equal(
  filterCatalogByAvailability(availCatalog, availabilityMap({ codex: true, 'claude-code': false, opencode: false }), 'ready')
    .find((option) => option.value === 'codex')?.installed,
  true,
  'surviving options are annotated with installed state',
)
// Loading status must not filter (never-empty guard) even if map says nothing installed.
assert.deepEqual(
  filterCatalogByAvailability(availCatalog, availabilityMap({ codex: false, 'claude-code': false, opencode: false }), 'loading')
    .map((option) => option.value),
  ['codex', 'claude-code', 'opencode'],
  'loading status shows all registered CLIs (never an empty picker)',
)
// Zero installed while ready -> fall back to unfiltered rather than empty.
assert.deepEqual(
  filterCatalogByAvailability(availCatalog, availabilityMap({ codex: false, 'claude-code': false, opencode: false }), 'ready')
    .map((option) => option.value),
  ['codex', 'claude-code', 'opencode'],
  'zero detected installs falls back to the full catalog instead of hiding everything',
)
// An option with no availability entry stays visible (unknown != not-installed).
assert.deepEqual(
  filterCatalogByAvailability(availCatalog, availabilityMap({ codex: true }), 'ready')
    .map((option) => option.value),
  ['codex', 'claude-code', 'opencode'],
  'options without a probe entry are not hidden',
)
// selectAgentCliCatalog applies the filter when availability is passed.
assert.deepEqual(
  selectAgentCliCatalog('ready', plugins, undefined, {
    map: availabilityMap({ codex: true, 'claude-code': false, opencode: false }),
    status: 'ready',
  }).map((option) => option.value),
  ['codex'],
  'selectAgentCliCatalog hides uninstalled CLIs when availability is provided',
)
// resolveAvailableAgentCli over the filtered catalog auto-remaps a stale default.
const codexOnly = selectAgentCliCatalog('ready', plugins, undefined, {
  map: availabilityMap({ codex: true, 'claude-code': false, opencode: false }),
  status: 'ready',
})
assert.equal(
  resolveAvailableAgentCli('claude-code', codexOnly),
  'codex',
  'a stale claude-code default remaps to the only installed CLI (codex)',
)
assert.equal(
  resolveTemplateAgentCli(null, 'claude-code', codexOnly),
  'codex',
  'a remembered claude-code lastSelectedCli remaps to codex on a codex-only machine',
)

console.log('cliRuntimeOptions.test.ts: ok')
