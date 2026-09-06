// Plugins: Installed, then one tab per source.
//
// Source-tabs ruling (2026-09-05). Two things about this view changed with it,
// beyond the navigation:
//
//   - MCP servers are folded INTO Plugins. They were a rail row of their own,
//     which asked a person to know that a connector is not a plugin before
//     they could look for one. A plugin is a bundle that usually ships an MCP
//     server, so a source's MCP servers are one more group inside it, and the
//     app's own catalogue keeps the registry's categories as its groups.
//   - The Featured facet is gone. It ranked the catalogue by "can this launch
//     right now", which is a fact about the machine rather than about the
//     catalogue, and it hid everything else behind a tab nobody chose.
//
// What did not change: the install flows. A registry entry still goes through
// the storefront's verify/trust/install panel, a source's plugin still goes
// through PluginDetailPane, and a catalogue MCP server is still added to MCP
// settings in place.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { InstalledPluginRecord, McpServerConfig, StudioPluginStatus } from '../../../../../../../shared/electron-api'
import {
  deriveStudioPluginRow,
  studioPluginRowMatches,
  STUDIO_PLUGIN_ID,
  type StudioPluginRow,
} from '../../../../../../../shared/studio-plugin'
import {
  STUDIO_SKILL_SOURCE_ID,
  SOURCE_SHAPE_LABEL,
  scanMcpServers,
  scanPlugins,
  linkedPluginShortfall,
  pluginNeedsRead,
  scanShape,
  summariseLinkedPlugins,
  type ScanResult,
  type ScannedMcpServer,
  type ScannedPlugin,
  type SkillHarness,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { GhostButton, InlineNotice, Spinner } from '../../../../ui'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { McpInfoPanel } from '../../../../settings/McpCatalog'
import { PluginDetailPanel } from '../../../../settings/BrowseStorefront'
import { ConnectorEntryRow, ConnectorRow } from '../../../../panels/ConnectorsPanel/ConnectorRow'
import { CustomMcpServerForm } from '../../../../panels/ConnectorsPanel/CustomMcpServerForm'
import { InstalledExtensionsInventory } from '../../../../panels/ConnectorsPanel/InstalledExtensionsInventory'
import {
  buildConnectorEntries,
  connectorEntryAsComposerConnector,
  searchConnectors,
  sectionConnectors,
  type ConnectorEntry,
} from '../../../../panels/ConnectorsPanel/connectorsFacets'
import { mcpServerConfigFromScanned } from '../../../../../../../shared/mcp/server-from-scanned'
import type { ConnectorSources } from '../../../../panels/ConnectorsPanel/useConnectorSources'
import type { AgentComposerConnector } from '../../../agentComposer/AgentComposer'
import { useWorkspaceStore } from '../../../../../store/workspaceStore'
import { SourceMonogram } from '../skills/SourceMonogram'
import { bundledScanLine, summarizeSyncRun } from '../skills/skillsSurfaceModel'
import type { SkillSourcesState } from '../skills/useSkillSources'
import { CatalogueHead, CatalogueSurface, type CatalogueAddMenu, type CatalogueSection } from '../catalogue/CatalogueSurface'
import { EXTENSIONS_DRAWER_VIEWS, dispatchExtensionsSurfaceTarget } from '../extensionsSurfaceTarget'
import {
  catalogueHoldingsLine,
  catalogueMonogram,
  catalogueStateLine,
  catalogueTabLabel,
  deriveCatalogueTabs,
  resolveCatalogueTab,
  INSTALLED_TAB_ID,
  type CatalogueCount,
} from '../catalogue/catalogueTabs'
import { SourceTabActions } from '../catalogue/SourceTabActions'
import { openGitHubSettings, useGitHubTokenConfigured } from '../catalogue/useGitHubToken'
import { PluginDetailPane } from './PluginDetailPane'
import {
  derivePluginInstallAvailability,
  derivePluginInstallState,
  derivePluginRows,
  findPlugin,
  pluginCommit,
  summarizePluginInstall,
  type PluginListItem,
} from './pluginsSurfaceModel'

const MISSING_API_MESSAGE = 'Plugins need an app restart before they are available.'

/** Every shape a row in this view can take; one union, so one pager walks them all. */
type PluginItem =
  | { kind: 'builtin'; row: StudioPluginRow }
  | { kind: 'connector'; entry: ConnectorEntry }
  | { kind: 'plugin'; item: PluginListItem }
  | { kind: 'server'; server: ScannedMcpServer }

type OpenRow = { kind: 'connector'; key: string } | { kind: 'plugin'; id: string }

export function PluginsCatalogue({
  sources,
  connectors,
  workspaceRoot,
  harnesses,
  activeTabId,
  onSelectTab,
  query,
  onQueryChange,
  add,
  addNotice,
  onDismissAddNotice,
  onAddMcpServers,
  onRemoveMcpServers,
  onLaunchConnector,
  onUseInAutomation,
}: {
  sources: SkillSourcesState
  /** The MCP catalogue and the marketplace registry, read once by the door. */
  connectors: ConnectorSources
  workspaceRoot: string | null
  harnesses: readonly SkillHarness[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  query: string
  onQueryChange: (value: string) => void
  add: CatalogueAddMenu
  /** A source that could not be added — stated where the person is looking. */
  addNotice: string | null
  onDismissAddNotice: () => void
  onAddMcpServers: (servers: McpServerConfig[]) => void
  onRemoveMcpServers: (serverIds: string[]) => void
  onLaunchConnector: (connector: AgentComposerConnector) => void
  onUseInAutomation: (serverId: string) => void
}): JSX.Element {
  const [openRow, setOpenRow] = useState<OpenRow | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const [readError, setReadError] = useState<{ pluginId: string; message: string } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [hooksAcknowledged, setHooksAcknowledged] = useState(false)
  const [report, setReport] = useState<{ sourceId: string; outcome: string | null; error: string | null } | null>(null)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  // The app's own plugin. Read once per workspace: it is installed by main when
  // the workspace opens, so by the time this surface can be looked at the answer
  // is already settled and re-polling it would only cost IPC.
  const [studioPluginStatus, setStudioPluginStatus] = useState<StudioPluginStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    if (typeof window.api.studioPluginStatus !== 'function') return
    void window.api
      .studioPluginStatus({ workspaceRoot })
      .then((status) => {
        if (!cancelled) setStudioPluginStatus(status)
      })
      // A status that cannot be read leaves the row out rather than rendering a
      // row that claims a version it does not know.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  const catalog = connectors.catalogLoad.status === 'ready' ? connectors.catalogLoad.data : []
  const registry = connectors.registryLoad.status === 'ready' ? connectors.registryLoad.data : []

  // The app's own catalogue holds both populations: the registry's plugins and
  // the MCP catalogue's servers. Its tab count is what the tab actually lists.
  const appEntries = useMemo(
    () => buildConnectorEntries(catalog, registry, connectors.installedServerIds),
    [catalog, registry, connectors.installedServerIds],
  )
  const appCount = useMemo<CatalogueCount>(() => {
    if (connectors.catalogLoad.status === 'loading' || connectors.registryLoad.status === 'loading') {
      return { status: 'loading' }
    }
    if (connectors.catalogLoad.status === 'error' && connectors.registryLoad.status === 'error') {
      return { status: 'error', message: 'The marketplace is unavailable.' }
    }
    return { status: 'ready', count: appEntries.length }
  }, [appEntries.length, connectors.catalogLoad, connectors.registryLoad])

  const counts = useMemo<Record<string, CatalogueCount>>(() => {
    const map: Record<string, CatalogueCount> = {}
    for (const source of sources.sources) {
      const load = sources.scans[source.id]
      // Our own plugin still counts — it IS a row, the built-in one. What is
      // not a row is the MCP server it declares: that server is part of that
      // plugin and is disclosed on its row, so listing it again would be one
      // thing counted twice (see `hiddenMcpFor` and the section builder).
      const mine = source.id === STUDIO_SKILL_SOURCE_ID
      const scanned: CatalogueCount =
        !load || load.status === 'loading'
          ? { status: 'loading' }
          : load.status === 'error'
            ? { status: 'error', message: load.message }
            : {
                status: 'ready',
                count:
                  scanPlugins(load.scan).length
                  + scanMcpServers(load.scan).filter((server) => server.declaredBy !== hiddenMcpFor(source.id)).length,
              }
      // Our own tab holds two populations, and the number on it has to be the
      // number of rows under it: the marketplace repository's plugins and
      // servers (studio-marketplace ruling, 2026-09-06) plus the signed
      // registry's entries, which a Claude marketplace cannot carry because
      // `component-trust.ts` refuses code-bearing components from any GitHub
      // source. Neither half is spoken while it is still unknown.
      map[source.id] = mine ? sumCounts(scanned, appCount) : scanned
    }
    return map
  }, [appCount, sources.scans, sources.sources])

  const mcpServers = useMemo(() => Object.values(connectors.mcpSettings.servers), [connectors.mcpSettings.servers])
  const tabs = deriveCatalogueTabs({
    kind: 'plugins',
    sources: sources.sources,
    installedCount: mcpServers.length,
    counts,
  })
  const tabId = resolveCatalogueTab(tabs, activeTabId)
  const activeSource = tabs.find((tab) => tab.id === tabId)?.source ?? null
  const activeScan = activeSource ? sources.scans[activeSource.id] : undefined
  const scan = activeScan && activeScan.status === 'ready' ? activeScan.scan : null

  // The tab being looked at is the one whose source is read. A repository that
  // has never been scanned is a network read, so it waits for this rather than
  // firing on mount for every source in the list (useSkillSources).
  const ensureScan = sources.ensureScan
  useEffect(() => {
    if (activeSource) ensureScan(activeSource.id)
  }, [activeSource, ensureScan])
  const isApp = activeSource?.id === STUDIO_SKILL_SOURCE_ID

  // ── Install / read / sync ──────────────────────────────────────────────────

  const readLinked = useCallback(
    async (source: SkillSource, plugin: ScannedPlugin): Promise<void> => {
      if (typeof window.api.skillsScanLinkedPlugin !== 'function') {
        setReadError({ pluginId: plugin.id, message: MISSING_API_MESSAGE })
        return
      }
      setReading(plugin.id)
      setReadError(null)
      try {
        const result = await window.api.skillsScanLinkedPlugin({ sourceId: source.id, pluginId: plugin.id })
        if (!result.ok) {
          setReadError({ pluginId: plugin.id, message: result.message })
          return
        }
        sources.applySync(result.source, result.scan)
      } catch (error) {
        setReadError({ pluginId: plugin.id, message: describe(error) })
      } finally {
        setReading((current) => (current === plugin.id ? null : current))
      }
    },
    [sources],
  )

  const openPluginRow = useCallback(
    (pluginId: string) => {
      setOpenRow({ kind: 'plugin', id: pluginId })
      setHooksAcknowledged(false)
      setReadError(null)
      if (!activeSource || !scan) return
      const plugin = findPlugin(scan, pluginId)
      // Only a LINKED plugin has a repository to go and read. An in-tree one
      // that the scan skipped for being past its plugin limit has nothing to
      // fetch, and asking main to read it returned the same unread plugin —
      // a spinner that resolved to no change, forever.
      //
      // A plugin the scan already FOLLOWED is read here too: the follow lists
      // components from the tree and fetches no skill's entry document, so this
      // is where the descriptions come from (linked-plugins review, 2026-09-06).
      if (plugin && pluginNeedsRead(plugin)) void readLinked(activeSource, plugin)
    },
    [activeSource, scan, readLinked],
  )

  const installPlugin = useCallback(
    async (source: SkillSource, plugin: ScannedPlugin): Promise<void> => {
      if (!workspaceRoot) return
      if (typeof window.api.skillsInstallPlugin !== 'function') {
        setReport({ sourceId: source.id, outcome: null, error: MISSING_API_MESSAGE })
        return
      }
      setInstalling(true)
      setReport(null)
      try {
        const result = await window.api.skillsInstallPlugin({
          sourceId: source.id,
          pluginId: plugin.id,
          workspaceRoot,
          acknowledgedHooks: hooksAcknowledged,
        })
        if (!result.ok) {
          setReport({ sourceId: source.id, outcome: null, error: result.message })
          // Main read the plugin to find those hooks and wrote the read back to
          // the store; without pulling it in, the pane keeps showing the plugin
          // that had no hooks to acknowledge and the refusal reads as a glitch
          // (linked-plugins review, 2026-09-06).
          if (result.needsHookAcknowledgement === true) await readLinked(source, plugin)
          return
        }
        if (result.mcpServers.length > 0) onAddMcpServers(result.mcpServers)
        setReport({ sourceId: source.id, outcome: summarizePluginInstall(result), error: null })
        sources.refreshInstalled()
      } catch (error) {
        setReport({ sourceId: source.id, outcome: null, error: describe(error) })
      } finally {
        setInstalling(false)
      }
    },
    [workspaceRoot, hooksAcknowledged, onAddMcpServers, sources, readLinked],
  )

  const uninstallPlugin = useCallback(
    async (source: SkillSource, record: InstalledPluginRecord): Promise<void> => {
      if (!workspaceRoot || typeof window.api.skillsUninstallPlugin !== 'function') return
      setInstalling(true)
      setReport(null)
      try {
        const result = await window.api.skillsUninstallPlugin({
          sourceId: record.sourceId,
          pluginId: record.pluginId,
          workspaceRoot,
        })
        if (!result.ok) {
          setReport({ sourceId: source.id, outcome: null, error: result.message })
          return
        }
        if (result.mcpServerIds.length > 0) onRemoveMcpServers(result.mcpServerIds)
        setReport({
          sourceId: source.id,
          outcome: [
            `Removed ${record.pluginName}${result.disabledClaudePluginKey ? ` and disabled ${result.disabledClaudePluginKey}` : ''}.`,
            // The copies are gone either way; a settings file that refused its
            // edit is said here rather than swallowed.
            ...result.warnings,
          ].join(' '),
          error: null,
        })
        sources.refreshInstalled()
      } catch (error) {
        setReport({ sourceId: source.id, outcome: null, error: describe(error) })
      } finally {
        setInstalling(false)
      }
    },
    [workspaceRoot, onRemoveMcpServers, sources],
  )

  /**
   * A source's MCP server, added to MCP settings from the row it sits on.
   *
   * Through the same mapping the plugin install uses, and carrying the same
   * provenance: the source, the server's id in its scan, and the commit that
   * scan was taken at. Without it a Sync could not tell this entry from one
   * typed by hand, which is the whole of
   * backlog/2026-09-06-mcp-installs-carry-source-provenance.md.
   */
  const addScannedServer = useCallback(
    (source: SkillSource, scanned: ScanResult, server: ScannedMcpServer) => {
      onAddMcpServers([
        mcpServerConfigFromScanned(server, ['codex', 'claude-code'], {
          sourceId: source.id,
          itemId: server.id,
          commitSha: scanned.commitSha,
        }),
      ])
    },
    [onAddMcpServers],
  )

  // ── Sections ───────────────────────────────────────────────────────────────

  const sections = useMemo<CatalogueSection<PluginItem>[]>(() => {
    if (!activeSource) return []
    // The built-in row leads our own tab: it is the one plugin every install
    // already has, and burying it under the marketplace's other entries would
    // put the app's own plugin somewhere a person has to search for it.
    const builtin = isApp ? deriveStudioPluginRow(studioPluginStatus) : null
    const builtinSection: CatalogueSection<PluginItem>[] =
      builtin && studioPluginRowMatches(builtin, query)
        ? [{ key: 'built-in', label: 'Built in', items: [{ kind: 'builtin' as const, row: builtin }] }]
        : []
    const needle = query.trim().toLowerCase()
    // What the source's REPOSITORY holds. Our own tab reads its marketplace
    // exactly like Anthropic's now, rather than being a registry view with a
    // different backend under Skills (studio-marketplace ruling, 2026-09-06).
    // Our own plugin is the built-in row above and nothing else. The
    // marketplace lists it like any other, but a second row for it would offer
    // an Install that cannot work: what we PUBLISH is a template, and its
    // `.mcp.json` and `hooks/hooks.json` carry `__MULTICODE_*` tokens that only
    // the app's own materialise step can fill in. The same goes for the MCP
    // server it declares — added from a row here it would be a server whose
    // command is the literal token.
    const hiddenMcp = hiddenMcpFor(activeSource.id)
    const plugins = scan
      ? derivePluginRows({ source: activeSource, scan, installed: sources.installedPlugins, query }).filter(
          (item) => !(isApp && item.pluginId === STUDIO_PLUGIN_ID),
        )
      : []
    const servers = scan
      ? scanMcpServers(scan).filter(
          (server) =>
            server.declaredBy !== hiddenMcp
            && (needle === '' || `${server.name} ${server.description} ${server.id}`.toLowerCase().includes(needle)),
        )
      : []
    // …and, on our tab only, the signed registry: the agent CLIs, automation
    // starters and signed modules a Claude marketplace cannot carry, under ONE
    // set of headings — the catalogue's own categories — rather than a
    // "Plugins" block and then the categories. Two sets would ask a person to
    // know which half a thing is in before they could look for it.
    const registrySections: CatalogueSection<PluginItem>[] = isApp
      ? sectionConnectors(searchConnectors(appEntries, query)).map((section) => ({
          key: section.title,
          label: section.title,
          items: section.entries.map((entry) => ({ kind: 'connector' as const, entry })),
        }))
      : []
    return [
      ...builtinSection,
      ...(plugins.length > 0
        ? [{ key: 'plugins', label: 'Plugins', items: plugins.map((item) => ({ kind: 'plugin' as const, item })) }]
        : []),
      ...(servers.length > 0
        ? [
            {
              key: 'mcp',
              label: 'MCP servers',
              items: servers.map((server) => ({ kind: 'server' as const, server })),
            },
          ]
        : []),
      ...registrySections,
    ]
  }, [activeSource, appEntries, isApp, query, scan, sources.installedPlugins, studioPluginStatus])

  // ── Rows ───────────────────────────────────────────────────────────────────

  const renderRow = useCallback(
    (item: PluginItem): React.ReactNode => {
      if (item.kind === 'builtin') {
        const row = item.row
        return (
          <ConnectorRow
            key="sprintengine-studio-builtin"
            icon={<SourceMonogram monogram="SS" size="lg" />}
            name={row.name}
            summary={row.summary}
            chips={row.chips}
            // No onOpen, no Install and no Remove: this plugin is not one a
            // person chose, so there is nothing here for them to undo. What the
            // row is for is saying it is there, and which version.
            actions={
              <span className="pr-1 text-meta font-medium text-[color:var(--text-muted)]">
                {row.updateAvailable ? 'Refreshes on reopen' : 'Always installed'}
              </span>
            }
          />
        )
      }
      if (item.kind === 'connector') {
        const entry = item.entry
        return (
          <ConnectorEntryRow
            key={entry.key}
            entry={entry}
            registryUrl={connectors.registryUrl}
            selected={openRow?.kind === 'connector' && openRow.key === entry.key}
            onOpen={() => setOpenRow({ kind: 'connector', key: entry.key })}
            onToggleInstalled={
              entry.source === 'catalog' && entry.catalogServer
                ? () => connectors.toggleCatalogServer(entry.catalogServer!)
                : undefined
            }
            onLaunch={entry.canLaunch ? () => onLaunchConnector(connectorEntryAsComposerConnector(entry)) : undefined}
          />
        )
      }
      if (item.kind === 'plugin') {
        const row = item.item
        return (
          <ConnectorRow
            key={row.pluginId}
            icon={<SourceMonogram monogram={initials(row.name)} size="lg" />}
            name={row.name}
            summary={row.description || row.components}
            chips={[
              'Plugin',
              // Said on the row, not only in the pane: the row already shows a
              // description for every linked entry the official marketplace
              // lists, so an unread one is otherwise indistinguishable from a
              // read one (linked-plugins ruling, 2026-09-06).
              ...(row.unread ? [row.unread] : []),
              ...(row.install.kind === 'installed' ? ['Installed'] : []),
              ...(row.install.kind === 'update-available' ? ['Update available'] : []),
            ]}
            selected={openRow?.kind === 'plugin' && openRow.id === row.pluginId}
            onOpen={() => openPluginRow(row.pluginId)}
            actions={
              <GhostButton
                size="sm"
                onClick={() => openPluginRow(row.pluginId)}
                className="border border-[color:var(--border-default)]"
                aria-label={`Open ${row.name}`}
              >
                {row.install.kind === 'not-installed' ? 'Install' : 'Open'}
              </GhostButton>
            }
          />
        )
      }
      const server = item.server
      const installed = connectors.installedServerIds.has(server.id)
      return (
        <ConnectorRow
          key={server.id}
          icon={<SourceMonogram monogram={initials(server.name)} size="lg" />}
          name={server.name}
          summary={server.description || server.declaredIn}
          chips={['MCP server']}
          actions={
            installed ? (
              <span className="pr-1 text-meta font-medium text-[color:var(--accent-primary)]">Added</span>
            ) : (
              <GhostButton
                size="sm"
                onClick={() => activeSource && scan && addScannedServer(activeSource, scan, server)}
                className="border border-[color:var(--border-default)]"
                aria-label={`Add ${server.name}`}
              >
                Add
              </GhostButton>
            )
          }
        />
      )
    },
    [activeSource, addScannedServer, connectors, onLaunchConnector, openPluginRow, openRow, scan],
  )

  // ── Head, notices, body, detail ────────────────────────────────────────────

  const thisReport = report?.sourceId === activeSource?.id ? report : null
  const head =
    tabId === INSTALLED_TAB_ID ? (
      <CatalogueHead
        name="Installed"
        stateLine={
          workspaceRoot
            ? 'The MCP servers configured on this machine, grouped by where they came from.'
            : 'The MCP servers configured on this machine. Open a workspace to install into one.'
        }
      />
    ) : activeSource ? (
      <CatalogueHead
        monogram={<SourceMonogram monogram={catalogueMonogram(activeSource)} size="lg" />}
        name={catalogueTabLabel(activeSource)}
        stateLine={
          <>
            <SourceStateLine
              source={activeSource}
              scan={scan}
              hiddenMcpPlugin={hiddenMcpFor(activeSource.id)}
              count={counts[activeSource.id] ?? { status: 'loading' }}
              outcome={thisReport?.outcome ?? null}
              onOpenUnderSkills={() => {
                // The tab has to be CHOSEN before the view changes: the open
                // tab is one piece of state across Plugins and Skills, and
                // while it is still the default nothing carries this source to
                // the other view — Skills would open on its own default and
                // the link would land somewhere else.
                onSelectTab(activeSource.id)
                dispatchExtensionsSurfaceTarget({ view: EXTENSIONS_DRAWER_VIEWS.skills })
              }}
            />
            {/* Our own tab also lists the signed registry, which is a second
                place these rows come from and therefore a second thing that
                can be unavailable. Named after the scan line, in the order the
                sections below it appear. */}
            {isApp ? ` · ${signedEntriesLine(appCount)} · ${registryOrigin(connectors.registryUrl)}` : null}
          </>
        }
        actions={
          <SourceTabActions
            source={activeSource}
            onSynced={(source, result) => {
              sources.applySync(source, result.scan)
              sources.refreshInstalled()
              setReport({ sourceId: source.id, outcome: summarizeSyncRun(result), error: null })
            }}
            onSyncFailed={(source, message) => setReport({ sourceId: source.id, outcome: null, error: message })}
            onRemoved={() => {
              sources.refreshSources()
              onSelectTab(STUDIO_SKILL_SOURCE_ID)
            }}
            workspaceRoot={workspaceRoot}
          />
        }
      />
    ) : null

  const notices = (
    <>
      {thisReport?.error ? <InlineNotice tone="error" title="That did not complete." hint={thisReport.error} /> : null}
      {addNotice ? (
        <InlineNotice
          tone="error"
          title="That source was not added."
          hint={addNotice}
          action={<GhostButton onClick={onDismissAddNotice}>Dismiss</GhostButton>}
        />
      ) : null}
      {sources.installedPluginsRead.status === 'error' ? (
        <InlineNotice tone="warn">
          {`Installed plugins in this workspace could not be read, so nothing is marked as installed: ${sources.installedPluginsRead.message}`}
        </InlineNotice>
      ) : null}
    </>
  )

  const body = ((): React.ReactNode => {
    if (tabId === INSTALLED_TAB_ID) {
      return (
        <div className="space-y-6">
          <InstalledExtensionsInventory
            mcpServers={mcpServers}
            moduleOverrides={moduleOverrides}
            workspaceRoot={workspaceRoot}
            catalogServers={catalog}
            registryPlugins={registry}
            registryUrl={connectors.registryUrl}
            mcpSettings={connectors.mcpSettings}
            cliAvailability={cliAvailability}
            kinds={['mcp']}
            sourceGrouping={{ sources: sources.sources, records: sources.installedPlugins }}
            paging={{ noun: 'MCP server', query }}
            onUpsertMcpServer={connectors.upsertMcpServer}
            onLaunchConnector={onLaunchConnector}
            onUseInAutomation={onUseInAutomation}
            onRemoveMcpServer={removeMcpServer}
          />
          <CustomMcpServerForm activeWorkspaceRoot={workspaceRoot} />
        </div>
      )
    }
    if (sources.sourcesLoad.status === 'error') {
      return (
        <InlineNotice
          tone="error"
          title="Your sources could not be read."
          hint="Nothing was changed. Try again, or add a source to start a fresh list."
          detail={sources.sourcesLoad.message}
          action={<GhostButton onClick={sources.refreshSources}>Try again</GhostButton>}
        />
      )
    }
    if (!activeSource) return <LoadingLine label="Loading sources…" />
    if (isApp) {
      if (appCount.status === 'loading') return <LoadingLine label="Reading the marketplace…" />
      if (appCount.status === 'error') {
        return (
          <InlineNotice
            tone="error"
            title="The marketplace is unavailable."
            hint="Its plugins and MCP servers are not listed below — this is not an empty catalogue."
            action={
              <GhostButton
                onClick={() => {
                  void connectors.loadCatalog()
                  void connectors.loadRegistry(true)
                }}
              >
                Try again
              </GhostButton>
            }
          />
        )
      }
      return null
    }
    if (!activeScan || activeScan.status === 'loading') {
      return <LoadingLine label={`Reading ${catalogueTabLabel(activeSource)}…`} />
    }
    if (activeScan.status === 'error') {
      return (
        <InlineNotice
          tone="error"
          title={`${catalogueTabLabel(activeSource)} could not be read.`}
          hint="Its plugins are not listed below — this is not an empty source."
          detail={activeScan.message}
          action={<GhostButton onClick={() => sources.refreshScan(activeSource.id)}>Try again</GhostButton>}
        />
      )
    }
    return null
  })()

  const openConnector =
    openRow?.kind === 'connector' ? appEntries.find((entry) => entry.key === openRow.key) ?? null : null
  const openPlugin = scan && openRow?.kind === 'plugin' ? findPlugin(scan, openRow.id) : null
  const marketplaceName = scan?.marketplaceName ?? ''

  const detail = openConnector ? (
    openConnector.source === 'catalog' && openConnector.catalogServer ? (
      <McpInfoPanel
        server={openConnector.catalogServer}
        installed={openConnector.installed}
        onToggle={() => connectors.toggleCatalogServer(openConnector.catalogServer!)}
        onClose={() => setOpenRow(null)}
        onNewChat={
          openConnector.canLaunch
            ? () => onLaunchConnector(connectorEntryAsComposerConnector(openConnector))
            : undefined
        }
        onUseInAutomation={openConnector.canLaunch ? () => onUseInAutomation(openConnector.id) : undefined}
      />
    ) : openConnector.plugin ? (
      <PluginDetailPanel
        key={openConnector.plugin.id}
        plugin={openConnector.plugin}
        registryUrl={connectors.registryUrl}
        workspaceRoot={workspaceRoot}
        mcpSettings={connectors.mcpSettings}
        onInstalled={() => void connectors.loadRegistry(true)}
        onUpsertMcpServer={connectors.upsertMcpServer}
        onClose={() => setOpenRow(null)}
      />
    ) : null
  ) : activeSource && scan && openPlugin ? (
    <PluginDetailPane
      source={activeSource}
      shape={scanShape(scan)}
      marketplaceName={marketplaceName}
      plugin={openPlugin}
      reading={reading === openPlugin.id}
      readError={readError?.pluginId === openPlugin.id ? readError.message : null}
      onRetryRead={() => void readLinked(activeSource, openPlugin)}
      harnesses={harnesses}
      install={derivePluginInstallState(
        sources.installedPlugins,
        activeSource.id,
        openPlugin,
        marketplaceName,
        pluginCommit(openPlugin, activeSource),
      )}
      availability={derivePluginInstallAvailability(workspaceRoot, openPlugin, harnesses, hooksAcknowledged)}
      installing={installing}
      hooksAcknowledged={hooksAcknowledged}
      onHooksAcknowledgedChange={setHooksAcknowledged}
      onInstall={() => void installPlugin(activeSource, openPlugin)}
      onUninstall={(record) => void uninstallPlugin(activeSource, record)}
      onClose={() => setOpenRow(null)}
    />
  ) : null

  return (
    <CatalogueSurface<PluginItem>
      title="Plugins"
      tabs={tabs}
      activeTabId={tabId}
      onSelectTab={(next) => {
        setOpenRow(null)
        onSelectTab(next)
      }}
      search={{ query, onQueryChange, placeholder: 'Search this tab' }}
      add={add}
      head={head}
      notices={notices}
      body={body}
      sections={sections}
      renderRow={renderRow}
      noun="plugin"
      detail={detail}
    />
  )
}

/**
 * What a source's tab is showing, in the nouns of the things themselves:
 * "Claude Code plugin marketplace · 292 plugins · 15 MCP servers · 31 skills".
 *
 * The skills are the link, not a number in a sentence: they are real things in
 * this repository that this catalogue does not list, and the tab that does list
 * them is one view away with the same source already open (official-plugins
 * ruling, 2026-09-06). Before it, both were totalled into "292 listings", and
 * "listing" is a word for a row rather than for a thing you can install — the
 * owner read `anthropics/skills`'s five plugin bundles as five skills.
 *
 * The line also admits when the scan was partial. A marketplace whose plugins
 * live in other repositories is read within a budget, and without a GitHub
 * token that budget is twenty repositories a scan — so the shortfall is stated
 * here, and the words that name the fix ARE the button that opens it
 * (linked-plugins ruling, 2026-09-06). A source that read them all says
 * nothing extra: the counts beside it already stand.
 */
/**
 * Two counts of the same tab's rows, added — and honest about not knowing yet.
 * A tab that speaks a total while half of it is still loading would count up
 * under the person as the second half arrived; a half that failed is stated as
 * the failure, because the number would otherwise be short by an unknown
 * amount and read as complete.
 */
function sumCounts(left: CatalogueCount, right: CatalogueCount): CatalogueCount {
  if (left.status === 'loading' || right.status === 'loading') return { status: 'loading' }
  if (left.status === 'error') return left
  if (right.status === 'error') return right
  return { status: 'ready', count: left.count + right.count }
}

/**
 * The signed registry's own count, in a noun that pluralises. `catalogueStateLine`
 * adds an `s`, which turned "signed entry" into "signed entrys" on screen.
 */
function signedEntriesLine(count: CatalogueCount): string {
  if (count.status === 'loading') return 'Loading…'
  if (count.status === 'error') return count.message
  return count.count === 0
    ? 'No signed entries here'
    : `${count.count} signed ${count.count === 1 ? 'entry' : 'entries'}`
}

/**
 * The plugin whose declared MCP servers this tab does NOT draw as rows of their
 * own, or '' when every server is drawn.
 *
 * Only ever our own plugin, on our own tab. Its server is the bridge to this
 * running app: it is disclosed on the built-in row, it cannot be "added"
 * (the published `.mcp.json` is a template carrying `__MULTICODE_*` tokens
 * only the app's install can fill in), and drawing it would be the same thing
 * counted twice — once as the plugin, once as its contents.
 */
function hiddenMcpFor(sourceId: string): string {
  return sourceId === STUDIO_SKILL_SOURCE_ID ? STUDIO_PLUGIN_ID : ''
}

function SourceStateLine({
  source,
  scan,
  hiddenMcpPlugin,
  count,
  outcome,
  onOpenUnderSkills,
}: {
  source: SkillSource
  /** The source's scan once it is in hand; null while loading or failed. */
  scan: ScanResult | null
  /** See `hiddenMcpFor`: servers this tab does not draw are not named here either. */
  hiddenMcpPlugin: string
  count: CatalogueCount
  /** What the last Sync on this source reported, when it was this one. */
  outcome: string | null
  onOpenUnderSkills: () => void
}): JSX.Element {
  // Read before the early return, because it is a hook: null while the answer
  // is on its way, and the shortfall clause holds its tongue until it lands
  // rather than telling somebody to add a token they already added.
  const tokenConfigured = useGitHubTokenConfigured()
  // A count is never spoken while it is unknown: a scan still loading, or one
  // that failed, says that instead — the tab-row rule, unchanged.
  if (!scan) {
    return <>{[catalogueStateLine(count, 'listing'), outcome].filter(Boolean).join(' · ')}</>
  }
  const plugins = scanPlugins(scan).length
  const servers = scanMcpServers(scan).filter((server) => server.declaredBy !== hiddenMcpPlugin).length
  const skills = scan.skills.length
  const holdings = catalogueHoldingsLine([
    [plugins, 'plugin', 'plugins'],
    [servers, 'MCP server', 'MCP servers'],
  ])
  const shortfall =
    tokenConfigured === null ? [] : linkedPluginShortfall(summariseLinkedPlugins(scan), tokenConfigured)
  const bundled = bundledScanLine(scan)
  return (
    <>
      {SOURCE_SHAPE_LABEL[scanShape(scan)]}
      {bundled ? ` · ${bundled}` : null}
      {holdings ? ` · ${holdings}` : ` · ${catalogueStateLine({ status: 'ready', count: 0 }, 'plugin')}`}
      {skills > 0 ? (
        <>
          {' · '}
          <button
            type="button"
            onClick={onOpenUnderSkills}
            aria-label={`Open the ${skills} skills in ${catalogueTabLabel(source)} under Skills`}
            className={`interactive rounded-[3px] text-meta text-[color:var(--accent-primary)] hover:underline ${FOCUS_RING_CLASS}`}
          >
            {catalogueHoldingsLine([[skills, 'skill', 'skills']])}
          </button>
        </>
      ) : null}
      {shortfall.map((part) => (
        <React.Fragment key={part.text}>
          {' · '}
          {part.action === 'github-settings' ? (
            <button
              type="button"
              onClick={openGitHubSettings}
              className={`interactive rounded-[3px] text-meta text-[color:var(--accent-primary)] hover:underline ${FOCUS_RING_CLASS}`}
            >
              {part.text}
            </button>
          ) : (
            <span className="text-[color:var(--text-muted)]">{part.text}</span>
          )}
        </React.Fragment>
      ))}
      {outcome ? ` · ${outcome}` : null}
    </>
  )
}

function LoadingLine({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
      <Spinner size={14} />
      {label}
    </div>
  )
}

/** Two letters for a row with no artwork of its own — the source-badge rule. */
function initials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}

/** Where the catalogue is published from, said as a repository rather than a URL. */
function registryOrigin(url: string | null): string {
  if (!url) return 'bundled with the app'
  const repo = url.match(/githubusercontent\.com\/([^/]+\/[^/]+)\//)
  return repo ? repo[1] : url
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
