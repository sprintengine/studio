// The Browse half of the connectors surface — search, the Ready-to-launch rail,
// facet tabs, and the faceted category grid with its reused detail panels.
// Extracted from ConnectorsPanel (MC-1847) so the modal and the Extensions door
// render the identical canvas; this file owns presentation over the shared
// `useConnectorSources` reads, and the merge/facet/search logic stays in the
// DOM-free `connectorsFacets` view-model.

import React, { useCallback, useMemo, useState } from 'react'

import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../workspace/agentComposer/AgentComposer'
import type { McpServerConfig, McpSettings } from '../../../types/workspace'
import {
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  PrimaryButton,
  Spinner,
  StatusDot,
  Tabs,
  TabPanel,
  type TabItem,
  TruncatedText,
} from '../../ui'
import { McpBrandIcon, McpInfoPanel, mcpIconSlug } from '../../settings/McpCatalog'
import { PluginDetailPanel } from '../../settings/BrowseStorefront'
import { ConnectorEntryRow, ConnectorSectionHeading } from './ConnectorRow'
import {
  CONNECTOR_FACETS,
  catalogServerAsComposerConnector,
  connectorEntryAsComposerConnector,
  deriveConnectorsView,
  launchableConnectors,
  sectionConnectors,
  type ConnectorEntry,
  type ConnectorFacet,
  type ConnectorSection,
  type ConnectorsView,
} from './connectorsFacets'
import type { ConnectorSources } from './useConnectorSources'

// Shared id prefix so the facet Tabs' aria-controls resolves to the grid's
// TabPanel below.
const FACET_TABS_PREFIX = 'connectors-facets'

// The canvas's browsing state (search, facet, open detail), owned by the HOST
// surface rather than the canvas itself: the modal keeps it above its
// Browse/Installed TabPanels (which unmount their inactive child) so switching
// views and back never loses the search, and the door keys it per rail row.
export type ConnectorsBrowseState = {
  query: string
  setQuery: (value: string) => void
  facet: ConnectorFacet
  setFacet: (facet: ConnectorFacet) => void
  selectedKey: string | null
  setSelectedKey: (key: string | null) => void
}

export function useConnectorsBrowseState(initialFacet: ConnectorFacet = 'All'): ConnectorsBrowseState {
  const [query, setQuery] = useState('')
  // 'All' is the modal default — the launchable connectors already lead in the
  // dedicated Ready-to-launch rail, so opening on Featured would just echo it.
  const [facet, setFacet] = useState<ConnectorFacet>(initialFacet)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  return { query, setQuery, facet, setFacet, selectedKey, setSelectedKey }
}

// The browse canvas: search + degradation notice + Ready-to-launch rail + facet
// tabs + the category grid. The sources and browse state come from the host
// surface so the modal and the door share one load and own state lifetime.
export function ConnectorsBrowseCanvas({
  sources,
  state,
  workspaceRoot,
  onLaunchConnector,
  onUseInAutomation,
}: {
  sources: ConnectorSources
  state: ConnectorsBrowseState
  workspaceRoot: string | null
  onLaunchConnector: (connector: AgentComposerConnector) => void
  onUseInAutomation: (serverId: string) => void
}): JSX.Element {
  const { catalogLoad, registryLoad, registryUrl, mcpSettings, installedServerIds, upsertMcpServer, toggleCatalogServer, loadCatalog, loadRegistry } = sources
  const { query, setQuery, facet, setFacet, selectedKey, setSelectedKey } = state

  const browseView = deriveConnectorsView(catalogLoad, registryLoad, installedServerIds, query, facet)

  // The launchable connectors (a search-filtered "ready to launch" rail), derived
  // independently of the browse facet: they are your runnable connectors, not a
  // browse bucket. launchableConnectors owns the population (skill-paired
  // catalog entries ∪ installed servers); a failed catalog load degrades to the
  // installed servers alone, which launch without the catalog — only the
  // initial load renders the rail empty.
  const readyConnectors = useMemo(() => {
    if (catalogLoad.status === 'loading') return []
    const catalog = catalogLoad.status === 'ready' ? catalogLoad.data : []
    const needle = query.trim().toLowerCase()
    return launchableConnectors(catalog, mcpSettings.servers).filter(
      (server) =>
        !needle ||
        [server.name, server.category ?? '', server.description ?? '', ...(server.capabilities ?? [])].some((field) =>
          field.toLowerCase().includes(needle),
        ),
    )
  }, [catalogLoad, query, mcpSettings.servers])

  const closeDetail = useCallback(() => setSelectedKey(null), [])

  const selectedEntry =
    browseView.status === 'ready' ? browseView.entries.find((entry) => entry.key === selectedKey) ?? null : null

  // A one-source-down degradation notice, present on the settled views only.
  const notice =
    browseView.status === 'ready' || browseView.status === 'empty' || browseView.status === 'no-match'
      ? browseView.notice
      : undefined

  const retry = (
    <GhostButton
      size="sm"
      onClick={() => {
        void loadCatalog()
        void loadRegistry(true)
      }}
      className="border border-[color:var(--border-default)]"
    >
      Retry
    </GhostButton>
  )

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <InboxSearchInput
            value={query}
            onChange={setQuery}
            ariaLabel="Search connectors by name, category, or capability"
            placeholder="Search connectors, skills, MCPs"
          />
        </div>
      </div>

      {notice ? (
        <div className="mt-3">
          <InlineNotice tone="warn" action={retry}>
            {notice}
          </InlineNotice>
        </div>
      ) : null}

      <ReadyConnectorsRail
        connectors={readyConnectors}
        onLaunchConnector={onLaunchConnector}
        onUseInAutomation={onUseInAutomation}
      />

      <FacetTabs view={browseView} facet={facet} onSelect={setFacet} />

      <TabPanel idPrefix={FACET_TABS_PREFIX} tabId={facet} active>
        <ConnectorsBody
          view={browseView}
          facet={facet}
          registryUrl={registryUrl}
          workspaceRoot={workspaceRoot}
          mcpSettings={mcpSettings}
          selectedKey={selectedKey}
          selectedEntry={selectedEntry}
          onSelect={setSelectedKey}
          onCloseDetail={closeDetail}
          onToggleCatalogServer={toggleCatalogServer}
          onLaunchConnector={onLaunchConnector}
          onUseInAutomation={onUseInAutomation}
          onUpsertMcpServer={upsertMcpServer}
          onRegistryInstalled={() => void loadRegistry(true)}
          retry={retry}
        />
      </TabPanel>
    </>
  )
}

