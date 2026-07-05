// Connectors surface — the browse / install / launch page for connectors, opened
// from the sidebar (T5) via the store `connectorsSurface` overlay. It is NOT a
// Settings tab: it is a WorkspaceManager-rendered overlay so it can receive
// `launchConnectorChat` (T1's single connector runtime) as a prop.
//
// Two real sources feed one faceted grid — the MCP catalog
// (`window.api.mcpListCatalog`, the launchable connectors) and the marketplace
// registry (`window.api.readMarketplaceRegistry`, installable mcp/skills plugins).
// The merge / facet / search / state-machine logic lives in the DOM-free
// `connectorsFacets` view-model; this file is presentation + IPC wiring only, and
// reuses the existing storefront pieces (McpCatalogTile/McpInfoPanel and the
// storefront PluginCard/PluginDetailPanel install-flow) rather than reimplementing
// install/trust logic.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { McpServerConfig, McpSettings } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  CloseIconButton,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  PrimaryButton,
  Spinner,
  StatusDot,
  TruncatedText,
} from '../../ui'
import {
  McpBrandIcon,
  McpCatalogTile,
  McpInfoPanel,
  mcpIconSlug,
  mcpServerFromCatalog,
} from '../../settings/McpCatalog'
import { PluginCard, PluginDetailPanel } from '../../settings/BrowseStorefront'
import {
  CONNECTOR_FACETS,
  deriveConnectorsView,
  type ConnectorEntry,
  type ConnectorFacet,
  type ConnectorsView,
  type SourceLoad,
} from './connectorsFacets'

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: true, servers: {} }

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type ConnectorsSurfaceProps = {
  // T1's connector runtime — spawns an isolated connector chat (worktree +
  // connector-only MCP + skill) for a launchable catalog entry.
  onLaunchConnector: (serverId: string) => void
  // Opens the automation-authoring flow seeded with this connector. The run
  // wiring lands in T8; this presents the route today.
  onUseInAutomation: (serverId: string) => void
  // Active workspace root for workspace-scoped installs / MCP sync; null with no
  // project open (install of workspace-scoped components is then blocked with an
  // honest hint by the reused storefront flow).
  activeWorkspaceRoot: string | null
}

// The overlay shell: reads open-state from the store so any surface (sidebar
// entry, command palette) opens it with one action, and owns the modal chrome
// (backdrop, Escape, focus capture + restore, scroll-lock). Renders nothing when
// closed, and only mounts the (catalog-fetching) body while open.
export default function ConnectorsSurface(props: ConnectorsSurfaceProps): JSX.Element | null {
  const open = useWorkspaceStore((s) => s.connectorsSurface.open)
  const closeConnectorsSurface = useWorkspaceStore((s) => s.closeConnectorsSurface)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const active = document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => {
      const node = surfaceRef.current
      if (node && !node.contains(document.activeElement)) node.focus()
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeConnectorsSurface()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      if (target && document.contains(target)) target.focus()
    }
  }, [open, closeConnectorsSurface])

  if (!open) return null

  const trapFocus = (position: 'start' | 'end') => () => {
    const root = surfaceRef.current
    if (!root) return
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute('data-focus-sentinel'),
    )
    if (focusables.length === 0) {
      root.focus()
      return
    }
    if (position === 'start') focusables[focusables.length - 1].focus()
    else focusables[0].focus()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connectors"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--surface-overlay-backdrop)] p-4 outline-none sm:p-8 lg:p-12"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeConnectorsSurface()
      }}
    >
      <div data-focus-sentinel="true" tabIndex={0} onFocus={trapFocus('start')} className="sr-only" />
      <div
        ref={surfaceRef}
        tabIndex={-1}
        className="flex h-full max-h-[min(760px,calc(100vh-2rem))] w-full max-w-[1080px] flex-col overflow-hidden rounded-[8px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-drawer)] outline-none"
      >
        <ConnectorsBrowser {...props} onClose={closeConnectorsSurface} />
      </div>
      <div data-focus-sentinel="true" tabIndex={0} onFocus={trapFocus('end')} className="sr-only" />
    </div>
  )
}

