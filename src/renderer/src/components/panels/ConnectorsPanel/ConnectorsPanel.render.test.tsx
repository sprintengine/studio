import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'

import type { AutomationDefinition } from '../../../../../shared/automations/contracts'
import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import { PluginIcon, resolveIconUrl } from '../../settings/BrowseStorefront'
import { ConnectorsBody, FacetTabs, ReadyConnectorsRail } from './ConnectorsBrowseCanvas'
import { ExtensionKindCanvas, automationShelfRowState } from './ExtensionKindCanvas'
import { deriveConnectorsView, registryEntriesForKinds, type ConnectorFacet, type SourceLoad } from './connectorsFacets'
import type { ConnectorSources } from './useConnectorSources'

// A static-render smoke test: full Electron drive is not available in the shared
// run worktree, so this exercises the real presentation tree (the shared
// ConnectorRow sections and every view state) to catch render-time crashes
// and confirm each state surfaces the right copy — the layer typecheck can't see.

const railway: McpCatalogServer = {
  id: 'railway',
  name: 'Railway',
  category: 'Deployments',
  description: 'Deploys, services, logs',
  transport: 'http',
  clients: [],
  required: false,
  riskLevel: 'low',
  skill: 'use-railway',
} as McpCatalogServer

const stripePlugin: MarketplacePluginEntry = {
  id: 'stripe-mcp',
  name: 'Stripe',
  publisher: { name: 'Stripe', verified: true },
  summary: 'Payments, billing, customers',
  category: 'Payments',
  icon: 'stripe.svg',
  latest: 1,
  provides: ['mcp', 'skills'],
}

const ready = <T,>(data: T): SourceLoad<T> => ({ status: 'ready', data })
const noop = () => {}
const retry = <button type="button">Retry</button>

function body(
  view: ReturnType<typeof deriveConnectorsView>,
  selectedKey: string | null = null,
  facet: ConnectorFacet = 'All',
): string {
  const entries = view.status === 'ready' ? view.entries : []
  const selectedEntry = entries.find((entry) => entry.key === selectedKey) ?? null
  return renderToStaticMarkup(
    <ConnectorsBody
      view={view}
      facet={facet}
      registryUrl={null}
      workspaceRoot={'/repo'}
      mcpSettings={{ syncEnabled: true, servers: {} }}
      selectedKey={selectedKey}
      selectedEntry={selectedEntry}
      onSelect={noop}
      onCloseDetail={noop}
      onToggleCatalogServer={noop}
      onLaunchConnector={noop}
      onUseInAutomation={noop}
      onUpsertMcpServer={noop}
      onRegistryInstalled={noop}
      retry={retry}
    />,
  )
}

// --- every view state renders its own copy --------------------------------

assert.match(
  body(deriveConnectorsView({ status: 'loading' }, { status: 'loading' }, new Set(), '', 'All')),
  /Loading connectors/,
)

assert.match(
  body(
    deriveConnectorsView(
      { status: 'error', message: 'catalog down.' },
      { status: 'error', message: 'registry down.' },
      new Set(),
      '',
      'All',
    ),
  ),
  /catalog down\./,
)

assert.match(body(deriveConnectorsView(ready([]), ready([]), new Set(), '', 'All')), /No connectors are available/)

assert.match(
  body(deriveConnectorsView(ready([railway]), ready([stripePlugin]), new Set(), 'zzz', 'All')),
  /No connectors match/,
)

// --- ready list renders both sources' rows in category sections ------------

{
  const markup = body(deriveConnectorsView(ready([railway]), ready([stripePlugin]), new Set(), '', 'All'))
  assert.match(markup, /Railway/)
  assert.match(markup, /Stripe/)
  // Rows carry the one-line summary from each source, not bare names.
  assert.match(markup, /Deploys, services, logs/)
  assert.match(markup, /Payments, billing, customers/)
  // Category section headings from the facet buckets.
  assert.match(markup, /Infrastructure/)
  assert.match(markup, /Payments/)
  // Source-appropriate affordances: catalog adds in place, registry routes to Get.
  assert.match(markup, /Add Railway/)
  assert.match(markup, /Get/)
  // Transport plumbing stays off the row face.
  assert.doesNotMatch(markup, />http</)
}

