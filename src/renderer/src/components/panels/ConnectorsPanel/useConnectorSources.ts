// The two catalog reads behind every connectors surface (the modal today, the
// Extensions door in MC-1847): the MCP catalog (`window.api.mcpListCatalog`,
// the launchable connectors) and the marketplace registry
// (`window.api.readMarketplaceRegistry`, installable plugins). Extracted from
// ConnectorsPanel so the door surface and the modal read the exact same
// sources, degrade the exact same way, and share the workspace `.mcp.json`
// sync — one implementation, two mounts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { McpServerConfig, McpSettings } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { mcpServerFromCatalog } from '../../settings/McpCatalog'
import type { SourceLoad } from './connectorsFacets'

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: true, servers: {} }

export type ConnectorSources = {
  catalogLoad: SourceLoad<McpCatalogServer[]>
  registryLoad: SourceLoad<MarketplacePluginEntry[]>
  registryUrl: string | null
  mcpSettings: McpSettings
  /** Enabled server ids from MCP settings — the `installed` predicate. */
  installedServerIds: ReadonlySet<string>
  upsertMcpServer: (server: McpServerConfig) => void
  /** Add/remove a catalog entry from the workspace's MCP settings. */
  toggleCatalogServer: (server: McpCatalogServer) => void
  loadCatalog: () => Promise<void>
  loadRegistry: (forceRefresh?: boolean) => Promise<void>
}

export function useConnectorSources(activeWorkspaceRoot: string | null): ConnectorSources {
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)

  const [catalogLoad, setCatalogLoad] = useState<SourceLoad<McpCatalogServer[]>>({ status: 'loading' })
  const [registryLoad, setRegistryLoad] = useState<SourceLoad<MarketplacePluginEntry[]>>({ status: 'loading' })
  const [registryUrl, setRegistryUrl] = useState<string | null>(null)

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

  const toggleCatalogServer = useCallback(
    (server: McpCatalogServer) => {
      if (mcpSettings.servers[server.id]?.enabled) removeMcpServer(server.id)
      else upsertMcpServer(mcpServerFromCatalog(server))
    },
    [mcpSettings.servers, removeMcpServer, upsertMcpServer],
  )

  return {
    catalogLoad,
    registryLoad,
    registryUrl,
    mcpSettings,
    installedServerIds,
    upsertMcpServer,
    toggleCatalogServer,
    loadCatalog,
    loadRegistry,
  }
}
