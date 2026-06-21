// MCP catalog tile + info panel + brand icon — extracted from SettingsPanel.tsx
// so the catalog grid stays composable and the settings shell stays focused on
// tab routing and state coordination. Pure presentation: takes data via props
// and emits intents (`onToggle`, `onInfo`, `onClose`) that the settings shell
// translates into IPC calls.

import React, { useEffect, useState } from 'react'
import type { McpCatalogServer, McpServerConfig } from '../../types/workspace'
import { GhostButton, InboxSearchInput, PrimaryButton } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'
import { filterMcpCatalog } from './mcpCatalogFilter'
import { mcpMonogram } from './mcpMonogram'

export function mcpServerFromCatalog(server: McpCatalogServer): McpServerConfig {
  return {
    id: server.id,
    name: server.name,
    category: server.category,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    url: server.url,
    env: server.env,
    envVarNames: server.envVarNames ?? [],
    headers: server.headers,
    enabled: true,
    required: false,
    clients: server.defaultClients?.length ? server.defaultClients : server.clients,
    scope: server.recommendedScope ?? 'workspace',
    source: 'bundled',
    riskLevel: server.riskLevel,
    auth: server.auth,
    capabilities: server.capabilities,
    sourceUrl: server.sourceUrl,
  }
}

export function groupMcpCatalog(servers: McpCatalogServer[]): Array<[string, McpCatalogServer[]]> {
  const groups = new Map<string, McpCatalogServer[]>()
  for (const server of servers) {
    const category = server.category?.trim() || 'Other'
    groups.set(category, [...(groups.get(category) ?? []), server])
  }
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right))
}

function mcpIconSlug(id: string): string | null {
  if (id === 'context7') return null
  if (id === 'openai-docs') return 'openai'
  if (id === 'brave-search') return 'brave'
  return id
}

export function McpBrandIcon({
  slug,
  name,
  size = 36,
}: {
  slug: string | null
  name: string
  size?: number
}) {
  const [failed, setFailed] = useState(false)
  if (!slug || failed) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
        className="grid place-items-center rounded-md bg-[color:var(--bg-active)] font-mono font-semibold text-[color:var(--text-default)]"
      >
        {mcpMonogram(name)}
      </span>
    )
  }
  return (
    <img
      src={`https://cdn.simpleicons.org/${slug}/e5e7eb`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="pointer-events-none select-none"
    />
  )
}

export function McpCatalogTile({
  server,
  installed,
  selected,
  onToggle,
  onInfo,
}: {
  server: McpCatalogServer
  installed: boolean
  selected: boolean
  onToggle: () => void
  onInfo: () => void
}) {
  const tileClass = installed
    ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
    : selected
      ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)]'
      : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-surface-raised)]'
  return (
    <div className="relative aspect-square">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={installed}
        aria-label={installed ? `Remove ${server.name}` : `Add ${server.name}`}
        className={`interactive flex h-full w-full flex-col items-start justify-between rounded-md border p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${tileClass}`}
      >
        <McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} size={36} />
        {installed ? (
          <span
            aria-hidden
            className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]"
          >
            <svg
              viewBox="0 0 10 10"
              className="h-2.5 w-2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="1.5,5 4,7.5 8.5,2.5" />
            </svg>
          </span>
        ) : null}
        <div className="w-full min-w-0 pr-6">
          <div className="truncate text-[13px] font-semibold leading-5 text-[color:var(--text-strong)]">
            {server.name}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] leading-3 text-[color:var(--text-subtle)]">
            {server.transport}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={onInfo}
        aria-label={`Show details for ${server.name}`}
        aria-expanded={selected}
        className={`interactive absolute bottom-2 right-2 z-10 grid h-5 w-5 place-items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
          selected
            ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
            : 'text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-default)]'
        }`}
      >
        <svg viewBox="0 0 16 16" className="icon-sm" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5A5.5 5.5 0 118 2.5a5.5 5.5 0 010 11zM7.25 5.5a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7.25 7.25a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4z" />
        </svg>
      </button>
    </div>
  )
}