// A launchable catalog entry selected → its detail exposes New chat + Use in
// automation (the T1 launch route + the T8 automation route).
{
  const markup = body(
    deriveConnectorsView(ready([railway]), ready([]), new Set(), '', 'Featured'),
    'catalog:railway',
    'Featured',
  )
  assert.match(markup, /New chat/)
  assert.match(markup, /Use in automation/)
}

// --- plugin detail: bundled skills section (MC-1565) ------------------------

{
  const skillNames = ['hf-cli', 'hf-datasets', 'hf-gradio', 'hf-papers', 'hf-spaces', 'hf-trainer', 'hf-eval', 'hf-mem']
  const skilled: MarketplacePluginEntry = {
    ...stripePlugin,
    id: 'anthropic-huggingface-skills',
    name: 'huggingface-skills',
    tags: ['claude-plugin'],
    source: 'https://github.com/huggingface/skills.git',
    skills: skillNames.map((name) => ({
      name,
      description: `${name} does a thing on the Hub.`,
      path: `skills/${name}`,
    })),
  }
  const markup = body(
    deriveConnectorsView(ready([]), ready([skilled]), new Set(), '', 'All'),
    'registry:anthropic-huggingface-skills',
  )
  // Section heading carries the full count; the list collapses past six.
  assert.match(markup, /Skills · 8/)
  assert.match(markup, /hf-cli/)
  assert.match(markup, /hf-cli does a thing on the Hub\./)
  assert.match(markup, /Show 2 more/)
  assert.doesNotMatch(markup, /hf-mem does a thing/)

  // A plugin with no skills renders no Skills section — no placeholder copy.
  const bare = body(deriveConnectorsView(ready([]), ready([stripePlugin]), new Set(), '', 'All'), 'registry:stripe-mcp')
  assert.doesNotMatch(bare, /Skills ·/)
}

// --- facet tabs render all six, marking the active one ---------------------

{
  const view = deriveConnectorsView(ready([railway]), ready([stripePlugin]), new Set(), '', 'Featured')
  const markup = renderToStaticMarkup(<FacetTabs view={view} facet="Featured" onSelect={noop} />)
  for (const label of ['Featured', 'Infrastructure', 'Payments', 'Productivity', 'Data', 'All']) {
    assert.match(markup, new RegExp(label))
  }
  assert.match(markup, /aria-selected="true"[^>]*>.*?<span>Featured<\/span>/s)
}

// --- ready-to-launch rail: launchable connector rows with both actions ------

{
  const markup = renderToStaticMarkup(
    <ReadyConnectorsRail connectors={[railway]} onLaunchConnector={noop} onUseInAutomation={noop} />,
  )
  assert.match(markup, /Railway/)
  assert.match(markup, /New chat/)
  assert.match(markup, /Use in automation/)
  assert.match(markup, /Ready to launch/)
}

// Empty rail renders nothing at all (no header, no chrome).
assert.equal(
  renderToStaticMarkup(<ReadyConnectorsRail connectors={[]} onLaunchConnector={noop} onUseInAutomation={noop} />),
  '',
)

// Past the collapse limit the rail cuts off at four rows behind "Show N more";
// the heading still reports the full population (MC-1847 A1).
{
  const many = Array.from({ length: 6 }, (_, i) => ({
    ...railway,
    id: `svc-${i}`,
    name: `Service ${i}`,
  }))
  const markup = renderToStaticMarkup(
    <ReadyConnectorsRail connectors={many} onLaunchConnector={noop} onUseInAutomation={noop} />,
  )
  assert.match(markup, /Ready to launch/)
  assert.match(markup, /Service 0/)
  assert.match(markup, /Service 3/)
  assert.doesNotMatch(markup, /Service 4/)
  assert.match(markup, /Show 2 more/)
  assert.match(markup, />6</)

  // At or under the limit there is no toggle.
  const few = renderToStaticMarkup(
    <ReadyConnectorsRail connectors={many.slice(0, 4)} onLaunchConnector={noop} onUseInAutomation={noop} />,
  )
  assert.doesNotMatch(few, /Show \d+ more/)
  assert.doesNotMatch(few, /Show fewer/)
}

