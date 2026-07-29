// The door's per-kind marketplace canvas (MC-1847 C2): capability modules and
// agent CLIs get browsable for the first time — the connector grid keeps its
// mcp/skills subset, and these render the registry's module/cli plugins with
// the same normalized rows and the same storefront install flow (trust gates
// included), no parallel machinery.

import { useState } from 'react'

import { GhostButton, InboxSearchInput, InlineNotice, Spinner } from '../../ui'
import { PluginDetailPanel } from '../../settings/BrowseStorefront'
import { ConnectorEntryRow, ConnectorSectionHeading } from './ConnectorRow'
import { registryEntriesForKinds, searchConnectors } from './connectorsFacets'
import type { ConnectorSources } from './useConnectorSources'

const KIND_COPY: Record<'module' | 'cli', { label: string; searchAria: string; placeholder: string; empty: string }> = {
  module: {
    label: 'Capability modules',
    searchAria: 'Search capability modules by name, category, or tag',
    placeholder: 'Search modules',
    empty: 'No capability modules are in the marketplace yet.',
  },
  cli: {
    label: 'Agent CLIs',
    searchAria: 'Search agent CLIs by name, category, or tag',
    placeholder: 'Search agent CLIs',
    empty: 'No agent CLIs are in the marketplace yet.',
  },
}

export function ExtensionKindCanvas({
  kind,
  sources,
  workspaceRoot,
}: {
  kind: 'module' | 'cli'
  sources: ConnectorSources
  workspaceRoot: string | null
}): JSX.Element {
  const copy = KIND_COPY[kind]
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const retry = (
    <GhostButton
      size="sm"
      onClick={() => void sources.loadRegistry(true)}
      className="border border-[color:var(--border-default)]"
    >
      Retry
    </GhostButton>
  )

  // Kind canvases read the registry source alone — the MCP catalog carries no
  // modules or CLIs, so its state must not gate (or blank) this page.
  if (sources.registryLoad.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
        <Spinner size={14} />
        Loading the marketplace…
      </div>
    )
  }
  if (sources.registryLoad.status === 'error') {
    return (
      <div className="py-4">
        <InlineNotice tone="error" action={retry}>
          {`The marketplace is unavailable: ${sources.registryLoad.message}`}
        </InlineNotice>
      </div>
    )
  }

  const entries = registryEntriesForKinds(sources.registryLoad.data, [kind])
  const matched = searchConnectors(entries, query)
  const selectedEntry = matched.find((entry) => entry.key === selectedKey) ?? null
  const detailOpen = Boolean(selectedEntry?.plugin)

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <InboxSearchInput
            value={query}
            onChange={setQuery}
            ariaLabel={copy.searchAria}
            placeholder={copy.placeholder}
          />
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="px-1 py-10 text-center text-body text-[color:var(--text-muted)]">{copy.empty}</p>
      ) : matched.length === 0 ? (
        <p className="px-1 py-10 text-center text-body text-[color:var(--text-muted)]">
          {`No ${copy.label.toLowerCase()} match “${query.trim()}”.`}
        </p>
      ) : (
        <div className="mt-4 flex gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <ConnectorSectionHeading label={copy.label} count={matched.length} />
            <div className={`grid gap-2 ${detailOpen ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
              {matched.map((entry) => (
                <ConnectorEntryRow
                  key={entry.key}
                  entry={entry}
                  registryUrl={sources.registryUrl}
                  selected={selectedKey === entry.key}
                  onOpen={() => setSelectedKey(entry.key)}
                />
              ))}
            </div>
          </div>

          {selectedEntry?.plugin ? (
            <PluginDetailPanel
              key={selectedEntry.plugin.id}
              plugin={selectedEntry.plugin}
              registryUrl={sources.registryUrl}
              workspaceRoot={workspaceRoot}
              mcpSettings={sources.mcpSettings}
              onInstalled={() => void sources.loadRegistry(true)}
              onUpsertMcpServer={sources.upsertMcpServer}
              onClose={() => setSelectedKey(null)}
            />
          ) : null}
        </div>
      )}
    </>
  )
}
