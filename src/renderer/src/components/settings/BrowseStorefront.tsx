import { useCallback, useEffect, useRef, useState } from 'react'

import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import { CloseIconButton, GhostButton, InboxSearchInput, InlineNotice, PrimaryButton, Spinner, StatusDot } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'
import { mcpMonogram } from './McpCatalog'
import {
  type BrowseLoad,
  componentKindLabels,
  deriveBrowseView,
} from './storefrontView'

// Settings → Extensions → Browse: the read-only storefront over the first-party
// registry. Data comes from the T2.1 RegistryClient (window.api.readMarketplace-
// Registry) — the registry INDEX only, so the detail view shows real
// components-carried and version and honestly defers permissions/version-history
// to install time (the signed plugin.json is fetched and verified in Phase 3).
// Install is NOT wired here: the detail action is a disabled "coming soon", never
// a fake success, and there are no purchase/Buy affordances (D4). The state
// machine + filtering live in the DOM-free `storefrontView` view-model.

export function BrowseStorefront() {
  const [load, setLoad] = useState<BrowseLoad>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadRegistry = useCallback(async (forceRefresh?: boolean) => {
    if (typeof window.api.readMarketplaceRegistry !== 'function') {
      setLoad({ status: 'unsupported' })
      return
    }
    setLoad({ status: 'loading' })
    try {
      const result = await window.api.readMarketplaceRegistry(forceRefresh ? { forceRefresh: true } : undefined)
      setLoad({ status: 'result', result })
    } catch (error) {
      setLoad({
        status: 'threw',
        message: error instanceof Error ? error.message : 'Could not read the extensions registry.',
      })
    }
  }, [])

  useEffect(() => {
    void loadRegistry()
  }, [loadRegistry])

  const view = deriveBrowseView(load, query)

  // The loaded index (for icon-URL resolution and detail lookup) lives on the raw
  // result; the view-model intentionally does not surface transport details.
  const okResult = load.status === 'result' && load.result.ok ? load.result : null
  const plugins = okResult?.marketplace.plugins ?? []
  const registryUrl = okResult?.registryUrl ?? null

  // Show the detail aside only while its plugin is in the current visible set
  // (featured + categorized), so a search that hides the selected card also hides
  // its orphaned panel; the selection persists, so clearing the search restores it.
  const visible =
    view.status === 'ready'
      ? new Set([...view.featured.map((p) => p.id), ...view.groups.flatMap((g) => g.plugins.map((p) => p.id))])
      : null
  const selected = selectedId && visible?.has(selectedId) ? plugins.find((p) => p.id === selectedId) ?? null : null

  const closeDetail = useCallback(() => {
    const trigger = selectedId ? document.getElementById(pluginCardId(selectedId)) : null
    setSelectedId(null)
    // Restore focus to the card that opened the panel (TD1 a11y contract).
    trigger?.focus()
  }, [selectedId])

  const showToolbar = view.status === 'ready' || view.status === 'no-match'
  const retry = (
    <GhostButton size="sm" onClick={() => void loadRegistry(true)} className="border border-[color:var(--border-default)]">
      Retry
    </GhostButton>
  )

  return (
    <div className="space-y-4">
      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-3">
          <SettingsSectionTitle count={view.status === 'ready' ? view.total : 0}>Browse</SettingsSectionTitle>
          <div className="min-w-0 flex-1">
            <InboxSearchInput
              value={query}
              onChange={setQuery}
              ariaLabel="Search extensions by name, category, publisher, or description"
              placeholder="Search extensions"
            />
          </div>
        </div>
      ) : null}

      {view.status === 'loading' ? (
        <div className="flex items-center gap-2 py-6 text-[12px] text-[color:var(--text-muted)]">
          <Spinner size={14} />
          Loading the extensions registry…
        </div>
      ) : null}

      {view.status === 'unsupported' ? (
        <InlineNotice tone="warn">
          Browsing extensions needs a newer app build. Update Multicode and restart to see the storefront.
        </InlineNotice>
      ) : null}

      {view.status === 'offline' ? (
        <InlineNotice tone="warn" action={retry}>
          {view.message}
        </InlineNotice>
      ) : null}

      {view.status === 'error' ? (
        <InlineNotice tone="error" action={retry}>
          <div>{view.message}</div>
          {view.issues?.length ? (
            <ul className="mt-1 list-disc pl-4">
              {view.issues.slice(0, 4).map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </InlineNotice>
      ) : null}

      {view.status === 'empty' ? (
        <>
          {view.staleNotice ? (
            <InlineNotice tone="warn" action={retry}>
              {view.staleNotice}
            </InlineNotice>
          ) : null}
          <p className="px-1 py-6 text-center text-[12px] text-[color:var(--text-muted)]">
            No extensions published yet.
          </p>
        </>
      ) : null}

      {view.status === 'no-match' ? (
        <>
          {view.staleNotice ? (
            <InlineNotice tone="warn" action={retry}>
              {view.staleNotice}
            </InlineNotice>
          ) : null}
          <p className="px-1 py-6 text-center text-[12px] text-[color:var(--text-muted)]">
            No extensions match “{view.query}”.
          </p>
        </>
      ) : null}

      {view.status === 'ready' ? (
        <>
          {view.staleNotice ? (
            <InlineNotice tone="warn" action={retry}>
              {view.staleNotice}
            </InlineNotice>
          ) : null}
          <div className="flex gap-4">
            <div className="min-w-0 flex-1 space-y-5">
              {view.featured.length > 0 ? (
                <section className="space-y-2">
                  <SettingsSectionTitle>Featured</SettingsSectionTitle>
                  <PluginGrid
                    plugins={view.featured}
                    registryUrl={registryUrl}
                    selectedId={selectedId}
                    detailOpen={Boolean(selected)}
                    onOpen={setSelectedId}
                  />
                </section>
              ) : null}
              {view.groups.map((group) => (
                <section key={group.category} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] font-medium text-[color:var(--text-muted)]">{group.category}</span>
                    <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
                    <span className="tabular-nums font-mono text-[10px] text-[color:var(--text-subtle)]">
                      {group.plugins.length}
                    </span>
                  </div>
                  <PluginGrid
                    plugins={group.plugins}
                    registryUrl={registryUrl}
                    selectedId={selectedId}
                    detailOpen={Boolean(selected)}
                    onOpen={setSelectedId}
                  />
                </section>
              ))}
            </div>
            {selected ? (
              <PluginDetailPanel plugin={selected} registryUrl={registryUrl} onClose={closeDetail} />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

function pluginCardId(id: string): string {
  return `plugin-card-${id}`
}

function PluginGrid({
  plugins,
  registryUrl,
  selectedId,
  detailOpen,
  onOpen,
}: {
  plugins: MarketplacePluginEntry[]
  registryUrl: string | null
  selectedId: string | null
  detailOpen: boolean
  onOpen: (id: string) => void
}) {
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${detailOpen ? '' : 'lg:grid-cols-4'}`}>
      {plugins.map((plugin) => (
        <PluginCard
          key={plugin.id}
          plugin={plugin}
          registryUrl={registryUrl}
          selected={selectedId === plugin.id}
          onOpen={() => onOpen(plugin.id)}
        />
      ))}
    </div>
  )
}

function PluginCard({
  plugin,
  registryUrl,
  selected,
  onOpen,
}: {
  plugin: MarketplacePluginEntry
  registryUrl: string | null
  selected: boolean
  onOpen: () => void
}) {
  const trust = publisherTrust(plugin)
  return (
    <button
      type="button"
      id={pluginCardId(plugin.id)}
      onClick={onOpen}
      aria-expanded={selected}
      aria-label={`Show details for ${plugin.name}`}
      className={`interactive flex aspect-square w-full flex-col items-start justify-between rounded-md border p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
        selected
          ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)]'
          : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-surface-raised)]'
      }`}
    >
      <PluginIcon iconUrl={resolveIconUrl(registryUrl, plugin.icon)} name={plugin.name} size={36} />
      <div className="w-full min-w-0">
        <div className="truncate text-[13px] font-semibold leading-5 text-[color:var(--text-strong)]">
          {plugin.name}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {/* Decorative: the adjacent label names the trust state. Verified is the
              quiet default — only community plugins surface the dot to earn attention. */}
          {trust.verified ? null : <StatusDot tone={trust.tone} />}
          <span className="truncate">{trust.verified ? plugin.publisher.name : `${plugin.publisher.name} · ${trust.label}`}</span>
        </div>
      </div>
    </button>
  )
}

function PluginDetailPanel({
  plugin,
  registryUrl,
  onClose,
}: {
  plugin: MarketplacePluginEntry
  registryUrl: string | null
  onClose: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
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
  useEffect(() => {
    headingRef.current?.focus()
  }, [plugin.id])

  const trust = publisherTrust(plugin)
  const components = componentKindLabels(plugin.provides)

  return (
    <aside
      aria-label={`${plugin.name} details`}
      className="sticky top-2 w-72 shrink-0 self-start rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginIcon iconUrl={resolveIconUrl(registryUrl, plugin.icon)} name={plugin.name} size={32} />
          <div className="min-w-0">
            <h5 ref={headingRef} tabIndex={-1} className="truncate text-[14px] font-semibold leading-5 text-[color:var(--text-strong)] focus:outline-none">
              {plugin.name}
            </h5>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
              <StatusDot tone={trust.tone} />
              <span className="truncate">
                {trust.label} · {plugin.publisher.name}
              </span>
            </div>
          </div>
        </div>
        <CloseIconButton onClick={onClose} aria-label="Close details" />
      </div>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
        <span className="tabular-nums">Version {plugin.latest}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{plugin.category}</span>
      </div>

      <p className="mt-3 text-[12px] leading-5 text-[color:var(--text-muted)]">{plugin.summary}</p>

      <div className="mt-3">
        <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Components</div>
        <ul className="mt-1 space-y-0.5 text-[12px] text-[color:var(--text-muted)]">
          {components.map((label) => (
            <li key={label} className="flex gap-1.5">
              <span aria-hidden className="text-[color:var(--text-subtle)]">·</span>
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Honest Phase-2 disclosure: the registry index does not carry the
          permission list or changelog — those come from the signed plugin.json
          that is fetched and verified at install (Phase 3), so we never fabricate
          them here. */}
      <p className="mt-3 border-l-2 border-[color:var(--border-strong)] pl-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
        Requested permissions and version history are shown when you install this extension.
      </p>

      {plugin.source ? (
        <a
          href={plugin.source}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex text-[12px] font-semibold text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] focus:outline-none focus-visible:underline"
        >
          View source
        </a>
      ) : null}

      <div className="mt-4">
        {/* Phase-2 guardrail: install lands in Phase 3. Disabled, never a fake
            success. No purchase/Buy affordance anywhere (D4). */}
        <PrimaryButton disabled size="md" className="h-9 w-full">
          Install — coming soon
        </PrimaryButton>
      </div>
    </aside>
  )
}

type PluginTrust = { verified: boolean; tone: 'good' | 'neutral'; label: string }

// First-party verified publishers vs. community. The registry signature is
// always present; "Verified" is the matched first-party publisher, "Community"
// is everyone else (untrusted until the user trusts at install — D3).
function publisherTrust(plugin: MarketplacePluginEntry): PluginTrust {
  return plugin.publisher.verified
    ? { verified: true, tone: 'good', label: 'Verified' }
    : { verified: false, tone: 'neutral', label: 'Community' }
}

function resolveIconUrl(registryUrl: string | null, icon: string): string | null {
  if (!registryUrl || !icon) return null
  try {
    return new URL(icon, registryUrl).toString()
  } catch {
    return null
  }
}

function PluginIcon({ iconUrl, name, size = 36 }: { iconUrl: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (!iconUrl || failed) {
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
      src={iconUrl}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="pointer-events-none select-none rounded-md"
    />
  )
}