// --- kind canvases (MC-1847 C2): modules and agent CLIs browse for real -----

function kindSources(registryLoad: SourceLoad<MarketplacePluginEntry[]>): ConnectorSources {
  return {
    catalogLoad: ready<McpCatalogServer[]>([]),
    registryLoad,
    registryUrl: null,
    mcpSettings: { syncEnabled: true, servers: {} },
    installedServerIds: new Set<string>(),
    upsertMcpServer: noop,
    toggleCatalogServer: noop,
    loadCatalog: async () => {},
    loadRegistry: async () => {},
  }
}

{
  const roadmapModule: MarketplacePluginEntry = {
    ...stripePlugin,
    id: 'roadmap-module',
    name: 'Roadmap',
    summary: 'Plan multi-sprint arcs on a shared board.',
    category: 'Planning',
    provides: ['module'],
  }
  const cursorCli: MarketplacePluginEntry = {
    ...stripePlugin,
    id: 'cursor-cli',
    name: 'Cursor',
    summary: 'Drive the Cursor agent from Multicode.',
    category: 'Development',
    provides: ['cli'],
  }
  const loaded = kindSources(ready([roadmapModule, cursorCli, stripePlugin]))

  // A module plugin renders on the module canvas; mcp/cli-only plugins do not.
  const modules = renderToStaticMarkup(
    <ExtensionKindCanvas kind="module" sources={loaded} workspaceRoot="/repo" />,
  )
  assert.match(modules, /Capability modules/)
  assert.match(modules, /Roadmap/)
  assert.match(modules, /Plan multi-sprint arcs/)
  assert.doesNotMatch(modules, /Cursor/)
  assert.doesNotMatch(modules, /Stripe/)

  const clis = renderToStaticMarkup(
    <ExtensionKindCanvas kind="cli" sources={loaded} workspaceRoot="/repo" />,
  )
  assert.match(clis, /Agent CLIs/)
  assert.match(clis, /Cursor/)
  assert.doesNotMatch(clis, /Roadmap/)

  // Empty, loading, and unavailable each carry their own copy — a down
  // registry must never read as an empty marketplace.
  assert.match(
    renderToStaticMarkup(
      <ExtensionKindCanvas kind="module" sources={kindSources(ready([stripePlugin]))} workspaceRoot="/repo" />,
    ),
    /No capability modules are in the marketplace yet/,
  )
  assert.match(
    renderToStaticMarkup(
      <ExtensionKindCanvas kind="module" sources={kindSources({ status: 'loading' })} workspaceRoot="/repo" />,
    ),
    /Loading the marketplace/,
  )
  assert.match(
    renderToStaticMarkup(
      <ExtensionKindCanvas
        kind="cli"
        sources={kindSources({ status: 'error', message: 'registry down.' })}
        workspaceRoot="/repo"
      />,
    ),
    /The marketplace is unavailable: registry down\./,
  )
}

// --- the agent CLIs shelf with runtime state (MC-1858) ----------------------