export function McpInfoPanel({
  server,
  installed,
  onToggle,
  onClose,
}: {
  server: McpCatalogServer
  installed: boolean
  onToggle: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const hasAuth = Boolean(server.auth && server.auth.trim().toLowerCase() !== 'none')

  return (
    <aside
      aria-label={`${server.name} details`}
      className="sticky top-2 w-72 shrink-0 self-start rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} size={32} />
          <div className="min-w-0">
            <h5 className="truncate text-[14px] font-semibold leading-5 text-[color:var(--text-strong)]">
              {server.name}
            </h5>
            <div className="mt-0.5 truncate font-mono text-[11px] text-[color:var(--text-subtle)]">
              {server.transport}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="interactive grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          <svg viewBox="0 0 12 12" className="icon-xs" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
      {server.description ? (
        <p className="mt-3 text-[12px] leading-5 text-[color:var(--text-muted)]">{server.description}</p>
      ) : null}
      {hasAuth ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Auth</div>
          <div className="mt-1 text-[12px] text-[color:var(--tone-warn)]">{server.auth}</div>
        </div>
      ) : null}
      {server.capabilities?.length ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Capabilities</div>
          <ul className="mt-1 space-y-0.5 text-[12px] text-[color:var(--text-muted)]">
            {server.capabilities.map((capability) => (
              <li key={capability} className="flex gap-1.5">
                <span aria-hidden className="text-[color:var(--text-subtle)]">·</span>
                <span>{capability}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {server.setupNotes ? (
        <p className="mt-3 border-l-2 border-[color:var(--border-strong)] pl-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {server.setupNotes}
        </p>
      ) : null}
      {server.sourceUrl ? (
        <a
          href={server.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex text-[12px] font-semibold text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] focus:outline-none focus-visible:underline"
        >
          Source docs
        </a>
      ) : null}
      <div className="mt-4">
        {installed ? (
          <GhostButton
            onClick={onToggle}
            size="md"
            className="h-9 w-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Remove
          </GhostButton>
        ) : (
          <PrimaryButton onClick={onToggle} size="md" className="h-9 w-full">
            Add to active
          </PrimaryButton>
        )}
      </div>
    </aside>
  )
}

// Settings → MCPs "Bundled catalog": the searchable tile grid plus its detail
// aside. Owns the search query and the open-detail selection; the parent owns
// install state and the toggle mutation (emitted via `onToggle`). Reuses the
// shared `InboxSearchInput` search idiom rather than a bespoke one.
export function McpCatalogBrowser({
  servers,
  isInstalled,
  onToggle,
}: {
  servers: McpCatalogServer[]
  isInstalled: (id: string) => boolean
  onToggle: (server: McpCatalogServer) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = filterMcpCatalog(servers, query)
  const groups = groupMcpCatalog(filtered)
  // Only show the detail aside while its server is in the filtered set, so a
  // search that hides the selected tile also hides its now-orphaned panel; the
  // selection itself persists, so clearing the search restores it.
  const selected =
    selectedId && filtered.some((server) => server.id === selectedId)
      ? servers.find((server) => server.id === selectedId) ?? null
      : null
  const trimmed = query.trim()

  return (
    <div className="space-y-4 border-t border-[color:var(--border-subtle)] pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <SettingsSectionTitle count={filtered.length}>Bundled catalog</SettingsSectionTitle>
        <div className="min-w-0 flex-1">
          <InboxSearchInput
            value={query}
            onChange={setQuery}
            ariaLabel="Search MCP servers by name, category, or description"
            placeholder="Search MCP servers"
          />
        </div>
      </div>

      <div className="flex gap-4">
        <section className="min-w-0 flex-1 space-y-4">
          {groups.length === 0 ? (
            <p className="px-1 py-6 text-center text-[12px] text-[color:var(--text-muted)]">
              {trimmed ? `No MCP servers match “${trimmed}”.` : 'No MCP servers available.'}
            </p>
          ) : (
            <div className="space-y-5">
              {groups.map(([category, categoryServers]) => (
                <div key={category} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] font-medium text-[color:var(--text-muted)]">{category}</span>
                    <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
                    <span className="tabular-nums font-mono text-[10px] text-[color:var(--text-subtle)]">
                      {categoryServers.length}
                    </span>
                  </div>
                  <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${selected ? '' : 'lg:grid-cols-4'}`}>
                    {categoryServers.map((server) => (
                      <McpCatalogTile
                        key={server.id}
                        server={server}
                        installed={isInstalled(server.id)}
                        selected={selectedId === server.id}
                        onToggle={() => onToggle(server)}
                        onInfo={() =>
                          setSelectedId((current) => (current === server.id ? null : server.id))
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        {selected ? (
          <McpInfoPanel
            server={selected}
            installed={isInstalled(selected.id)}
            onToggle={() => onToggle(selected)}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
    </div>
  )
}

export { mcpIconSlug, mcpMonogram }
