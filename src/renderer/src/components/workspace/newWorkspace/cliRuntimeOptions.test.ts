import assert from 'node:assert/strict'

import {
  buildAgentCliCatalog,
  buildCliRuntimeOptions,
  cliRuntimeForPlugin,
  isAgentCliAvailable,
  isAgentCliMissing,
  orderInstalledPlugins,
  pluginRegistryIdForCli,
  resolveAvailableAgentCli,
  resolveCliModel,
  resolveTemplateAgentCli,
  selectAgentCliCatalog,
} from './cliRuntimeOptions'
import type { PluginCatalogEntry } from '../../../types/workspace'

const plugins: PluginCatalogEntry[] = [
  { id: 'opencode', displayName: 'OpenCode', source: 'user', version: 1, binary: 'opencode' },
  { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' },
  { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' },
  { id: 'codex', displayName: 'Codex Duplicate', source: 'user', version: 2, binary: 'codex-next' },
]

assert.deepEqual(
  buildAgentCliCatalog(plugins),
  [
    { value: 'codex', label: 'Codex', source: 'bundled' },
    { value: 'claude-code', label: 'Claude Code', source: 'bundled' },
    { value: 'opencode', label: 'OpenCode', source: 'user' },
  ],
  'catalog orders bundled before user entries, labels from displayName, and dedupes ids',
)

assert.deepEqual(
  buildAgentCliCatalog(null, {
    opencode: { command: 'opencode', useWsl: false },
    codex: { command: 'codex-next', useWsl: true },
  }),
  [
    { value: 'codex', label: 'Codex' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'opencode', label: 'Opencode' },
  ],
  'missing registry data falls back to canonical bundled plugins plus configured overrides',
)
assert.deepEqual(buildCliRuntimeOptions(undefined), [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
])
assert.deepEqual(buildAgentCliCatalog([]), [], 'loaded empty registry does not invent fallback entries')

assert.deepEqual(
  buildAgentCliCatalog([
    { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' },
    { id: 'generic-shell', displayName: 'Generic Shell', source: 'bundled', version: 1, binary: 'sh' },
  ]),
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
  selectAgentCliCatalog('loading', plugins, { opencode: { command: 'opencode', useWsl: false } }),
  [
    { value: 'codex', label: 'Codex' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'opencode', label: 'Opencode' },
  ],
  'loading status ignores registry entries and falls back to canonical bundled plugins + configured runtimes',
)
assert.deepEqual(
  selectAgentCliCatalog('error', plugins),
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

// resolveCliModel: per-surface override wins only for its own CLI, then the
// remembered per-CLI default, else undefined (CLI default, no flag).
assert.equal(
  resolveCliModel('claude-code', { cli: 'claude-code', model: 'opus' }, { 'claude-code': 'sonnet' }),
  'opus',
  'a matching per-surface override wins',
)
assert.equal(
  resolveCliModel('codex', { cli: 'claude-code', model: 'opus' }, { codex: 'gpt-5-codex' }),
  'gpt-5-codex',
  'an override for a different CLI is ignored in favor of the per-CLI default',
)
assert.equal(resolveCliModel('codex', undefined, {}), undefined, 'no selection means the CLI default')
assert.equal(resolveCliModel('codex', null, { codex: '  ' }), undefined, 'blank defaults are treated as unset')

console.log('cliRuntimeOptions.test.ts: ok')
