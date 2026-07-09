import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import { PluginIcon, resolveIconUrl } from '../../settings/BrowseStorefront'
import { ConnectorsBody, FacetTabs, ReadyConnectorsRail } from './ConnectorsPanel'
import { deriveConnectorsView, type ConnectorFacet, type SourceLoad } from './connectorsFacets'

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
