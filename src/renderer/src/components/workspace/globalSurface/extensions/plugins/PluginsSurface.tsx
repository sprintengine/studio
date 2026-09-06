// Plugins: a surface you enter, and it holds the same sources Skills holds.
//
// A plugin is a bundle of the other kinds — skills, commands, agents, hooks,
// MCP servers — in Claude Code's shape, and a source lists its plugins from
// its own `.claude-plugin/marketplace.json` (backlog/2026-09-05-plugin-sources.md).
// The nested Sources rail is shared with Skills; the chosen source survives a
// switch between the two kinds because the door holds it.
//
// Sources are app-level; installing is workspace-level (the door can be open
// with no workspace, and Install says so rather than doing nothing).

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { InstalledPluginRecord, McpServerConfig, McpSettings } from '../../../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../../../shared/marketplace/manifest'
import {
  BUILTIN_SKILL_SOURCE_ID,
  SOURCE_SHAPE_LABEL,
  scanPlugins,
  scanShape,
  type ScannedPlugin,
  type SkillHarness,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { PlusIcon } from '../../../../AppIcons'
import { PluginDetailPanel } from '../../../../settings/BrowseStorefront'
import { GhostButton, InboxSearchInput, InlineNotice, OutlineButton, Spinner } from '../../../../ui'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { formatRelativeTime } from '../../../../../utils/time'
import { SurfaceCanvasState } from '../../surfaceSubstrate'
import { AddSkillSourceModal } from '../skills/AddSkillSourceModal'
import { addedRepoKeys } from '../skills/discoverModel'
import { SkillsDiscover } from '../skills/SkillsDiscover'
import { SourceMonogram } from '../skills/SourceMonogram'
import {
  shortCommit,
  sourceDisplayMonogram,
  sourceDisplayName,
  summarizeSyncRun,
} from '../skills/skillsSurfaceModel'
import type { SkillSourcesState } from '../skills/useSkillSources'
import { SourcesRail } from '../sources/SourcesRail'
import { PluginDetailPane } from './PluginDetailPane'
import { PluginRow } from './PluginRow'
import {
  derivePluginInstallAvailability,
  derivePluginInstallState,
  derivePluginRows,
  deriveRegistryPluginRows,
  findPlugin,
  pluginCommit,
  pluginCountLine,
  pluralPlugins,
  summarizePluginInstall,
} from './pluginsSurfaceModel'

const MISSING_API_MESSAGE = 'Plugins need an app restart before they are available.'

export function PluginsSurface({
  sources,
  workspaceRoot,
  harnesses,
  selectedSourceId,
  onSelectSource,
  onBrowseSkills,
  onAddMcpServers,
  onRemoveMcpServers,
  onConfigureGitHubToken,
  registry,
}: {
  /** Owned by the door, so its rail row can state the same counts this does. */
  sources: SkillSourcesState
  workspaceRoot: string | null
  /**
   * The Multicode source's plugins: the marketplace registry, read by the door
   * (backlog/2026-09-05-plugin-sources.md, "Hosting"). Its entries install
   * through the storefront flow — verify, trust, install — so a registry
   * plugin opens the storefront's own detail panel here.
   */
  registry: {
    entries: readonly MarketplacePluginEntry[]
    /** Null while the registry has not answered; the rail row says so. */
    load: { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' }
    registryUrl: string | null
    mcpSettings: McpSettings
    onInstalled: () => void
    onUpsertMcpServer: (server: McpServerConfig) => void
  }
  /** The harness directories skill installs fan out to on this machine. */
  harnesses: readonly SkillHarness[]
  /** The source open across kinds; the door holds it so a kind switch keeps it. */
  selectedSourceId: string | null
  onSelectSource: (sourceId: string) => void
  /** "Also from this source: N skills" crosses to the Skills canvas on the same source. */
  onBrowseSkills: (sourceId: string) => void
  /** MCP settings live in the store; the install hands the servers here. */
  onAddMcpServers: (servers: McpServerConfig[]) => void
  onRemoveMcpServers: (serverIds: string[]) => void
  onConfigureGitHubToken: () => void
}): JSX.Element {
  const [discovering, setDiscovering] = useState(false)
  const [openPluginId, setOpenPluginId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [addRepo, setAddRepo] = useState<string | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const [readError, setReadError] = useState<{ pluginId: string; message: string } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [hooksAcknowledged, setHooksAcknowledged] = useState(false)
  // Kept per source, so opening another one does not show it that source's line.
  const [report, setReport] = useState<{ sourceId: string; outcome: string | null; error: string | null } | null>(null)
  const [syncing, setSyncing] = useState<ReadonlySet<string>>(new Set())

  // Land on the first source rather than an index the rail already replaces.
  useEffect(() => {
    if (selectedSourceId !== null || sources.sources.length === 0) return
    onSelectSource(sources.sources[0].id)
  }, [sources.sources, selectedSourceId, onSelectSource])

  const activeSource = useMemo(
    () => sources.sources.find((source) => source.id === selectedSourceId) ?? null,
    [sources.sources, selectedSourceId],
  )
  const activeScan = activeSource ? sources.scans[activeSource.id] : undefined
  const scan = activeScan && activeScan.status === 'ready' ? activeScan.scan : null
  const marketplaceName = scan?.marketplaceName ?? ''
  const openPlugin: ScannedPlugin | null = scan && openPluginId ? findPlugin(scan, openPluginId) : null

  const openSource = useCallback(
    (sourceId: string) => {
      setDiscovering(false)
      onSelectSource(sourceId)
      setOpenPluginId(null)
      setQuery('')
      setReadError(null)
      setHooksAcknowledged(false)
    },
    [onSelectSource],
  )

  const addedRepos = useMemo(() => addedRepoKeys(sources.sources.map((source) => source.repo)), [sources.sources])

  // A linked plugin is read when opened: its own repository, once, written
  // back into the source's scan so the next open costs nothing.
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
        setReadError({ pluginId: plugin.id, message: error instanceof Error ? error.message : String(error) })
      } finally {
        setReading((current) => (current === plugin.id ? null : current))
      }
    },
    [sources],
  )

  const openPluginRow = useCallback(
    (pluginId: string) => {
      setOpenPluginId(pluginId)
      setHooksAcknowledged(false)
      setReadError(null)
      if (!activeSource || !scan) return
      const plugin = findPlugin(scan, pluginId)
      if (plugin && !plugin.componentsKnown) void readLinked(activeSource, plugin)
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
          return
        }
        if (result.mcpServers.length > 0) onAddMcpServers(result.mcpServers)
        setReport({ sourceId: source.id, outcome: summarizePluginInstall(result), error: null })
        sources.refreshInstalled()
      } catch (error) {
        setReport({ sourceId: source.id, outcome: null, error: error instanceof Error ? error.message : String(error) })
      } finally {
        setInstalling(false)
      }
    },
    [workspaceRoot, hooksAcknowledged, onAddMcpServers, sources],
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
          outcome: `Removed ${record.pluginName}${result.disabledClaudePluginKey ? ` and disabled ${result.disabledClaudePluginKey}` : ''}.`,
          error: null,
        })
        sources.refreshInstalled()
      } catch (error) {
        setReport({ sourceId: source.id, outcome: null, error: error instanceof Error ? error.message : String(error) })
      } finally {
        setInstalling(false)
      }
    },
    [workspaceRoot, onRemoveMcpServers, sources],
  )

  /** Sync: the scan again at head. What it re-copies is the Skills surface's rule; here it also refreshes the plugin list. */
  const syncSource = useCallback(
    async (source: SkillSource): Promise<void> => {
      if (typeof window.api.skillsSyncSource !== 'function' || syncing.has(source.id)) return
      setSyncing((current) => new Set(current).add(source.id))
      setReport(null)
      try {
        const result = await window.api.skillsSyncSource({ sourceId: source.id, workspaceRoot })
        if (!result.ok) {
          setReport({ sourceId: source.id, outcome: null, error: result.message })
          return
        }
        sources.applySync(result.source, result.scan)
        sources.refreshInstalled()
        setReport({
          sourceId: source.id,
          outcome: summarizeSyncRun({
            added: result.added,
            removed: result.removed,
            refreshed: result.refreshed,
            failures: result.failures,
          }),
          error: null,
        })
      } catch (error) {
        setReport({ sourceId: source.id, outcome: null, error: error instanceof Error ? error.message : String(error) })
      } finally {
        setSyncing((current) => {
          const next = new Set(current)
          next.delete(source.id)
          return next
        })
      }
    },
    [sources, syncing, workspaceRoot],
  )

  const isRegistrySource = activeSource?.id === BUILTIN_SKILL_SOURCE_ID
  const rows = useMemo(() => {
    if (!activeSource) return []
    if (isRegistrySource) return deriveRegistryPluginRows(registry.entries, query)
    return scan ? derivePluginRows({ source: activeSource, scan, installed: sources.installedPlugins, query }) : []
  }, [activeSource, isRegistrySource, registry.entries, scan, sources.installedPlugins, query])
  const pluginCount = isRegistrySource ? registry.entries.length : scan ? scanPlugins(scan).length : 0
  const registryEntry = isRegistrySource && openPluginId ? registry.entries.find((entry) => entry.id === openPluginId) ?? null : null
  const registryCountLine =
    registry.load.status === 'loading' ? 'Loading…' : registry.load.status === 'error' ? 'Marketplace unavailable' : pluralPlugins(registry.entries.length)

  const rail = (
    <SourcesRail
      ariaLabel="Plugin sources"
      rows={sources.sources.map((source) => ({
        source,
        stateLine: source.id === BUILTIN_SKILL_SOURCE_ID ? registryCountLine : pluginCountLine(sources.scans[source.id]),
      }))}
      selectedId={selectedSourceId}
      onSelect={openSource}
      onAdd={() => setAddRepo('')}
      discover={{ subtitle: 'Plugins on GitHub', active: discovering, onOpen: () => setDiscovering(true) }}
    />
  )

  const canvas = (() => {
    if (sources.sourcesLoad.status === 'loading') {
      return <SurfaceCanvasState kind="loading" label="Loading sources…" />
    }
    if (sources.sourcesLoad.status === 'error') {
      return (
        <SurfaceCanvasState
          kind="error"
          title="Your sources could not be read."
          hint="Nothing was changed. Try again, or add a source to start a fresh list."
          detail={sources.sourcesLoad.message}
          onRetry={sources.refreshSources}
        />
      )
    }
    if (discovering) {
      return (
        <SkillsDiscover
          addedRepos={addedRepos}
          onScanRepo={(repo) => setAddRepo(repo)}
          onConfigureToken={onConfigureGitHubToken}
        />
      )
    }
    if (!activeSource) {
      return (
        <SurfaceCanvasState
          kind="empty"
          firstRun
          glyph={<PlusIcon className="icon-md" />}
          title="No plugin sources"
          body="Add a GitHub repository — a Claude Code plugin marketplace, a plugin, or a repository of skills — to browse what it holds."
          action={<OutlineButton onClick={() => setAddRepo('')}>Add a source</OutlineButton>}
        />
      )
    }
    if (isRegistrySource) {
      return (
        <div className="min-w-0">
          <header className="flex items-start gap-3">
            <SourceMonogram monogram={sourceDisplayMonogram(activeSource)} size="lg" />
            <div className="min-w-0 flex-1">
              <h3 className="text-title font-semibold text-[color:var(--text-strong)]">{sourceDisplayName(activeSource)}</h3>
              <p className="mt-0.5 max-w-[74ch] text-meta text-[color:var(--text-muted)]">
                {registry.load.status === 'ready'
                  ? `The Multicode marketplace · ${pluralPlugins(registry.entries.length)} · ${registry.registryUrl ?? 'bundled'}`
                  : registry.load.status === 'loading'
                    ? 'Reading the Multicode marketplace…'
                    : `The Multicode marketplace could not be read: ${registry.load.message}`}
              </p>
              <p className="mt-1.5 max-w-[74ch] text-meta text-[color:var(--text-muted)]">
                Curated and published from the releases repository. Entries install through the marketplace trust gate.
              </p>
            </div>
          </header>
          {registry.entries.length > 8 ? (
            <div className="mt-4 max-w-[340px]">
              <InboxSearchInput
                value={query}
                onChange={setQuery}
                ariaLabel={`Filter the ${registry.entries.length} plugins in the Multicode marketplace`}
                placeholder={`Filter ${pluralPlugins(registry.entries.length)}`}
              />
            </div>
          ) : null}
          <div className="mt-3 flex flex-col gap-0.5" role="list" aria-label="Plugins">
            {rows.map((item) => (
              <div key={item.pluginId} role="listitem">
                <PluginRow item={item} selected={item.pluginId === openPluginId} onOpen={() => setOpenPluginId(item.pluginId)} />
              </div>
            ))}
            {rows.length === 0 && registry.load.status === 'ready' ? (
              <p className="py-6 text-body text-[color:var(--text-muted)]">
                {query.trim() ? `Nothing matches “${query.trim()}”.` : 'The marketplace lists no plugins.'}
              </p>
            ) : null}
          </div>
        </div>
      )
    }
    if (!activeScan || activeScan.status === 'loading') {
      return (
        <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
          <Spinner size={14} />
          {`Reading ${sourceDisplayName(activeSource)}…`}
        </div>
      )
    }
    if (activeScan.status === 'error' || !scan) {
      return (
        <div className="py-4">
          <InlineNotice
            tone="error"
            title={`${sourceDisplayName(activeSource)} could not be read.`}
            hint="Its plugins are not listed below — this is not an empty source."
            detail={activeScan.status === 'error' ? activeScan.message : undefined}
            action={<GhostButton onClick={() => sources.refreshScan(activeSource.id)}>Try again</GhostButton>}
          />
        </div>
      )
    }
    const shape = scanShape(scan)
    const skillCount = scan.skills.length
    const serverCount = scan.mcpServers?.length ?? 0
    const scanned = activeSource.scannedAt ? formatRelativeTime(activeSource.scannedAt) : ''
    const also: string[] = []
    if (skillCount > 0) also.push(`${skillCount} ${skillCount === 1 ? 'skill' : 'skills'}`)
    if (serverCount > 0) also.push(`${serverCount} MCP ${serverCount === 1 ? 'server' : 'servers'}`)
    const thisReport = report?.sourceId === activeSource.id ? report : null
    return (
      <div className="min-w-0">
        <header className="flex items-start gap-3">
          <SourceMonogram monogram={sourceDisplayMonogram(activeSource)} size="lg" />
          <div className="min-w-0 flex-1">
            <h3 className={`text-title font-semibold text-[color:var(--text-strong)] ${activeSource.repo ? 'font-mono' : ''}`}>
              {sourceDisplayName(activeSource)}
            </h3>
            <p className="mt-0.5 max-w-[74ch] text-meta text-[color:var(--text-muted)]">
              {[
                SOURCE_SHAPE_LABEL[shape],
                pluralPlugins(pluginCount),
                shortCommit(activeSource.commitSha),
                scanned ? `scanned ${scanned}` : '',
                thisReport?.outcome ?? '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {also.length > 0 ? (
              <p className="mt-1 text-meta text-[color:var(--text-muted)]">
                Also from this source:{' '}
                <button
                  type="button"
                  className={`rounded-sm underline decoration-[color:var(--border-strong)] underline-offset-2 hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
                  onClick={() => onBrowseSkills(activeSource.id)}
                >
                  {also.join(' · ')}
                </button>
              </p>
            ) : null}
          </div>
          {activeSource.kind === 'github' ? (
            <OutlineButton onClick={() => void syncSource(activeSource)} disabled={syncing.has(activeSource.id)}>
              {syncing.has(activeSource.id) ? 'Syncing…' : 'Sync'}
            </OutlineButton>
          ) : null}
        </header>

        {thisReport?.error ? (
          <div className="mt-3">
            <InlineNotice tone="error" title="That did not complete." hint={thisReport.error} />
          </div>
        ) : null}
        {sources.installedPluginsRead.status === 'error' ? (
          <div className="mt-3">
            <InlineNotice tone="warn">
              {`Installed plugins in this workspace could not be read, so nothing is marked as installed: ${sources.installedPluginsRead.message}`}
            </InlineNotice>
          </div>
        ) : null}

        {pluginCount === 0 ? (
          <div className="mt-6 text-body text-[color:var(--text-muted)]">
            {skillCount > 0
              ? `Nothing in this source is a plugin. It holds ${skillCount} ${skillCount === 1 ? 'skill' : 'skills'}, browsed under Skills.`
              : 'Nothing in this source scanned as a plugin. A plugin is a directory with .claude-plugin/plugin.json, or an entry in .claude-plugin/marketplace.json.'}
          </div>
        ) : (
          <>
            {pluginCount > 8 ? (
              <div className="mt-4 max-w-[340px]">
                <InboxSearchInput
                  value={query}
                  onChange={setQuery}
                  ariaLabel={`Filter the ${pluginCount} plugins in ${sourceDisplayName(activeSource)}`}
                  placeholder={`Filter ${pluralPlugins(pluginCount)}`}
                />
              </div>
            ) : null}
            <div className="mt-3 flex flex-col gap-0.5" role="list" aria-label="Plugins">
              {rows.map((item) => (
                <div key={item.pluginId} role="listitem">
                  <PluginRow item={item} selected={item.pluginId === openPluginId} onOpen={() => openPluginRow(item.pluginId)} />
                </div>
              ))}
              {rows.length === 0 ? (
                <p className="py-6 text-body text-[color:var(--text-muted)]">{`Nothing matches “${query.trim()}”.`}</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    )
  })()

  const pane = registryEntry ? (
    <PluginDetailPanel
      key={registryEntry.id}
      plugin={registryEntry}
      registryUrl={registry.registryUrl}
      workspaceRoot={workspaceRoot}
      mcpSettings={registry.mcpSettings}
      onInstalled={registry.onInstalled}
      onUpsertMcpServer={registry.onUpsertMcpServer}
      onClose={() => setOpenPluginId(null)}
    />
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
        onClose={() => setOpenPluginId(null)}
      />
    ) : null

  return (
    <div className="flex h-full min-h-0">
      {rail}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">{canvas}</div>
      {pane}
      <AddSkillSourceModal
        open={addRepo !== null}
        initialRepo={addRepo ?? ''}
        onClose={() => setAddRepo(null)}
        onAdded={(source: SkillSource) => {
          sources.refreshSources()
          openSource(source.id)
        }}
        onRemoved={() => {
          sources.refreshSources()
        }}
      />
    </div>
  )
}
