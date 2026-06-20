import { useCallback, useEffect, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { GhostButton, Spinner, StatusDot } from '../ui'
import { mcpMonogram } from '../settings/McpCatalog'
import { EXTENSIONS_BROWSE_DEEPLINK } from '../settings/ExtensionsSettingsTab'
import {
  type BrowseLoad,
  type BrowseView,
  componentKindLabels,
  deriveBrowseView,
} from '../settings/storefrontView'
import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'

// Essentials-step extensions teaser (T4). A lightweight discovery beat — not the
// full Browse surface. It reuses the storefront view-model
// (`readMarketplaceRegistry` → `deriveBrowseView`) so the entries shown are the
// REAL registry's leading plugins, never sample/placeholder data, and it inherits
// the same honest loading / offline / error / empty states. Its one-tap CTA opens
// the real Settings → Extensions → Browse surface, where the existing verified
// `installFlow` pipeline lives — the teaser never forks an install path of its
// own. OnboardingFlow yields while that overlay is open, then returns to this step.

// How many leading registry entries the teaser previews. Small on purpose: this
// is a taste of what's available, not a catalog.
const TEASER_LIMIT = 3

// The leading entries to preview, pulled from a `ready` browse view. Featured
// leads when present; otherwise the first categorized entries. Pure + exported
// so the "real entries only" selection is unit-testable.
export function selectTeaserPlugins(view: BrowseView, limit = TEASER_LIMIT): MarketplacePluginEntry[] {
  if (view.status !== 'ready') return []
  const lead = [...view.featured, ...view.groups.flatMap((group) => group.plugins)]
  return lead.slice(0, limit)
}

export function ExtensionsTeaser() {
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const [load, setLoad] = useState<BrowseLoad>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    if (typeof window.api.readMarketplaceRegistry !== 'function') {
      setLoad({ status: 'unsupported' })
      return undefined
    }
    setLoad({ status: 'loading' })
    void window.api
      .readMarketplaceRegistry()
      .then((result) => {
        if (!cancelled) setLoad({ status: 'result', result })
      })
      .catch((error) => {
        if (!cancelled) {
          setLoad({
            status: 'threw',
            message: error instanceof Error ? error.message : 'Could not read the extensions registry.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Land directly on the Browse sub-tab; OnboardingFlow steps aside while the
  // overlay is open so the real storefront (and its install flow) is reachable.
  const openBrowse = useCallback(() => {
    openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })
  }, [openSettingsOverlay])

  const view = deriveBrowseView(load, '')

  // An old build with no registry IPC has nothing to tease — omit the section
  // rather than show a dead control.
  if (view.status === 'unsupported') return null

  if (view.status === 'loading') {
    return (
      <TeaserSection>
        <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
          <Spinner className="icon-sm shrink-0" />
          Looking for extensions to add…
        </div>
      </TeaserSection>
    )
  }

  if (view.status === 'error') {
    return (
      <TeaserSection>
        <p className="text-[12px] text-[color:var(--text-muted)]">
          Couldn’t load extensions right now. You can browse them later in Settings.
        </p>
      </TeaserSection>
    )
  }

  if (view.status === 'offline') {
    return (
      <TeaserSection>
        <p className="text-[12px] text-[color:var(--text-muted)]">
          You’re offline — browse extensions later in Settings → Extensions.
        </p>
      </TeaserSection>
    )
  }

  if (view.status === 'empty') {
    return (
      <TeaserSection>
        <p className="text-[12px] text-[color:var(--text-muted)]">No extensions published yet.</p>
      </TeaserSection>
    )
  }

  const plugins = selectTeaserPlugins(view)
  if (plugins.length === 0) return null

  return (
    <TeaserSection labelledBy="extensions-teaser-heading">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="extensions-teaser-heading" className="text-[13px] font-semibold text-[color:var(--text-strong)]">
            Add extensions
          </h3>
          <p className="mt-0.5 text-[11px] leading-5 text-[color:var(--text-muted)]">
            MCP servers, skill packs, and more from the extensions registry.
          </p>
        </div>
        <GhostButton size="sm" onClick={openBrowse} className="shrink-0 border border-[color:var(--border-default)]">
          Browse extensions
        </GhostButton>
      </div>

      <ul className="mt-2.5 divide-y divide-[color:var(--border-subtle)]">
        {plugins.map((plugin) => (
          <TeaserRow key={plugin.id} plugin={plugin} />
        ))}
      </ul>
    </TeaserSection>
  )
}

function TeaserSection({
  children,
  labelledBy,
}: {
  children: React.ReactNode
  labelledBy?: string
}) {
  return (
    <section
      aria-label={labelledBy ? undefined : 'Extensions'}
      aria-labelledby={labelledBy}
      className="border-t border-[color:var(--border-subtle)] py-3"
    >
      {children}
    </section>
  )
}

function TeaserRow({ plugin }: { plugin: MarketplacePluginEntry }) {
  const components = componentKindLabels(plugin.provides).join(' · ')
  // Verified is the quiet default; only community plugins surface the dot to earn
  // attention. The adjacent label always names the state, so it's never colour-only.
  const verified = plugin.publisher.verified
  return (
    <li className="flex items-center gap-2.5 py-2">
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[color:var(--bg-active)] font-mono text-[11px] font-semibold text-[color:var(--text-default)]"
      >
        {mcpMonogram(plugin.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-[color:var(--text-default)]">{plugin.name}</span>
        {components ? (
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-[color:var(--text-subtle)]">
            {components}
          </span>
        ) : null}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-[color:var(--text-subtle)]">
        {verified ? null : <StatusDot tone="neutral" />}
        {verified ? plugin.publisher.name : `${plugin.publisher.name} · Community`}
      </span>
    </li>
  )
}
