// Agent CLIs: Installed, and the app's own catalogue.
//
// Same shape as Plugins and Skills (source-tabs ruling, 2026-09-05) with one
// difference the ruling anticipated: there is no plus. A source's scan yields
// plugins, skills and MCP servers — never a CLI — so "Add from GitHub…" here
// would offer a way to add something that can never appear in this view, and
// the tab row would fill with repositories that can only ever read "none".
// A CLI reaches the app through the marketplace registry, which is the one
// tab this view has beside Installed.

import React, { useCallback, useMemo, useState } from 'react'

import { BUILTIN_SKILL_SOURCE_ID } from '../../../../../../../shared/skills'
import { EmptyState, GhostButton, InlineNotice, Spinner } from '../../../../ui'
import { PluginDetailPanel } from '../../../../settings/BrowseStorefront'
import {
  AgentCliRegistryRow,
  AgentCliRuntimeRows,
  type CliShelfRuntime,
} from '../../../../panels/ConnectorsPanel/AgentCliShelfRows'
import { InstalledExtensionsInventory } from '../../../../panels/ConnectorsPanel/InstalledExtensionsInventory'
import {
  registryEntriesForKinds,
  searchConnectors,
  type ConnectorEntry,
} from '../../../../panels/ConnectorsPanel/connectorsFacets'
import type { ConnectorSources } from '../../../../panels/ConnectorsPanel/useConnectorSources'
import { useWorkspaceStore } from '../../../../../store/workspaceStore'
import { CatalogueHead, CatalogueSurface, type CatalogueSection } from '../catalogue/CatalogueSurface'
import {
  catalogueStateLine,
  deriveCatalogueTabs,
  resolveCatalogueTab,
  APP_CATALOGUE_LABEL,
  INSTALLED_TAB_ID,
  type CatalogueCount,
} from '../catalogue/catalogueTabs'
import type { SkillSourcesState } from '../skills/useSkillSources'