// How many launchable rows the rail shows before its "Show N more" toggle —
// tighter than SECTION_COLLAPSE_LIMIT because each row carries two actions and
// the rail sits above the whole browse grid (MC-1847 A1).
const READY_COLLAPSE_LIMIT = 4

// The "ready to launch" rail: your runnable connectors, each offering New chat
// (T1 runtime) and Use in automation. Hidden when none are ready; collapses
// past READY_COLLAPSE_LIMIT so a long launchable list never pushes the browse
// grid off-screen.
export function ReadyConnectorsRail({
  connectors,
  onLaunchConnector,
  onUseInAutomation,
}: {
  connectors: McpCatalogServer[]
  onLaunchConnector: (connector: AgentComposerConnector) => void
  onUseInAutomation: (serverId: string) => void
}) {
  const [showAll, setShowAll] = useState(false)
  if (connectors.length === 0) return null
  const visible = showAll ? connectors : connectors.slice(0, READY_COLLAPSE_LIMIT)
  const hiddenCount = connectors.length - visible.length
  return (
    <section className="mt-4 space-y-2">
      <ConnectorSectionHeading label="Ready to launch" count={connectors.length} />
      <ul className="space-y-1">
        {visible.map((server) => (
          <li
            key={server.id}
            className="group flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-[color:var(--bg-hover)]"
          >
            <McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} icon={server.icon} size={28} />
            <div className="min-w-0 flex-1">
              <TruncatedText
                as="div"
                text={server.name}
                className="text-body font-semibold leading-5 text-[color:var(--text-strong)]"
              />
              <div className="mt-0.5 flex items-center gap-1.5 text-meta leading-4 text-[color:var(--text-subtle)]">
                <StatusDot tone="good" />
                <span>Connector ready</span>
              </div>
            </div>
            <div className="flex items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <GhostButton size="sm" onClick={() => onUseInAutomation(server.id)}>
                Use in automation
              </GhostButton>
              <PrimaryButton size="sm" onClick={() => onLaunchConnector(catalogServerAsComposerConnector(server))}>
                New chat
              </PrimaryButton>
            </div>
          </li>
        ))}
      </ul>
      {connectors.length > READY_COLLAPSE_LIMIT ? (
        <GhostButton size="sm" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show fewer' : `Show ${hiddenCount} more`}
        </GhostButton>
      ) : null}
    </section>
  )
}

export function FacetTabs({
  view,
  facet,
  onSelect,
}: {
  view: ConnectorsView
  facet: ConnectorFacet
  onSelect: (facet: ConnectorFacet) => void
}) {
  // The shared Tabs primitive owns the WAI-ARIA tablist contract (roving tab
  // stop, Home/End/Arrow navigation, aria-controls to the panel below). Counts
  // come from the search-filtered view; a zero facet drops its count rather than
  // showing "0".
  const counts = view.status === 'ready' ? view.counts : null
  const items: TabItem<ConnectorFacet>[] = CONNECTOR_FACETS.map((option) => ({
    id: option,
    label: option,
    count: counts && counts[option] > 0 ? counts[option] : undefined,
  }))
  return (
    <div className="mt-4">
      <Tabs
        ariaLabel="Connector categories"
        idPrefix={FACET_TABS_PREFIX}
        items={items}
        value={facet}
        onChange={onSelect}
      />
    </div>
  )
}

