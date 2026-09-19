// The registry read behind every connectors surface (the modal today, the
// Extensions door): `window.api.readMarketplaceRegistry`, the
// installable plugins. Extracted from ConnectorsPanel so the door surface and
// the modal read the exact same source, degrade the exact same way, and share
// the workspace `.mcp.json` sync — one implementation, two mounts.
//
// It read a second source until the third-party retirement
// (2026-09-08): `window.api.mcpListCatalog`, the bundled catalogue of sixteen
// servers nobody here wrote. That IPC is gone with the file, so the only MCP
// servers this hook knows about are the ones in the workspace's own settings.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { McpServerConfig, McpSettings } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { SourceLoad } from './connectorsFacets'

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: true, servers: {} }

export type ConnectorSources = {
  registryLoad: SourceLoad<MarketplacePluginEntry[]>
  registryUrl: string | null
  mcpSettings: McpSettings
  /** Enabled server ids from MCP settings — the `installed` predicate. */
  installedServerIds: ReadonlySet<string>
  upsertMcpServer: (server: McpServerConfig) => void
  loadRegistry: (forceRefresh?: boolean) => Promise<void>
}

export function useConnectorSources(activeWorkspaceRoot: string | null): ConnectorSources {
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)

  const [registryLoad, setRegistryLoad] = useState<SourceLoad<MarketplacePluginEntry[]>>({ status: 'loading' })
  const [registryUrl, setRegistryUrl] = useState<string | null>(null)

  const loadRegistry = useCallback(async (forceRefresh?: boolean) => {
    if (typeof window.api.readMarketplaceRegistry !== 'function') {
      // An older build with no registry API is not a hard failure — the
      // marketplace source degrades to a notice, so treat it as an empty,
      // reachable registry.
      setRegistryLoad({ status: 'ready', data: [] })
      return
    }
    // A refresh never re-enters `loading` (the door-substrate rule): once data
    // is on screen it stays up until the new read lands, so the post-install
    // force-refresh keeps the current grid (and the open install-confirmation
    // panel) mounted.
    setRegistryLoad((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    try {
      const result = await window.api.readMarketplaceRegistry(forceRefresh ? { forceRefresh: true } : undefined)
      if (result.ok) {
        // ok / empty / offline-with-cache all carry a (possibly stale) index.
        setRegistryUrl(result.registryUrl ?? null)
        setRegistryLoad({ status: 'ready', data: result.marketplace.plugins })
      } else {
        // Offline-with-no-cache, fetch-error, invalid-schema: the marketplace
        // source is down. This degrades to a notice on the surface, never a
        // silent empty grid.
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
    void loadRegistry()
  }, [loadRegistry])

  // Keep the active workspace's .mcp.json in step with an add/remove, so a
  // change here really lands in the workspace (not just UI state). Mirrors the
  // Settings MCPs sync; a no-op without a workspace or when sync is off.
  // Keyed on the serialized servers map rather than the mcpSettings object, so
  // an add/remove writes .mcp.json without re-syncing on every unrelated
  // app-settings render.
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

  return {
    registryLoad,
    registryUrl,
    mcpSettings,
    installedServerIds,
    upsertMcpServer,
    loadRegistry,
  }
}