// The surface body: owns the two catalog reads (relocated from SettingsPanel's
// per-mount effects), search + facet state, and the grid/rows rendering.
function ConnectorsBrowser({
  onLaunchConnector,
  onUseInAutomation,
  activeWorkspaceRoot,
  onClose,
}: ConnectorsSurfaceProps & { onClose: () => void }) {
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)

  const [catalogLoad, setCatalogLoad] = useState<SourceLoad<McpCatalogServer[]>>({ status: 'loading' })
  const [registryLoad, setRegistryLoad] = useState<SourceLoad<MarketplacePluginEntry[]>>({ status: 'loading' })
  const [registryUrl, setRegistryUrl] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Land on the full browse grid; the launchable connectors already lead in the
  // dedicated "Ready to launch" rail above, so opening on the Featured filter
  // would just echo that rail.
  const [facet, setFacet] = useState<ConnectorFacet>('All')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const loadCatalog = useCallback(async () => {
    if (typeof window.api.mcpListCatalog !== 'function') {
      setCatalogLoad({ status: 'error', message: 'Connector catalog needs an app restart.' })
      return
    }
    setCatalogLoad({ status: 'loading' })
    try {
      const result = await window.api.mcpListCatalog()
      setCatalogLoad(
        result.ok ? { status: 'ready', data: result.servers } : { status: 'error', message: result.message },
      )
    } catch (error) {
      setCatalogLoad({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to load the connector catalog.',
      })
    }
  }, [])

  const loadRegistry = useCallback(async (forceRefresh?: boolean) => {
    if (typeof window.api.readMarketplaceRegistry !== 'function') {
      // An older build with no registry API is not a hard failure — the catalog
      // still carries the launchable connectors; the marketplace source degrades
      // to a notice, so treat it as an empty, reachable registry.
      setRegistryLoad({ status: 'ready', data: [] })
      return
    }
    setRegistryLoad({ status: 'loading' })
    try {
      const result = await window.api.readMarketplaceRegistry(forceRefresh ? { forceRefresh: true } : undefined)
      if (result.ok) {
        // ok / empty / offline-with-cache all carry a (possibly stale) index.
        setRegistryUrl(result.registryUrl ?? null)
        setRegistryLoad({ status: 'ready', data: result.marketplace.plugins })
      } else {
        // Offline-with-no-cache, fetch-error, invalid-schema: the marketplace
        // source is down. The catalog still carries the launchable connectors, so
        // this degrades to a notice on the surface, never a silent empty grid.
        setRegistryLoad({ status: 'error', message: result.message || 'Couldn’t reach the marketplace registry.' })
      }
    } catch (error) {
      setRegistryLoad({
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not read the marketplace registry.',
      })
    }
  }, [])

  useEffect(() => {
    void loadCatalog()
    void loadRegistry()
  }, [loadCatalog, loadRegistry])

  // Keep the active workspace's .mcp.json in step with catalog add/remove, so a
  // "Get" here really installs into the workspace (not just UI state). Mirrors the
  // Settings MCPs sync; a no-op without a workspace or when sync is off.
  // Keyed on the serialized servers map rather than the mcpSettings object, so a
  // "Get" (add/remove to active) here writes .mcp.json without re-syncing on
  // every unrelated app-settings render.
  const serverSnapshot = JSON.stringify(mcpSettings.servers)
  const mcpSettingsRef = useRef(mcpSettings)
  mcpSettingsRef.current = mcpSettings
  useEffect(() => {
    const settings = mcpSettingsRef.current
    if (!activeWorkspaceRoot || !settings.syncEnabled) return
    if (typeof window.api.mcpSync !== 'function') return
    void window.api.mcpSync({ workspaceRoot: activeWorkspaceRoot, settings }).catch(() => {})
  }, [activeWorkspaceRoot, serverSnapshot])

  const installedServerIds = useMemo(
    () => new Set(Object.keys(mcpSettings.servers).filter((id) => mcpSettings.servers[id]?.enabled)),
    [mcpSettings.servers],
  )

  const view = deriveConnectorsView(catalogLoad, registryLoad, installedServerIds, query, facet)

  // The launchable connectors (a search-filtered "ready to launch" rail), derived
  // from the same source merge but independent of the browse facet: they are your
  // runnable connectors, not a browse bucket.
  const readyConnectors = useMemo(() => {
    if (catalogLoad.status !== 'ready') return []
    const needle = query.trim().toLowerCase()
    return catalogLoad.data
      .filter((server) => Boolean(server.skill))
      .filter((server) =>
        !needle ||
        [server.name, server.category ?? '', server.description ?? '', ...(server.capabilities ?? [])].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      )
  }, [catalogLoad, query])

  const toggleCatalogServer = useCallback(
    (server: McpCatalogServer) => {
      if (mcpSettings.servers[server.id]?.enabled) removeMcpServer(server.id)
      else upsertMcpServer(mcpServerFromCatalog(server))
    },
    [mcpSettings.servers, removeMcpServer, upsertMcpServer],
  )

  const closeDetail = useCallback(() => setSelectedKey(null), [])

  const selectedEntry =
    view.status === 'ready' ? view.entries.find((entry) => entry.key === selectedKey) ?? null : null

  // A one-source-down degradation notice, present on the settled views only.
  const notice =
    view.status === 'ready' || view.status === 'empty' || view.status === 'no-match' ? view.notice : undefined

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
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-[color:var(--border-subtle)] px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-5 text-[color:var(--text-strong)]">Connectors</h2>
          <p className="mt-0.5 text-[12px] leading-4 text-[color:var(--text-subtle)]">
            Browse, install, and launch connectors — an isolated chat or an automation, scoped to its own worktree.
          </p>
        </div>
        <CloseIconButton onClick={onClose} aria-label="Close connectors" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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

        <FacetTabs view={view} facet={facet} onSelect={setFacet} />

        <ConnectorsBody
          view={view}
          registryUrl={registryUrl}
          workspaceRoot={activeWorkspaceRoot}
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
      </div>
    </div>
  )
}

