import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import { ConnectorsBody, FacetTabs, ReadyConnectorsRail } from './ConnectorsPanel'
import { deriveConnectorsView, type SourceLoad } from './connectorsFacets'

// A static-render smoke test: full Electron drive is not available in the shared
// run worktree, so this exercises the real presentation tree (the reused
// McpCatalogTile / PluginCard and every view state) to catch render-time crashes
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

function body(view: ReturnType<typeof deriveConnectorsView>, selectedKey: string | null = null): string {
  const entries = view.status === 'ready' ? view.entries : []
  const selectedEntry = entries.find((entry) => entry.key === selectedKey) ?? null
  return renderToStaticMarkup(
    <ConnectorsBody
      view={view}
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

// --- ready grid renders both sources' tiles --------------------------------

{
  const markup = body(deriveConnectorsView(ready([railway]), ready([stripePlugin]), new Set(), '', 'All'))
  assert.match(markup, /Railway/)
  assert.match(markup, /Stripe/)
}

// A launchable catalog entry selected → its detail exposes New chat + Use in
// automation (the T1 launch route + the T8 automation route).
{
  const markup = body(deriveConnectorsView(ready([railway]), ready([]), new Set(), '', 'Featured'), 'catalog:railway')
  assert.match(markup, /New chat/)
  assert.match(markup, /Use in automation/)
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

console.log('connectors-panel render guard passed')
