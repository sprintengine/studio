// The door's per-kind marketplace canvas (MC-1847 C2): capability modules and
// agent CLIs get browsable for the first time — the connector grid keeps its
// mcp/skills subset, and these render the registry's module/cli plugins with
// the same normalized rows and the same storefront install flow (trust gates
// included), no parallel machinery.

import { useState } from 'react'

import { GhostButton, InboxSearchInput, InlineNotice, ProviderRow, Spinner } from '../../ui'
import { PluginDetailPanel, PluginIcon, pluginTrust, resolveIconUrl } from '../../settings/BrowseStorefront'
import { ConnectorEntryRow, ConnectorSectionHeading } from './ConnectorRow'
import { registryEntriesForKinds, searchConnectors } from './connectorsFacets'
import type { ConnectorEntry } from './connectorsFacets'
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

// An agent CLI in the marketplace, on the shared provider anatomy (item 1994).
// Same row as the installed list in Settings → Agents, read from what this
// surface actually knows: there is no local health probe here, so the dot and
// the state line carry the registry's own signing tier — the thing that decides
// whether you should run this CLI at all — and never imply an install state the
// registry cannot see. Version is the registry's bundle version, so it is
// labelled rather than dressed up as a semver.
//
// Capability modules deliberately keep `ConnectorEntryRow` for now: 1994 owns
// the Agent CLIs list, and the modules list adopts this anatomy on its own item
// rather than being converted as a side effect of this one.
function AgentCliRegistryRow({
  entry,
  registryUrl,
  selected,
  onOpen,
}: {
  entry: ConnectorEntry
  registryUrl: string | null
  selected: boolean
  onOpen: () => void
}): JSX.Element {
  const plugin = entry.plugin
  const trust = plugin ? pluginTrust(plugin) : null
  return (
    <ProviderRow
      icon={
        <PluginIcon
          iconUrl={plugin ? resolveIconUrl(registryUrl, plugin.icon) : null}
          name={entry.name}
          size={22}
        />
      }
      health={trust?.tone ?? 'neutral'}
      name={entry.name}
      // No version on a marketplace row. `plugin.latest` is the registry's
      // bundle revision, not the CLI's own version: rendering it in the mono
      // version slot would claim "Cursor 4" about a product on 2026.07.17, and
      // the detail panel this row opens already states it as "Version 4".
      version={null}
      stateLine={
        trust && plugin
          ? `${trust.label} — published by ${plugin.publisher.name}`
          : // Registry entries always carry a manifest (registryEntriesForKinds
            // builds them from one), so this branch exists for the optional
            // field rather than for a state the surface produces. It says what
            // would actually be true rather than guessing at a cause.
            'Listed with no manifest — not installable'
      }
      selected={selected}
      actions={
        plugin ? (
          <GhostButton
            size="xs"
            onClick={onOpen}
            className="border border-[color:var(--border-default)]"
            aria-label={`Get ${entry.name}`}
            aria-expanded={selected}
          >
            Get
          </GhostButton>
        ) : null
      }
    />
  )
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
            {kind === 'cli' ? (
              <div>
                {matched.map((entry) => (
                  <AgentCliRegistryRow
                    key={entry.key}
                    entry={entry}
                    registryUrl={sources.registryUrl}
                    selected={selectedKey === entry.key}
                    onOpen={() => setSelectedKey(entry.key)}
                  />
                ))}
              </div>
            ) : (
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
            )}
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
