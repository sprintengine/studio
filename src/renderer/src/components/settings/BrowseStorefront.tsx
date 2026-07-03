import { useCallback, useEffect, useRef, useState } from 'react'

import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import type { CapabilityPermission } from '../../../../shared/modules/permissions'
import type { McpServerConfig, McpSettings } from '../../types/workspace'
import { CloseIconButton, GhostButton, InboxSearchInput, InlineNotice, PrimaryButton, Spinner, StatusDot, TruncatedText } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'
import { mcpMonogram } from './McpCatalog'
import { PermissionChips } from './ThirdPartyModuleList'
import {
  type BrowseLoad,
  componentKindLabels,
  deriveBrowseView,
} from './storefrontView'
import {
  classifyVerification,
  deriveInstallView,
  summarizeInstallResult,
  type InstallFlowState,
} from './installFlow'

// Settings → Extensions → Browse: the storefront over the first-party registry.
// The grid/detail data comes from the T2.1 RegistryClient (the registry INDEX
// only, so cards show real components-carried + version). The detail panel hosts
// the Phase-3 trust-gate install flow: clicking Install runs the T3.4
// verifyMarketplacePlugin IPC (real download + ed25519-verify, no install), then
// verified plugins install directly, signed community plugins show a trust prompt
// populated with the REAL verified permissions before install, and unsigned/
// invalid bundles hard-block with no install affordance. No permission is ever
// fabricated (the index omits them; they come only from the verified signed
// manifest), and there are no purchase/Buy affordances (D4). The browse state
// machine lives in `storefrontView`; the install state machine lives in the
// DOM-free `installFlow` view-model.

export function BrowseStorefront({
  workspaceRoot,
  mcpSettings,
  onInstalled,
  onUpsertMcpServer,
}: {
  workspaceRoot: string | null
  mcpSettings: McpSettings
  // Re-list the Installed tab's IPC sources after a successful install so the
  // new plugin's components appear without a reload (AC4).
  onInstalled: () => void
  // Push the install result's MCP servers into the workspace store so MCP
  // components reflect in the Installed inventory (its rows read store servers).
  onUpsertMcpServer: (server: McpServerConfig) => void
}) {
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
              <PluginDetailPanel
                // Key by plugin id so switching the selected plugin remounts the
                // panel: a verify/install in flight for the previous plugin can't
                // resolve onto the new plugin's flow state (stale-closure race).
                key={selected.id}
                plugin={selected}
                registryUrl={registryUrl}
                workspaceRoot={workspaceRoot}
                mcpSettings={mcpSettings}
                onInstalled={onInstalled}
                onUpsertMcpServer={onUpsertMcpServer}
                onClose={closeDetail}
              />
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
  const trust = pluginTrust(plugin)
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
        <TruncatedText
          as="div"
          text={plugin.name}
          className="text-[13px] font-semibold leading-5 text-[color:var(--text-strong)]"
        />
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {/* Decorative: the adjacent label names the trust state. Verified is the
              quiet default — the lower tiers surface the dot to earn attention. */}
          {trust.tier === 'verified' ? null : <StatusDot tone={trust.tone} />}
          <TruncatedText
            as="span"
            text={trust.tier === 'verified' ? plugin.publisher.name : `${plugin.publisher.name} · ${trust.label}`}
          />
        </div>
      </div>
    </button>
  )
}