{
  const seed = JSON.parse(readFileSync('resources/marketplace/marketplace.json', 'utf8')) as {
    plugins: MarketplacePluginEntry[]
  }
  const seedClis = seed.plugins.filter((plugin) => plugin.provides.includes('cli'))
  assert.equal(seedClis.length, 12, 'the packaged seed carries the twelve bundled agent CLIs')

  const catalogEntry = (id: string, binary: string) =>
    ({ id, displayName: id, source: 'bundled', version: 1, binary, resumeSession: false, sessionIdFromCaller: false }) as never
  // The nine runtime-installable CLI plugins; the provider trio (claude-agent,
  // openrouter, xai) is deliberately absent — no binary, nothing to install.
  const runtimeCatalog = [
    'claude-code', 'codex', 'cursor', 'generic-shell', 'grok', 'kimi-claude', 'kimi-code', 'opencode', 'zai',
  ].map((id) => catalogEntry(id, id === 'claude-code' ? 'claude' : id === 'cursor' ? 'cursor-agent' : id))

  const runtime = {
    platform: 'darwin',
    availability: {
      'claude-code': { cli: 'claude-code', installed: true, resolvedPath: '/usr/local/bin/claude', version: '2.4.1' },
      cursor: { cli: 'cursor', installed: false, resolvedPath: null, version: null },
      // every other CLI probe "failed" (omitted) — those rows must read unknown,
      // never installable.
    },
    availabilityStatus: 'ready' as const,
    availabilityError: null,
    catalogEntries: runtimeCatalog,
    catalogStatus: 'ready' as const,
    cliRuntimes: {},
    refreshAvailability: async () => {},
    refreshCatalog: async () => {},
    setCliRuntime: noop,
  }

  const markup = renderToStaticMarkup(
    <ExtensionKindCanvas
      kind="cli"
      sources={kindSources(ready(seedClis))}
      workspaceRoot="/repo"
      cliRuntime={runtime}
    />,
  )

  // All twelve bundled entries render as rows — each disclosable row carries
  // exactly one "<name> details" chevron button.
  assert.equal((markup.match(/ details"/g) ?? []).length, 12, 'all 12 bundled CLI entries render')

  // Installed: probe version in the mono slot, the shared Ready vocabulary,
  // and the resolved binary path as the state line's identifier.
  assert.match(markup, /2\.4\.1/)
  assert.match(markup, /Ready/)
  assert.match(markup, /\/usr\/local\/bin\/claude/)

  // Definitively absent: the honest negative, named binary. (The Install button
  // itself needs the install-methods probe, which only runs in a live DOM — the
  // interaction test drives it.)
  assert.match(markup, /Not installed — no cursor-agent on PATH/)

  // The provider trio has nothing to runtime-install and says so.
  assert.equal((markup.match(/Built into the app — nothing to install/g) ?? []).length, 3)

  // A CLI whose probe failed must not render as installable — the pickers'
  // signal, kept consistent here.
  assert.match(markup, /Availability unknown/)
  assert.doesNotMatch(markup, />Install</)

  // No trust-tier vocabulary on the runtime rows: installed-or-not is the state
  // this shelf carries.
  assert.doesNotMatch(markup, /published by/)

  // The batch probe failing is stated once above the list, and rows stay up.
  const probeDown = renderToStaticMarkup(
    <ExtensionKindCanvas
      kind="cli"
      sources={kindSources(ready(seedClis))}
      workspaceRoot="/repo"
      cliRuntime={{ ...runtime, availability: {}, availabilityStatus: 'error', availabilityError: 'no shell' }}
    />,
  )
  assert.match(probeDown, /Agent CLIs could not be checked: no shell/)
  assert.equal((probeDown.match(/ details"/g) ?? []).length, 12, 'rows still render under a failed probe')
  assert.doesNotMatch(probeDown, />Install</)
}

// --- the automations shelf (MC-2034) ---------------------------------------

{
  const deadCode: MarketplacePluginEntry = {
    ...stripePlugin,
    id: 'multicode.dead-code-sweep',
    name: 'Dead code sweep',
    publisher: { name: 'Multicode Labs', verified: false },
    summary: 'Finds code nothing reaches and deletes only what it can prove is dead.',
    category: 'Development',
    provides: ['automation'],
  }
  const markup = renderToStaticMarkup(
    <ExtensionKindCanvas kind="automation" sources={kindSources(ready([deadCode, stripePlugin]))} workspaceRoot="/repo" />,
  )
  assert.match(markup, /Automations/)
  assert.match(markup, /Dead code sweep/)
  // First paint, before the project's store has answered: the row must NOT
  // claim "Not added" and must offer no Get — that is a state it does not know.
  assert.match(markup, /Checking this project — published by Multicode Labs/)
  assert.doesNotMatch(markup, /Not added/, 'a definitive negative is not shown while the read is in flight')
  assert.doesNotMatch(markup, /Get Dead code sweep/, 'and no Get is offered against an unknown state')
  assert.doesNotMatch(markup, /Finds code nothing reaches/, 'the description stays off the row face')
  // Only automation entries list here.
  assert.doesNotMatch(markup, /Stripe/)

  // No signing vocabulary anywhere on this surface: an automation is a
  // definition the app's own engine interprets, never code.
  for (const word of [/Verified/, /Unsigned/, /Community/, /Inline MCP/, /trust/i]) {
    assert.doesNotMatch(markup, word, `no trust vocabulary on the automations shelf (${word})`)
  }
  // And no version slot — the registry's bundle revision is not an automation's
  // version, so the mono slot stays empty rather than saying "unknown".
  assert.doesNotMatch(markup, /unknown version/i)

  // A registry that fails to load is its own state, never "none available".
  const down = renderToStaticMarkup(
    <ExtensionKindCanvas
      kind="automation"
      sources={kindSources({ status: 'error', message: 'registry down.' })}
      workspaceRoot="/repo"
    />,
  )
  assert.match(down, /The marketplace is unavailable: registry down\./)
  assert.doesNotMatch(down, /No automations are in the marketplace yet/)

  // Day one: a registry with no automations in it says so.
  assert.match(
    renderToStaticMarkup(
      <ExtensionKindCanvas kind="automation" sources={kindSources(ready([stripePlugin]))} workspaceRoot="/repo" />,
    ),
    /No automations are in the marketplace yet/,
  )
}

// The row's state and action, over the one fact that decides them.
{
  const entry = registryEntriesForKinds(
    [
      {
        ...stripePlugin,
        id: 'multicode.dead-code-sweep',
        name: 'Dead code sweep',
        publisher: { name: 'Multicode Labs', verified: false },
        provides: ['automation'],
      },
    ],
    ['automation'],
  )[0]

  // Unknown is its own state, never a negative: a Get offered here could land on
  // an automation the project already has.
  const unknown = automationShelfRowState(entry, null, false)
  assert.equal(unknown.stateLine, 'Checking this project — published by Multicode Labs')
  assert.equal(unknown.action, 'none')

  const notAdded = automationShelfRowState(entry, null, true)
  assert.equal(notAdded.stateLine, 'Not added — published by Multicode Labs')
  assert.equal(notAdded.health, 'neutral')
  assert.equal(notAdded.action, 'get')

  const definition = {
    id: 'auto-1',
    name: 'Dead code sweep',
    status: 'enabled',
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '02:00' }, timezone: 'UTC' } },
    action: { kind: 'spawn-agent', config: { prompt: 'Find code nothing reaches.' } },
    sourceCatalogueId: 'multicode.dead-code-sweep',
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  } as AutomationDefinition

  const added = automationShelfRowState(entry, definition, true)
  assert.equal(added.stateLine, 'Added — Daily at 02:00', 'the state line names the schedule the project actually holds')
  assert.equal(added.health, 'good', 'the dot follows the state, and is not a trust tier')
  assert.equal(added.action, 'open', 'an automation already in this project cannot be got again')

  // A paused one is still added — the state line says which, rather than
  // reading as if it were still on the shelf.
  const paused = automationShelfRowState(entry, { ...definition, status: 'paused' }, true)
  assert.equal(paused.stateLine, 'Added, paused — Daily at 02:00')
  assert.equal(paused.action, 'open')
}

// --- data-URI icons from the generated catalogue render through PluginIcon --

{
  const dataUri = 'data:image/svg+xml;base64,PHN2Zy8+'
  // Absolute icons survive with and without a registry base URL.
  assert.equal(resolveIconUrl('https://registry.example.com/marketplace.json', dataUri), dataUri)
  assert.equal(resolveIconUrl(null, dataUri), dataUri)
  // Relative registry paths still resolve against the registry URL.
  assert.equal(
    resolveIconUrl('https://registry.example.com/marketplace.json', 'icons/stripe.svg'),
    'https://registry.example.com/icons/stripe.svg',
  )
  const markup = renderToStaticMarkup(<PluginIcon iconUrl={dataUri} name="Stripe" size={32} />)
  assert.match(markup, /src="data:image\/svg\+xml;base64,PHN2Zy8\+"/)
}

console.log('connectors-panel render guard passed')