export function ConnectorsBody({
  view,
  facet,
  registryUrl,
  workspaceRoot,
  mcpSettings,
  selectedKey,
  selectedEntry,
  onSelect,
  onCloseDetail,
  onToggleCatalogServer,
  onLaunchConnector,
  onUseInAutomation,
  onUpsertMcpServer,
  onRegistryInstalled,
  retry,
}: {
  view: ConnectorsView
  facet: ConnectorFacet
  registryUrl: string | null
  workspaceRoot: string | null
  mcpSettings: McpSettings
  selectedKey: string | null
  selectedEntry: ConnectorEntry | null
  onSelect: (key: string) => void
  onCloseDetail: () => void
  onToggleCatalogServer: (server: McpCatalogServer) => void
  onLaunchConnector: (connector: AgentComposerConnector) => void
  onUseInAutomation: (serverId: string) => void
  onUpsertMcpServer: (server: McpServerConfig) => void
  onRegistryInstalled: () => void
  retry: JSX.Element
}) {
  if (view.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
        <Spinner size={14} />
        Loading connectors…
      </div>
    )
  }

  if (view.status === 'error') {
    return (
      <div className="py-4">
        <InlineNotice tone="error" action={retry}>
          {view.message}
        </InlineNotice>
      </div>
    )
  }

  if (view.status === 'empty') {
    return (
      <p className="px-1 py-10 text-center text-body text-[color:var(--text-muted)]">
        No connectors are available yet.
      </p>
    )
  }

  if (view.status === 'no-match') {
    return (
      <p className="px-1 py-10 text-center text-body text-[color:var(--text-muted)]">
        {view.query
          ? `No connectors match “${view.query}”${view.facet !== 'All' ? ` in ${view.facet}` : ''}.`
          : `No connectors in ${view.facet}.`}
      </p>
    )
  }

  const detailOpen = Boolean(selectedEntry)
  const sections = sectionConnectors(view.entries, facet)
  const renderRow = (entry: ConnectorEntry) => (
    <ConnectorEntryRow
      key={entry.key}
      entry={entry}
      registryUrl={registryUrl}
      selected={selectedKey === entry.key}
      onOpen={() => onSelect(entry.key)}
      onToggleInstalled={
        entry.source === 'catalog' && entry.catalogServer
          ? () => onToggleCatalogServer(entry.catalogServer!)
          : undefined
      }
      onLaunch={entry.canLaunch ? () => onLaunchConnector(connectorEntryAsComposerConnector(entry)) : undefined}
    />
  )
  return (
    <div className="mt-4 flex gap-4">
      <div className="min-w-0 flex-1 space-y-5">
        {sections.map((section) => (
          <ConnectorSectionBlock
            key={section.title}
            section={section}
            detailOpen={detailOpen}
            renderRow={renderRow}
          />
        ))}
      </div>

      {selectedEntry && selectedEntry.source === 'catalog' && selectedEntry.catalogServer ? (
        <McpInfoPanel
          server={selectedEntry.catalogServer}
          installed={selectedEntry.installed}
          onToggle={() => onToggleCatalogServer(selectedEntry.catalogServer!)}
          onClose={onCloseDetail}
          onNewChat={
            selectedEntry.canLaunch
              ? () => onLaunchConnector(connectorEntryAsComposerConnector(selectedEntry))
              : undefined
          }
          onUseInAutomation={selectedEntry.canLaunch ? () => onUseInAutomation(selectedEntry.id) : undefined}
        />
      ) : selectedEntry && selectedEntry.plugin ? (
        <PluginDetailPanel
          key={selectedEntry.plugin.id}
          plugin={selectedEntry.plugin}
          registryUrl={registryUrl}
          workspaceRoot={workspaceRoot}
          mcpSettings={mcpSettings}
          onInstalled={onRegistryInstalled}
          onUpsertMcpServer={onUpsertMcpServer}
          onClose={onCloseDetail}
        />
      ) : null}
    </div>
  )
}

// How many rows a collapsed section shows before its "Show N more" toggle.
const SECTION_COLLAPSE_LIMIT = 6

// One category section: the shared heading treatment (label · hairline · count)
// over a two-column row list. The show-all state is local to the section, and the
// section remounts (keyed by title) when the facet or search changes the set.
function ConnectorSectionBlock({
  section,
  detailOpen,
  renderRow,
}: {
  section: ConnectorSection
  detailOpen: boolean
  renderRow: (entry: ConnectorEntry) => JSX.Element
}) {
  const [showAll, setShowAll] = useState(false)
  const expanded = section.expanded || showAll
  const visible = expanded ? section.entries : section.entries.slice(0, SECTION_COLLAPSE_LIMIT)
  const hiddenCount = section.entries.length - visible.length
  return (
    <section className="space-y-2">
      <ConnectorSectionHeading label={section.title} count={section.entries.length} />
      <div className={`grid gap-2 ${detailOpen ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
        {visible.map(renderRow)}
      </div>
      {!section.expanded && section.entries.length > SECTION_COLLAPSE_LIMIT ? (
        <GhostButton size="sm" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show fewer' : `Show ${hiddenCount} more`}
        </GhostButton>
      ) : null}
    </section>
  )
}