export function AgentClisCatalogue({
  sources,
  connectors,
  workspaceRoot,
  cliRuntime,
  activeTabId,
  onSelectTab,
  query,
  onQueryChange,
}: {
  sources: SkillSourcesState
  connectors: ConnectorSources
  workspaceRoot: string | null
  cliRuntime: CliShelfRuntime
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  query: string
  onQueryChange: (value: string) => void
}): JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)

  const registry = connectors.registryLoad.status === 'ready' ? connectors.registryLoad.data : []
  // The registry's inline CLI entries are generated from EVERY bundled plugin
  // manifest (resources/marketplace/cli-entries.ts), and three of those are
  // conversation providers, not agent CLIs: the Claude Agent SDK harness,
  // OpenRouter and xAI. They share this list's word and, in one case, its
  // name — the SDK provider is also called "Claude Code", so the page showed
  // Claude Code twice (owner, 2026-09-06). The CLI runtime catalogue
  // (`pluginsList`, kind `cli` only) is the one list of what this page is
  // about, so an entry the catalogue does not know is not an agent CLI and is
  // not listed here; providers are configured in Settings. Only a settled
  // catalogue may exclude: while it is loading or failed, every entry stays
  // and its row states the probe's condition instead of vanishing.
  const cliPluginIds = useMemo(
    () => (cliRuntime.catalogStatus === 'ready' ? new Set(cliRuntime.catalogEntries.map((entry) => entry.id)) : null),
    [cliRuntime.catalogEntries, cliRuntime.catalogStatus],
  )
  const entries = useMemo(
    () =>
      registryEntriesForKinds(registry, ['cli']).filter((entry) => {
        const pluginId = entry.plugin?.cli?.pluginId
        if (!pluginId || !cliPluginIds) return true
        return cliPluginIds.has(pluginId)
      }),
    [cliPluginIds, registry],
  )
  const matched = useMemo(() => searchConnectors(entries, query), [entries, query])

  const appCount = useMemo<CatalogueCount>(() => {
    if (connectors.registryLoad.status === 'loading') return { status: 'loading' }
    if (connectors.registryLoad.status === 'error') {
      return { status: 'error', message: `The marketplace is unavailable: ${connectors.registryLoad.message}` }
    }
    return { status: 'ready', count: entries.length }
  }, [connectors.registryLoad, entries.length])

  const tabs = deriveCatalogueTabs({
    kind: 'agent-clis',
    sources: sources.sources,
    // No count on Installed here, deliberately. The availability probe counts
    // BINARIES this machine has; the tab lists the CLI plugin registry's
    // entries, which is a different population — nine against ten on this
    // machine. A tab that states one number while listing another is two
    // answers to one word, so it states none and the list speaks for itself.
    installedCount: null,
    counts: { [BUILTIN_SKILL_SOURCE_ID]: appCount },
  })
  const tabId = resolveCatalogueTab(tabs, activeTabId)

  // Two populations, one page: the CLIs the app can detect and install inline
  // first, then any third-party bundle that goes through the storefront. The
  // pager walks them as one list, so they are one section rather than two —
  // the split is an implementation detail of the row, not a category.
  const inline = useMemo(() => matched.filter((entry) => Boolean(entry.plugin?.cli)), [matched])
  const bundles = useMemo(() => matched.filter((entry) => !entry.plugin?.cli), [matched])
  const sections = useMemo<CatalogueSection<ConnectorEntry>[]>(() => {
    const built: CatalogueSection<ConnectorEntry>[] = []
    if (inline.length > 0) built.push({ key: 'runtime', label: 'On this machine', items: inline })
    if (bundles.length > 0) built.push({ key: 'bundles', label: 'Published bundles', items: bundles })
    return built
  }, [bundles, inline])

  const renderRow = useCallback(
    (entry: ConnectorEntry): React.ReactNode =>
      entry.plugin?.cli ? (
        // The runtime rows own their own availability read and their install
        // disclosure, so one entry goes in and one row comes out.
        <AgentCliRuntimeRows
          key={entry.key}
          entries={[entry]}
          registryUrl={connectors.registryUrl}
          runtime={cliRuntime}
        />
      ) : (
        <AgentCliRegistryRow
          key={entry.key}
          entry={entry}
          registryUrl={connectors.registryUrl}
          selected={selectedKey === entry.key}
          onOpen={() => setSelectedKey(entry.key)}
        />
      ),
    [cliRuntime, connectors.registryUrl, selectedKey],
  )

  const head =
    tabId === INSTALLED_TAB_ID ? (
      <CatalogueHead
        name="Installed"
        stateLine="The agent CLIs this machine has, grouped by where they came from. Update runs the CLI's own updater."
      />
    ) : (
      <CatalogueHead
        name={APP_CATALOGUE_LABEL}
        stateLine={`${catalogueStateLine(appCount, 'agent CLI')} · ${connectors.registryUrl ?? 'bundled'}`}
      />
    )

  const notices =
    tabId !== INSTALLED_TAB_ID
    && cliRuntime.availabilityStatus === 'error'
    && cliRuntime.availabilityError ? (
      // One fact for the whole list (the settings rule): every row would
      // otherwise repeat the same reason.
      <InlineNotice tone="warn">{`Agent CLIs could not be checked: ${cliRuntime.availabilityError}`}</InlineNotice>
    ) : null

  const body = ((): React.ReactNode => {
    if (tabId === INSTALLED_TAB_ID) {
      return (
        <InstalledExtensionsInventory
          mcpServers={[]}
          moduleOverrides={moduleOverrides}
          workspaceRoot={workspaceRoot}
          registryPlugins={registry}
          registryUrl={connectors.registryUrl}
          cliAvailability={cliRuntime.availability}
          onCliUpdated={() => void refreshCliAvailability({ force: true })}
          kinds={['cli']}
          sourceGrouping={{ sources: sources.sources, records: sources.installedPlugins }}
          paging={{ noun: 'agent CLI', query }}
        />
      )
    }
    if (appCount.status === 'loading') {
      return (
        <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
          <Spinner size={14} />
          Loading the marketplace…
        </div>
      )
    }
    if (appCount.status === 'error') {
      return (
        <InlineNotice
          tone="error"
          action={<GhostButton onClick={() => void connectors.loadRegistry(true)}>Retry</GhostButton>}
        >
          {appCount.message}
        </InlineNotice>
      )
    }
    if (sections.length === 0) {
      return (
        <EmptyState
          density="list"
          title={query.trim() ? `No agent CLIs match “${query.trim()}”.` : 'No agent CLIs are in the marketplace yet.'}
        />
      )
    }
    return null
  })()

  const selectedEntry = matched.find((entry) => entry.key === selectedKey) ?? null
  const detail = selectedEntry?.plugin ? (
    <PluginDetailPanel
      key={selectedEntry.plugin.id}
      plugin={selectedEntry.plugin}
      registryUrl={connectors.registryUrl}
      workspaceRoot={workspaceRoot}
      mcpSettings={connectors.mcpSettings}
      onInstalled={() => void connectors.loadRegistry(true)}
      onUpsertMcpServer={connectors.upsertMcpServer}
      onClose={() => setSelectedKey(null)}
    />
  ) : null

  return (
    <CatalogueSurface<ConnectorEntry>
      title="Agent CLIs"
      tabs={tabs}
      activeTabId={tabId}
      onSelectTab={(next) => {
        setSelectedKey(null)
        onSelectTab(next)
      }}
      search={{ query, onQueryChange, placeholder: 'Search this tab' }}
      add={null}
      head={head}
      notices={notices}
      body={body}
      sections={sections}
      renderRow={renderRow}
      noun="agent CLI"
      detail={detail}
    />
  )
}
