import assert from 'node:assert/strict'

import {
  buildAgentCliCatalog,
  buildCliRuntimeOptions,
  cliRuntimeForPlugin,
  filterCatalogByAvailability,
  installableCliSummary,
  isAgentCliAvailable,
  isAgentCliMissing,
  orderInstalledPlugins,
  pluginRegistryIdForCli,
  resolveAvailableAgentCli,
  resolveCliModel,
  resolveLaunchableAgentCli,
  resolveCliReasoning,
  resolveTemplateAgentCli,
  selectAgentCliCatalog,
} from './cliRuntimeOptions'
import type { AgentCliAvailabilityMap, PluginCatalogEntry } from '../../../types/workspace'
import { test } from 'vitest'

test('cliRuntimeOptions', async () => {
  function availabilityMap(map: Record<string, boolean>): AgentCliAvailabilityMap {
    const out: AgentCliAvailabilityMap = {}
    for (const [cli, installed] of Object.entries(map)) {
      out[cli] = { cli, installed, resolvedPath: installed ? `/bin/${cli}` : null, version: installed ? '1' : null }
    }
    return out
  }

  // Registry entries always carry the resume capabilities and the agent-state
  // eligibility projected from the manifest. Catalog building never reads the
  // resume pair, so fixtures declare it once here; `agentStateCapable` defaults
  // true (an ordinary agent CLI) and is overridden where a test exercises the
  // hooks-only gate.
  const cliEntry = (
    entry: Omit<PluginCatalogEntry, 'resumeSession' | 'sessionIdFromCaller' | 'agentStateCapable'> &
      Partial<Pick<PluginCatalogEntry, 'agentStateCapable'>>,
  ): PluginCatalogEntry => ({ resumeSession: false, sessionIdFromCaller: false, agentStateCapable: true, ...entry })

  const plugins: PluginCatalogEntry[] = [
    cliEntry({ id: 'opencode', displayName: 'OpenCode', source: 'user', version: 1, binary: 'opencode' }),
    cliEntry({ id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' }),
    cliEntry({ id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' }),
    cliEntry({ id: 'codex', displayName: 'Codex Duplicate', source: 'user', version: 2, binary: 'codex-next' }),
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
      { value: 'opencode', label: 'OpenCode' },
    ],
    'missing registry data falls back to canonical bundled plugins plus configured overrides',
  )
  assert.ok(
    buildAgentCliCatalog(null, {
      codex: { command: 'codex-next', useWsl: true, models: ['custom-codex'] },
    })
      .find((option) => option.value === 'codex')
      ?.modelSelection?.options.some((model) => model.id === 'custom-codex'),
    'fallback bundled Codex model metadata includes user-added model ids',
  )
  assert.deepEqual(
    buildCliRuntimeOptions(undefined).map(({ value, label }) => ({ value, label })),
    [
      { value: 'codex', label: 'Codex' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
    ],
  )
  assert.deepEqual(buildAgentCliCatalog([]), [], 'loaded empty registry does not invent fallback entries')

  assert.deepEqual(
    buildAgentCliCatalog([
      cliEntry({ id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' }),
      cliEntry({ id: 'generic-shell', displayName: 'Generic Shell', source: 'bundled', version: 1, binary: 'sh' }),
    ]).map(({ value, label, source }) => ({ value, label, source })),
    [{ value: 'claude-code', label: 'Claude Code', source: 'bundled' }],
    'generic-shell is hidden from the agent CLI picker catalog',
  )

  // Hooks-only selectability (decision of record 2026-08-31): the catalog gates
  // on the manifest-projected agentStateCapable flag, so a CLI that cannot
  // report agent state is not offered — by capability, not by name.
  assert.deepEqual(
    buildAgentCliCatalog([
      cliEntry({ id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' }),
      cliEntry({
        id: 'no-hooks-cli',
        displayName: 'No Hooks',
        source: 'user',
        version: 1,
        binary: 'nh',
        agentStateCapable: false,
      }),
      cliEntry({
        id: 'muse',
        displayName: 'Muse Code',
        source: 'bundled',
        version: 1,
        binary: 'muse',
        agentStateCapable: false,
      }),
    ]).map(({ value }) => value),
    ['claude-code'],
    'a CLI without agent-state capability is not offered as an agent',
  )
  // The zero-core-edit proof: a future CLI whose manifest declares an
  // agentStateSpec becomes selectable with no code change anywhere — the
  // projected boolean is the whole gate.
  assert.deepEqual(
    buildAgentCliCatalog([
      cliEntry({ id: 'future-cli', displayName: 'Future CLI', source: 'user', version: 1, binary: 'future' }),
    ]).map(({ value }) => value),
    ['future-cli'],
    'a hook-capable future CLI is selectable purely from its manifest projection',
  )
  // A stale persisted snapshot from an older main process lacks the field
  // entirely; the catalog must keep it (fail-open on skew) until the live
  // registry refreshes, rather than emptying every picker.
  assert.deepEqual(
    buildAgentCliCatalog([
      {
        id: 'codex',
        displayName: 'Codex',
        source: 'bundled',
        version: 1,
        binary: 'codex',
        resumeSession: false,
        sessionIdFromCaller: false,
      } as unknown as PluginCatalogEntry,
    ]).map(({ value }) => value),
    ['codex'],
    'an entry missing the flag (older snapshot) stays offered until refreshed',
  )
  // muse is also pinned in the manifest-less fallback set: a persisted
  // cliRuntimes key cannot leak it into the loading/error fallback catalog.
  assert.deepEqual(
    buildAgentCliCatalog(null, {
      muse: { command: 'muse', useWsl: false },
      'generic-shell': { command: 'sh', useWsl: false },
    }).map(({ value }) => value),
    ['codex', 'claude-code', 'opencode'],
    'hidden ids never leak into the legacy fallback catalog via cliRuntimes keys',
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
    selectAgentCliCatalog('loading', plugins, { opencode: { command: 'opencode', useWsl: false } }).map(
      ({ value, label }) => ({ value, label }),
    ),
    [
      { value: 'codex', label: 'Codex' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
    ],
    'loading status ignores registry entries and falls back to canonical bundled plugins + configured runtimes',
  )
  assert.deepEqual(
    selectAgentCliCatalog('error', plugins).map(({ value, label }) => ({ value, label })),
    [
      { value: 'codex', label: 'Codex' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
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
    selectAgentCliCatalog('loading', plugins, { 'generic-shell': { command: 'sh', useWsl: false } }).map(
      (option) => option.value,
    ),
    ['codex', 'claude-code', 'opencode'],
    'loading fallback drops a configured generic-shell runtime key (hidden id)',
  )
  assert.deepEqual(
    selectAgentCliCatalog('error', null, { 'generic-shell': { command: 'sh', useWsl: false } }).map(
      (option) => option.value,
    ),
    ['codex', 'claude-code', 'opencode'],
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
    cliEntry({
      id: 'claude-code',
      displayName: 'Claude Code',
      source: 'bundled',
      version: 1,
      binary: 'claude',
      modelSelection: {
        options: [
          { id: 'opus', label: 'Opus' },
          { id: 'sonnet', label: 'Sonnet' },
        ],
        allowCustomId: true,
      },
    }),
    // `aider` is an unbundled id with no manifest modelSelection and no bundled
    // fallback catalog — the clean "no model UI anywhere" case. (opencode is no
    // longer usable here: it is now a canonical bundled CLI with its own catalog.)
    cliEntry({ id: 'aider', displayName: 'Aider', source: 'user', version: 1, binary: 'aider' }),
  ]
  const modelCatalog = buildAgentCliCatalog(modelPlugins, {
    'claude-code': { command: '', useWsl: false, models: [' opus ', 'haiku', 'haiku'] },
    aider: { command: '', useWsl: false, models: ['some/model'] },
  })
  assert.deepEqual(
    modelCatalog.find((option) => option.value === 'claude-code')?.modelSelection,
    {
      options: [
        { id: 'opus', label: 'Opus', origin: 'user' },
        { id: 'sonnet', label: 'Sonnet', origin: 'manifest' },
        { id: 'haiku', origin: 'user' },
      ],
      allowCustomId: true,
    },
    'user-added model ids merge after manifest seeds, trimmed and deduped; a seeded id the user also typed reports the stronger claim',
  )
  assert.equal(
    modelCatalog.find((option) => option.value === 'aider')?.modelSelection,
    undefined,
    'user models without a declared modelSelection never surface model UI',
  )

  // --- three-layer model merge (manifest ∪ discovered ∪ user) ----------------
  // The merge is a UNION. Discovery reports the CLI's curated picker list, not
  // the set of ids `--model` accepts, so it under-reports: measured 2026-07-26,
  // Claude's SDK listed five models with no Opus 5 while `claude -p --model
  // claude-opus-5` ran fine on the same account. Every assertion below exists
  // because a "replace the list with what discovery said" merge passes a naive
  // test and silently deletes working models.
  const discoveryPlugins: PluginCatalogEntry[] = [
    cliEntry({
      id: 'claude-code',
      displayName: 'Claude Code',
      source: 'bundled',
      version: 1,
      binary: 'claude',
      modelSelection: {
        options: [
          // The floating alias and the pin discovery misses. `opus[1m]` is what
          // the SDK reports resolving to `claude-opus-4-8[1m]`; it actually runs
          // Opus 5, which is why the two must never collapse into one row.
          { id: 'opus[1m]', label: 'Opus (1M context)' },
          { id: 'claude-opus-5', label: 'Opus 5' },
        ],
        allowCustomId: true,
      },
    }),
  ]
  const userAddedClaudeModels = { 'claude-code': { command: '', useWsl: false, models: ['claude-haiku-4-5'] } }
  const claudeModelRows = (
    discovered: Parameters<typeof buildAgentCliCatalog>[2],
  ): { id: string; label?: string; origin: string }[] =>
    buildAgentCliCatalog(discoveryPlugins, userAddedClaudeModels, discovered).find(
      (option) => option.value === 'claude-code',
    )?.modelSelection?.options ?? []

  const firstProbe = claudeModelRows({
    'claude-code': {
      models: [
        { id: 'opus[1m]', displayName: 'Opus (1M)', resolvedModel: 'claude-opus-4-8[1m]' },
        { id: 'claude-opus-4-8[1m]' },
        { id: 'sonnet' },
      ],
      fetchedAt: '2026-07-26T00:00:00Z',
      source: 'agent-sdk',
    },
  })
  assert.deepEqual(
    firstProbe,
    [
      { id: 'opus[1m]', label: 'Opus (1M)', origin: 'discovered' },
      { id: 'claude-opus-5', label: 'Opus 5', origin: 'manifest' },
      { id: 'claude-opus-4-8[1m]', origin: 'discovered' },
      { id: 'sonnet', origin: 'discovered' },
      { id: 'claude-haiku-4-5', origin: 'user' },
    ],
    'Opus 5 regression: a manifest model discovery omits survives, discovery enriches the alias label, and an alias + the pin its resolvedModel names stay two rows',
  )

  const secondProbe = claudeModelRows({
    'claude-code': {
      models: [{ id: 'opus[1m]' }],
      fetchedAt: '2026-07-27T00:00:00Z',
      source: 'agent-sdk',
    },
  })
  assert.deepEqual(
    secondProbe,
    [
      { id: 'opus[1m]', label: 'Opus (1M context)', origin: 'discovered' },
      { id: 'claude-opus-5', label: 'Opus 5', origin: 'manifest' },
      { id: 'claude-haiku-4-5', origin: 'user' },
    ],
    'the discovered layer is replaced wholesale: models the CLI stopped listing are gone, while the manifest seed and the user id survive',
  )

  const thirdProbe = claudeModelRows({
    'claude-code': {
      models: [{ id: 'sonnet' }],
      fetchedAt: '2026-07-28T00:00:00Z',
      source: 'agent-sdk',
    },
  })
  assert.deepEqual(
    thirdProbe,
    [
      { id: 'opus[1m]', label: 'Opus (1M context)', origin: 'manifest' },
      { id: 'claude-opus-5', label: 'Opus 5', origin: 'manifest' },
      { id: 'sonnet', origin: 'discovered' },
      { id: 'claude-haiku-4-5', origin: 'user' },
    ],
    'a model in both layers that drops out of discovery stays as the manifest row — its seeded label back, and no longer claimed as discovered',
  )

  const noDiscoveryRows = claudeModelRows(undefined)
  assert.deepEqual(
    noDiscoveryRows,
    [
      { id: 'opus[1m]', label: 'Opus (1M context)', origin: 'manifest' },
      { id: 'claude-opus-5', label: 'Opus 5', origin: 'manifest' },
      { id: 'claude-haiku-4-5', origin: 'user' },
    ],
    'with no discovered catalog the picker shows exactly the manifest seed plus the user list',
  )
  assert.deepEqual(claudeModelRows({}), noDiscoveryRows, 'an empty catalog renders the same rows as no catalog at all')
  assert.deepEqual(
    claudeModelRows({
      'claude-code': { models: undefined, fetchedAt: '2026-07-26T00:00:00Z', source: 'agent-sdk' },
    } as never),
    noDiscoveryRows,
    'a malformed catalog that slipped past the normalizer changes nothing and never throws',
  )
  assert.deepEqual(
    claudeModelRows({
      'claude-code': { models: [], fetchedAt: '2026-07-26T00:00:00Z', source: 'agent-sdk' },
    }),
    noDiscoveryRows,
    'a CLI that answered with no models leaves the curated layers rendering exactly as before',
  )
  assert.equal(
    firstProbe.every((row) => row.origin === 'manifest' || row.origin === 'discovered' || row.origin === 'user'),
    true,
    'every merged row reports which layer claimed it',
  )
  assert.deepEqual(
    buildAgentCliCatalog(
      [cliEntry({ id: 'aider', displayName: 'Aider', source: 'user', version: 1, binary: 'aider' })],
      undefined,
      { aider: { models: [{ id: 'some/model' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' } },
    ).find((option) => option.value === 'aider')?.modelSelection,
    undefined,
    'a CLI with no declared modelSelection surfaces no model UI even when discovery reported models',
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

  // resolveCliReasoning: the same cli-match guard, because a level is per-CLI
  // manifest knowledge — codex's `ultra` is not a level claude-code accepts.
  assert.equal(
    resolveCliReasoning('codex', { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }),
    'high',
    'a level picked for this CLI is honored',
  )
  assert.equal(
    resolveCliReasoning('claude-code', { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'ultra' }),
    undefined,
    'a level picked for another CLI never reaches this launch',
  )
  assert.equal(
    resolveCliReasoning('codex', { cli: 'codex', model: '', reasoning: 'high' }),
    'high',
    'a level survives choosing the CLI default model (empty model id)',
  )
  assert.equal(
    resolveCliReasoning('codex', { cli: 'codex', model: 'gpt-5.6-sol' }),
    undefined,
    'a selection with no level means the CLI default effort, no flag',
  )
  assert.equal(
    resolveCliReasoning('codex', { cli: 'codex', model: 'gpt-5.6-sol', reasoning: '  ' }),
    undefined,
    'a blank level means the CLI default effort, no flag',
  )
  assert.equal(resolveCliReasoning('codex', undefined), undefined, 'no selection means the CLI default effort')
  assert.equal(resolveCliReasoning('codex', null), undefined, 'null selections mean the CLI default effort')
  // Model and level resolve independently from one selection: switching model
  // within a CLI cannot disturb the level, and vice versa.
  assert.equal(
    resolveCliModel('codex', { cli: 'codex', model: 'gpt-5.5', reasoning: 'high' }),
    'gpt-5.5',
    'a stored level does not disturb model resolution',
  )

  // --- availability filtering (deployment gating) --------------------------
  const availCatalog = buildAgentCliCatalog(plugins) // codex, claude-code, opencode
  // Only codex installed -> claude-code + opencode hidden; codex annotated.
  assert.deepEqual(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: true, 'claude-code': false, opencode: false }),
      'ready',
    ).map((option) => option.value),
    ['codex'],
    'ready availability hides CLIs whose binary is not installed',
  )
  assert.equal(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: true, 'claude-code': false, opencode: false }),
      'ready',
    ).find((option) => option.value === 'codex')?.installed,
    true,
    'surviving options are annotated with installed state',
  )
  // Loading status must not filter (never-empty guard) even if map says nothing installed.
  assert.deepEqual(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: false, 'claude-code': false, opencode: false }),
      'loading',
    ).map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'loading status shows all registered CLIs (never an empty picker)',
  )
  // Zero installed while ready IS the answer on a fresh machine: the
  // catalog empties and the surfaces render their install state, instead of the
  // old escape hatch handing back eight uninstalled CLIs that all read launchable.
  assert.deepEqual(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: false, 'claude-code': false, opencode: false }),
      'ready',
    ).map((option) => option.value),
    [],
    'a ready probe with nothing installed yields an empty catalog, not the unfiltered one',
  )
  // The case the escape hatch was written for still degrades gracefully: CLIs
  // exist, the probe did not finish, and the picker keeps the last known list.
  assert.deepEqual(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: false, 'claude-code': false, opencode: false }),
      'error',
    ).map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'a failed probe keeps the annotated catalog — "we do not know" is not "none installed"',
  )
  assert.deepEqual(
    filterCatalogByAvailability(availCatalog, null, 'ready').map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'an absent availability map is undecided and never empties the picker',
  )
  // An option with no availability entry stays visible (unknown != not-installed).
  assert.deepEqual(
    filterCatalogByAvailability(availCatalog, availabilityMap({ codex: true }), 'ready').map((option) => option.value),
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
  // One CLI installed and the rest not: the existing filtering is unchanged.
  assert.deepEqual(
    codexOnly.map((option) => option.value),
    ['codex'],
    'only the installed CLI survives filtering',
  )

  // --- the zero-CLI machine ---------------------------------------
  const nothingInstalled = selectAgentCliCatalog('ready', plugins, undefined, {
    map: availabilityMap({ codex: false, 'claude-code': false, opencode: false }),
    status: 'ready',
  })
  assert.deepEqual(nothingInstalled, [], 'a machine with no agent CLI offers no agent CLI')
  // The stored-agent guard AgentPanel calls (isStoredAgentCliUnavailable) is
  // isAgentCliMissing over exactly this catalog: with nothing installed, a stored
  // CLI reads unavailable, so the agent pane stops spawning against a missing
  // binary instead of reading it as present through catalog membership.
  assert.equal(
    isAgentCliMissing('codex', nothingInstalled),
    true,
    'a stored codex agent reads unavailable when nothing at all is installed',
  )
  assert.equal(
    isAgentCliAvailable('codex', nothingInstalled),
    false,
    'membership can no longer report an uninstalled CLI as available',
  )
  // resolveLaunchableAgentCli expresses "none" where resolveAvailableAgentCli
  // must still answer with something for a picker to render.
  assert.equal(
    resolveLaunchableAgentCli('codex', nothingInstalled),
    null,
    'no installed CLI means no CLI to launch — never a guessed fallback',
  )
  assert.equal(
    resolveAvailableAgentCli('codex', nothingInstalled),
    'claude-code',
    'the display resolver still answers with its fallback — a guess, which is why launches ask the other one',
  )
  assert.equal(
    resolveLaunchableAgentCli('claude-code', codexOnly),
    'codex',
    'a stale remembered CLI remaps to the installed one',
  )
  assert.equal(
    resolveLaunchableAgentCli(null, codexOnly),
    'codex',
    'no remembered CLI resolves to the first installed entry',
  )
  // What the install route names: the registry's own CLIs, never a hardcoded list.
  assert.equal(
    installableCliSummary(buildAgentCliCatalog(plugins).map((option) => option.label)),
    'Codex, Claude Code, OpenCode.',
    'three installable CLIs are named in full',
  )
  assert.equal(
    installableCliSummary(['Codex', 'Claude Code', 'OpenCode', 'Grok', 'Cursor']),
    'Codex, Claude Code, OpenCode, and 2 more.',
    'beyond three, the rest are counted',
  )
  assert.equal(installableCliSummary([]), '', 'nothing to install names nothing')

  console.log('cliRuntimeOptions.test.ts: ok')

  // --- the hosted layer (the model feed from GitHub) ---------------------------
  // manifest < hosted < discovered < user. The feed is curated like the manifest
  // but live, replaced wholesale on every fetch, and its `retired` rows are the
  // one way to withdraw a model a shipped build still carries in its manifest.
  const hostedRows = (
    hosted: Parameters<typeof buildAgentCliCatalog>[3],
    discovered?: Parameters<typeof buildAgentCliCatalog>[2],
  ): { id: string; label?: string; origin: string; releasedAt?: string }[] =>
    buildAgentCliCatalog(discoveryPlugins, userAddedClaudeModels, discovered, hosted).find(
      (option) => option.value === 'claude-code',
    )?.modelSelection?.options ?? []

  const firstFeed = hostedRows({
    'claude-code': [
      { id: 'claude-opus-5', label: 'Opus 5 (feed label)', releasedAt: '2026-07-25' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', releasedAt: '2026-09-04' },
    ],
  })
  assert.deepEqual(
    firstFeed,
    [
      { id: 'claude-fable-5-1', label: 'Fable 5.1', origin: 'hosted', releasedAt: '2026-09-04' },
      { id: 'claude-opus-5', label: 'Opus 5 (feed label)', origin: 'hosted', releasedAt: '2026-07-25' },
      { id: 'opus[1m]', label: 'Opus (1M context)', origin: 'manifest' },
      { id: 'claude-haiku-4-5', origin: 'user' },
    ],
    'a manifest-only id survives a feed that omits it; a feed row the manifest also has takes the feed label and the hosted claim; a new feed id appears with its release date, and dated rows lead, newest first',
  )

  // Newest first: the date decides, not the layer or the file order. Two models
  // shipped the same day keep the feed's order; undated rows (aliases, manifest
  // leftovers, user additions) follow in layer order, never ahead of a dated one.
  const datedFeed = hostedRows({
    'claude-code': [
      { id: 'claude-opus-5', label: 'Opus 5', releasedAt: '2026-07-24' },
      { id: 'fable', label: 'Fable (latest)', alias: true },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', releasedAt: '2026-07-24' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', releasedAt: '2026-09-01' },
    ],
  })
  assert.deepEqual(
    datedFeed.map((row) => row.id),
    ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'opus[1m]', 'fable', 'claude-haiku-4-5'],
    'dated rows lead newest first, same-day rows keep feed order, and undated rows trail in layer order',
  )

  const secondFeed = hostedRows({ 'claude-code': [{ id: 'claude-opus-5', label: 'Opus 5' }] })
  assert.deepEqual(
    secondFeed.map((row) => row.id),
    ['opus[1m]', 'claude-opus-5', 'claude-haiku-4-5'],
    'the hosted layer is replaced wholesale: an id the next fetch omits is gone, while manifest and user rows survive',
  )

  const retiredFeed = hostedRows({
    'claude-code': [
      { id: 'claude-opus-5', label: 'Opus 5', retired: true, retiredAt: '2026-09-01' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', retired: true, retiredAt: '2026-09-01' },
    ],
  })
  assert.deepEqual(
    retiredFeed,
    [
      { id: 'opus[1m]', label: 'Opus (1M context)', origin: 'manifest' },
      { id: 'claude-haiku-4-5', origin: 'user' },
    ],
    'a retired feed row hides the manifest row of the same id and is not shown itself, and leaves a user-added row alone',
  )

  const retiredButDiscovered = hostedRows(
    { 'claude-code': [{ id: 'claude-opus-5', label: 'Opus 5', retired: true, retiredAt: '2026-09-01' }] },
    { 'claude-code': { models: [{ id: 'claude-opus-5' }], fetchedAt: '2026-09-04T00:00:00Z', source: 'agent-sdk' } },
  )
  assert.deepEqual(
    retiredButDiscovered.find((row) => row.id === 'claude-opus-5'),
    { id: 'claude-opus-5', label: 'Opus 5', origin: 'discovered' },
    "a retired feed row does not override the CLI's own word: an id discovery still lists stays, as discovered",
  )

  assert.deepEqual(hostedRows(undefined), hostedRows({}), 'no feed and an empty feed render the same catalog')
})
