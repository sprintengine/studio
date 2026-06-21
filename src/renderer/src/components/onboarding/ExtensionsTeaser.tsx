import { useCallback, useEffect, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { GhostButton, Spinner, StatusDot } from '../ui'
import { mcpMonogram } from '../settings/mcpMonogram'
import { EXTENSIONS_BROWSE_DEEPLINK } from '../settings/extensionsRoute'
import { componentKindLabels, deriveBrowseView, type BrowseLoad } from '../settings/storefrontView'
import { deriveTeaserView } from './extensionsTeaserView'
import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'

// Essentials-step extensions teaser (T4). A lightweight discovery beat — not the
// full Browse surface. It reuses the storefront view-model
// (`readMarketplaceRegistry` → `deriveBrowseView`) so the entries shown are the
// REAL registry's leading plugins, never sample/placeholder data, and inherits
// its honest loading / offline / error / empty states. Its one-tap CTA opens the
// real Settings → Extensions → Browse surface, where the existing verified
// `installFlow` pipeline lives — the teaser never forks an install path of its
// own. OnboardingFlow yields while that overlay is open, then returns to this step.
//
// Kept structurally lightweight: shared deep-link id + monogram + the teaser
// state machine live in pure component-free modules (extensionsRoute /
// mcpMonogram / extensionsTeaserView), so onboarding never pulls the lazy
// Settings/Browse component graph into its bundle.

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

  const view = deriveTeaserView(deriveBrowseView(load, ''))

  if (view.kind === 'hidden') return null

  if (view.kind === 'loading') {
    return (
      <TeaserSection>
        <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
          <Spinner className="icon-sm shrink-0" />
          Looking for extensions to add…
        </div>
      </TeaserSection>
    )
  }

  if (view.kind === 'error') {
    return (
      <TeaserSection>
        <p className="text-[12px] text-[color:var(--text-muted)]">
          Couldn’t load extensions right now. You can browse them later in Settings.
        </p>
      </TeaserSection>
    )
  }

  if (view.kind === 'offline') {
    return (
      <TeaserSection>
        <p className="text-[12px] text-[color:var(--text-muted)]">
          You’re offline — browse extensions later in Settings → Extensions.
        </p>
      </TeaserSection>
    )
  }

  if (view.kind === 'empty') {
    return (
      <TeaserSection>
        {view.staleNotice ? <StaleNotice message={view.staleNotice} /> : null}
        <p className="text-[12px] text-[color:var(--text-muted)]">No extensions published yet.</p>
      </TeaserSection>
    )
  }

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
        {/* Ghost spec (knowledge/brand/BRAND-APP.md): hairline border on hover
            only. Transparent border holds the layout so hover doesn't shift it. */}
        <GhostButton
          size="sm"
          onClick={openBrowse}
          className="shrink-0 border border-transparent hover:border-[color:var(--border-subtle)]"
        >
          Browse extensions
        </GhostButton>
      </div>

      {view.staleNotice ? <div className="mt-2"><StaleNotice message={view.staleNotice} /></div> : null}

      <ul className="mt-2.5 divide-y divide-[color:var(--border-subtle)]">
        {view.plugins.map((plugin) => (
          <TeaserRow key={plugin.id} plugin={plugin} />
        ))}
      </ul>
    </TeaserSection>
  )
}

// Honest disclosure that the previewed list is a cached/seed fallback, not the
// live registry — shape-coded (dot + text), never colour-only.
function StaleNotice({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
      <StatusDot tone="neutral" className="mt-1 shrink-0" />
      <span>{message}</span>
    </p>
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