function PluginDetailPanel({
  plugin,
  registryUrl,
  workspaceRoot,
  mcpSettings,
  onInstalled,
  onUpsertMcpServer,
  onClose,
}: {
  plugin: MarketplacePluginEntry
  registryUrl: string | null
  workspaceRoot: string | null
  mcpSettings: McpSettings
  onInstalled: () => void
  onUpsertMcpServer: (server: McpServerConfig) => void
  onClose: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [flow, setFlow] = useState<InstallFlowState>({ status: 'idle' })

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
    // A fresh selection starts a fresh install flow — never inherit another
    // plugin's verify/trust/blocked state.
    setFlow({ status: 'idle' })
  }, [plugin.id])

  const trust = pluginTrust(plugin)
  const components = componentKindLabels(plugin.provides)
  const inlineServers = plugin.mcp?.servers ?? []
  // MCP servers and skill packs install into the open workspace; modules and
  // CLIs install to the user dirs. Block install with an honest hint when a
  // workspace-scoped component has no workspace, rather than letting the click
  // fail downstream.
  const needsWorkspace = plugin.provides.some((kind) => kind === 'mcp' || kind === 'skills')
  const workspaceBlocked = needsWorkspace && !workspaceRoot

  const runInstall = useCallback(
    async (trustGranted: boolean) => {
      setFlow({ status: 'installing' })
      try {
        const result = await window.api.installMarketplacePluginFromRegistry({
          entry: plugin,
          trustGranted,
          workspaceRoot: workspaceRoot ?? undefined,
          mcpSettings,
        })
        if (result.ok) {
          // Reflect installed MCP servers in the store so the Installed tab's
          // MCP rows update without a reload; re-list the other primitives.
          if (result.mcpSettings) {
            for (const server of Object.values(result.mcpSettings.servers)) onUpsertMcpServer(server)
          }
          onInstalled()
        }
        setFlow(summarizeInstallResult(result))
      } catch (error) {
        setFlow({
          status: 'error',
          message: error instanceof Error ? error.message : 'The install could not be completed.',
        })
      }
    },
    [plugin, workspaceRoot, mcpSettings, onInstalled, onUpsertMcpServer],
  )

  const startInstall = useCallback(async () => {
    // Inline-MCP entries ship their server config in the registry entry itself —
    // there is no bundle to download or verify. They are executable config, so they
    // always route through the explicit trust prompt — never a silent install — and
    // carry no capability permissions (those live only in signed module bundles).
    if (plugin.mcp) {
      setFlow({ status: 'needs-trust', permissions: [] })
      return
    }
    if (typeof window.api.verifyMarketplacePlugin !== 'function') {
      setFlow({ status: 'error', message: 'Installing extensions needs a newer app build. Update Multicode and restart.' })
      return
    }
    setFlow({ status: 'verifying' })
    let verify
    try {
      verify = await window.api.verifyMarketplacePlugin(plugin)
    } catch (error) {
      setFlow({ status: 'error', message: error instanceof Error ? error.message : 'Could not verify this extension.' })
      return
    }
    const outcome = classifyVerification(verify, plugin.provides)
    if (outcome.kind === 'blocked') {
      setFlow({ status: 'blocked', classification: outcome.classification, message: outcome.message, issues: outcome.issues })
      return
    }
    if (outcome.kind === 'needs-trust') {
      setFlow({ status: 'needs-trust', permissions: outcome.permissions })
      return
    }
    // Verified: install directly, no trust prompt.
    await runInstall(false)
  }, [plugin, runInstall])

  const installView = deriveInstallView(flow)

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
              <TruncatedText as="span" text={`${trust.label} · ${plugin.publisher.name}`} />
            </div>
          </div>
        </div>
        <CloseIconButton onClick={onClose} aria-label="Close details" />
      </div>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
        <span className="tabular-nums">Version {plugin.latest}</span>
        <span aria-hidden>·</span>
        <TruncatedText as="span" text={plugin.category} />
      </div>

      <p className="mt-3 text-[12px] leading-5 text-[color:var(--text-muted)]">{plugin.summary}</p>

      {plugin.tags?.length ? (
        <p className="mt-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">{plugin.tags.join(' · ')}</p>
      ) : null}

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

      {/* Phase-3 trust-gate install flow. Permissions shown here come only from
          the ed25519-verified signed manifest (via verifyMarketplacePlugin) and
          are never fabricated; unsigned/invalid never reach an install affordance;
          no purchase/Buy affordance anywhere (D4). */}
      <div className="mt-4 space-y-2">
        {installView.trustPrompt ? (
          <TrustPrompt tier={trust.tier} permissions={installView.permissions ?? []} inlineServers={inlineServers} />
        ) : null}

        {installView.notice ? (
          installView.notice.tone === 'good' ? (
            // Success has no InlineNotice tone; mirror the Installed tab's
            // StatusDot + text so the state is never colour-only.
            <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]" role="status">
              <StatusDot tone="good" />
              <span>{installView.notice.message}</span>
            </div>
          ) : (
            <InlineNotice tone={installView.notice.tone}>
              <div>{installView.notice.message}</div>
              {installView.notice.issues?.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {installView.notice.issues.slice(0, 4).map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
            </InlineNotice>
          )
        ) : null}

        {workspaceBlocked && !installView.busy ? (
          <p className="text-[11px] leading-4 text-[color:var(--text-subtle)]">
            Open a workspace to install this extension.
          </p>
        ) : null}

        {installView.busy ? (
          <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]" role="status">
            <Spinner size={14} />
            {installView.busyLabel}
          </div>
        ) : null}

        {installView.action ? (
          <div className={installView.trustPrompt ? 'flex gap-2' : ''}>
            <PrimaryButton
              size="md"
              className="h-9 w-full"
              disabled={workspaceBlocked}
              onClick={() =>
                void (installView.action?.kind === 'trust-install' ? runInstall(true) : startInstall())
              }
            >
              {installView.action.label}
            </PrimaryButton>
            {installView.trustPrompt ? (
              <GhostButton size="md" className="h-9" onClick={() => setFlow({ status: 'idle' })}>
                Cancel
              </GhostButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  )
}

// The pre-trust disclosure shown inside the trust prompt. Community/unsigned
// bundles disclose their real capability permissions (never fabricated); an
// inline-MCP entry has no capability permissions, so it discloses the executable
// server config the trust grant will run instead. Copy avoids any purchase/paywall
// framing (D4) and states plainly that trust is install-time, not a runtime sandbox.
function TrustPrompt({
  tier,
  permissions,
  inlineServers,
}: {
  tier: PluginTrustTier
  permissions: CapabilityPermission[]
  inlineServers: McpServerConfig[]
}) {
  const copy =
    tier === 'inline'
      ? {
          heading: 'Inline MCP server — review it before trusting',
          body: 'This entry runs a local command or connects to a remote endpoint as an MCP server. Trusting it adds and starts the server below — review it before you continue.',
        }
      : tier === 'unsigned'
        ? {
            heading: 'Unsigned extension — review before trusting',
            body: "This extension isn’t signed, so its publisher and contents can’t be verified. Trusting it installs it with the app’s access — install-time disclosure, not a runtime sandbox.",
          }
        : {
            heading: 'Community extension — review the access it requests',
            body: 'This publisher isn’t verified. Trusting it lets its code run in Multicode with the app’s access — requested access is install-time disclosure, not a runtime sandbox.',
          }
  return (
    <div className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3">
      <div className="text-[11px] font-semibold text-[color:var(--text-default)]">{copy.heading}</div>
      <p className="mt-1 text-[11px] leading-4 text-[color:var(--text-subtle)]">{copy.body}</p>
      <div className="mt-2">
        {tier === 'inline' ? (
          <ul className="space-y-1">
            {inlineServers.map((server) => (
              <li key={server.id} className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
                  <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">{server.transport}</span>
                  <TruncatedText as="span" text={server.name} className="font-medium" />
                </div>
                <TruncatedText
                  as="div"
                  text={inlineServerCommand(server)}
                  className="mt-0.5 font-mono text-[10px] leading-4 text-[color:var(--text-subtle)]"
                />
              </li>
            ))}
          </ul>
        ) : (
          <PermissionChips permissions={permissions} />
        )}
      </div>
    </div>
  )
}

// The executable summary of an inline MCP server: the stdio command line, or the
// endpoint URL for http/sse transports. This is what the trust grant will run.
function inlineServerCommand(server: McpServerConfig): string {
  if (server.transport === 'stdio') {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') || '(no command)'
  }
  return server.url || '(no endpoint)'
}

type PluginTrustTier = 'verified' | 'community' | 'unsigned' | 'inline'
type PluginTrust = { tier: PluginTrustTier; tone: 'good' | 'neutral'; label: string }

// The signing/trust tier disclosed on the card and detail header, read straight
// from the registry entry (no download needed). Inline-MCP entries ship raw server
// config; unsigned bundles carry no signature; signed bundles are Verified (matched
// first-party publisher) or Community (everyone else). All three lower tiers are
// untrusted until the user grants trust at install (D3). Verified is the quiet
// default (no dot); the rest surface the neutral dot to earn attention.
function pluginTrust(plugin: MarketplacePluginEntry): PluginTrust {
  if (plugin.mcp) return { tier: 'inline', tone: 'neutral', label: 'Inline MCP' }
  if (!plugin.signature) return { tier: 'unsigned', tone: 'neutral', label: 'Unsigned' }
  return plugin.publisher.verified
    ? { tier: 'verified', tone: 'good', label: 'Verified' }
    : { tier: 'community', tone: 'neutral', label: 'Community' }
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