// The "ready to launch" rail: your runnable connectors, each offering New chat
// (T1 runtime) and Use in automation. Hidden when none are ready.
export function ReadyConnectorsRail({
  connectors,
  onLaunchConnector,
  onUseInAutomation,
}: {
  connectors: McpCatalogServer[]
  onLaunchConnector: (serverId: string) => void
  onUseInAutomation: (serverId: string) => void
}) {
  if (connectors.length === 0) return null
  return (
    <section className="mt-4 space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-[12px] font-medium text-[color:var(--text-muted)]">Ready to launch</span>
        <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
        <span className="tabular-nums font-mono text-[10px] text-[color:var(--text-subtle)]">{connectors.length}</span>
      </div>
      <ul className="space-y-1">
        {connectors.map((server) => (
          <li
            key={server.id}
            className="group flex items-center gap-3 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2"
          >
            <McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} size={28} />
            <div className="min-w-0 flex-1">
              <TruncatedText
                as="div"
                text={server.name}
                className="text-[13px] font-semibold leading-5 text-[color:var(--text-strong)]"
              />
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
                <StatusDot tone="good" />
                <span>Connector ready</span>
              </div>
            </div>
            <div className="flex items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <GhostButton size="sm" onClick={() => onUseInAutomation(server.id)}>
                Use in automation
              </GhostButton>
              <PrimaryButton size="sm" onClick={() => onLaunchConnector(server.id)}>
                New chat
              </PrimaryButton>
            </div>
          </li>
        ))}
      </ul>
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
  const counts = view.status === 'ready' ? view.counts : null
  return (
    <div
      role="tablist"
      aria-label="Connector categories"
      className="mt-4 flex flex-wrap items-center gap-1 border-b border-[color:var(--border-subtle)] pb-2"
    >
      {CONNECTOR_FACETS.map((option) => {
        const active = option === facet
        const count = counts ? counts[option] : null
        return (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(option)}
            className={`interactive flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
              active
                ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
                : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-default)]'
            }`}
          >
            <span>{option}</span>
            {count !== null && count > 0 ? (
              <span className="tabular-nums font-mono text-[10px] text-[color:var(--text-subtle)]">{count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function ConnectorsBody({
  view,
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
  registryUrl: string | null
  workspaceRoot: string | null
  mcpSettings: McpSettings
  selectedKey: string | null
  selectedEntry: ConnectorEntry | null
  onSelect: (key: string) => void
  onCloseDetail: () => void
  onToggleCatalogServer: (server: McpCatalogServer) => void
  onLaunchConnector: (serverId: string) => void
  onUseInAutomation: (serverId: string) => void
  onUpsertMcpServer: (server: McpServerConfig) => void
  onRegistryInstalled: () => void
  retry: JSX.Element
}) {
  if (view.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-8 text-[12px] text-[color:var(--text-muted)]">
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
      <p className="px-1 py-10 text-center text-[12px] text-[color:var(--text-muted)]">
        No connectors are available yet.
      </p>
    )
  }

  if (view.status === 'no-match') {
    return (
      <p className="px-1 py-10 text-center text-[12px] text-[color:var(--text-muted)]">
        {view.query
          ? `No connectors match “${view.query}”${view.facet !== 'All' ? ` in ${view.facet}` : ''}.`
          : `No connectors in ${view.facet}.`}
      </p>
    )
  }

  const detailOpen = Boolean(selectedEntry)
  return (
    <div className="mt-4 flex gap-4">
      <div className={`grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-3 ${detailOpen ? '' : 'lg:grid-cols-4'}`}>
        {view.entries.map((entry) =>
          entry.source === 'catalog' && entry.catalogServer ? (
            <McpCatalogTile
              key={entry.key}
              server={entry.catalogServer}
              installed={entry.installed}
              selected={selectedKey === entry.key}
              onToggle={() => onToggleCatalogServer(entry.catalogServer!)}
              onInfo={() => onSelect(entry.key)}
            />
          ) : entry.plugin ? (
            <PluginCard
              key={entry.key}
              plugin={entry.plugin}
              registryUrl={registryUrl}
              selected={selectedKey === entry.key}
              onOpen={() => onSelect(entry.key)}
            />
          ) : null,
        )}
      </div>

      {selectedEntry && selectedEntry.source === 'catalog' && selectedEntry.catalogServer ? (
        <McpInfoPanel
          server={selectedEntry.catalogServer}
          installed={selectedEntry.installed}
          onToggle={() => onToggleCatalogServer(selectedEntry.catalogServer!)}
          onClose={onCloseDetail}
          onNewChat={selectedEntry.canLaunch ? () => onLaunchConnector(selectedEntry.id) : undefined}
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
