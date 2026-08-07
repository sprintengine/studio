// The door's per-kind marketplace canvas (MC-1847 C2): capability modules and
// agent CLIs get browsable for the first time — the connector grid keeps its
// mcp/skills subset, and these render the registry's module/cli plugins with
// the same normalized rows and the same storefront install flow (trust gates
// included), no parallel machinery.
//
// Automations (MC-2034) are the third kind here, on the same rows and the same
// registry read. They differ in two ways the owner ruled on: the state a row
// carries is whether it is in THIS project (which the app can see) rather than a
// signing tier (which does not apply — an automation is a definition, never
// code), and the only action is Get. Nothing about how an automation runs is
// configured on this shelf; that is the Automations door's job.
//
// That kind's weight — the project read, the install, the band and the detail
// aside — lives in `AutomationShelf.tsx` beside this file (item 2042), so this
// one stays the canvas the three kinds genuinely share: the search box, the row
// list, and the loading, unavailable and empty states.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AutomationDefinition } from '../../../../../shared/automations/contracts'
import type {
  AgentCli,
  AgentCliAvailabilityMap,
  CliInstallResult,
  CliRuntimeSettings,
} from '../../../../../shared/electron-api'
import {
  CliProviderStateLine,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  PrimaryButton,
  ProviderRow,
  Spinner,
} from '../../ui'
import type { CliProbeStatus } from '../../ui/cliProviderState'
import { CliInstallControl } from '../../settings/CliInstallControl'
import { PluginDetailPanel, PluginIcon, pluginTrust, resolveIconUrl } from '../../settings/BrowseStorefront'
import { cliRuntimeForPlugin } from '../../workspace/newWorkspace/cliRuntimeOptions'
import type { PluginCatalogEntry, PluginCatalogStatus } from '../../../types/workspace'
import { AutomationShelfBand, AutomationShelfDetail, AutomationShelfRows, useAutomationShelf } from './AutomationShelf'
import { ConnectorEntryRow, ConnectorSectionHeading } from './ConnectorRow'
import { agentCliShelfRowState, type CliInstallMethodsLoad } from './agentCliShelfState'
import { registryEntriesForKinds, searchConnectors } from './connectorsFacets'
import type { ConnectorEntry } from './connectorsFacets'
import type { ConnectorSources } from './useConnectorSources'

export type ExtensionKind = 'module' | 'cli' | 'automation'

const KIND_COPY: Record<ExtensionKind, { label: string; searchAria: string; placeholder: string; empty: string }> = {
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
  automation: {
    label: 'Automations',
    searchAria: 'Search automations by name, category, or tag',
    placeholder: 'Search automations',
    empty: 'No automations are in the marketplace yet.',
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

// ---------------------------------------------------------------------------
// Agent CLIs with runtime state (MC-1858): the inline entries
// ---------------------------------------------------------------------------

// Everything the CLI shelf needs from the app, passed in by the door so this
// canvas stays store-free (the automationDefaultCli precedent). The runtime
// state and its refreshers are the EXISTING detection stack — the availability
// slice over `pluginsDetectAvailability` and the plugin catalog — never a
// second mechanism.
export type CliShelfRuntime = {
  /** `window.api.platform`, for the "Not available on macOS" state. */
  platform: string
  availability: AgentCliAvailabilityMap
  availabilityStatus: CliProbeStatus
  /** The batch probe's own failure, stated once above the list (the settings
   *  rule): every row would otherwise repeat one fact nine times. */
  availabilityError: string | null
  catalogEntries: PluginCatalogEntry[]
  catalogStatus: PluginCatalogStatus
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  refreshAvailability: (options?: {
    background?: boolean
    force?: boolean
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  }) => Promise<void>
  refreshCatalog: () => Promise<void>
  setCliRuntime: (cli: AgentCli, update: Partial<CliRuntimeSettings>) => void
}

// The inline agent-CLI rows: ProviderRow anatomy (the Settings → Agents list,
// per the 07-26 manage-canvas mockup), state from the shared probe reading, and
// install through CliInstallControl in the row's own disclosure — never
// PluginDetailPanel's bundle-download flow.
function AgentCliRuntimeRows({
  entries,
  registryUrl,
  runtime,
}: {
  entries: ConnectorEntry[]
  registryUrl: string | null
  runtime: CliShelfRuntime
}): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [installIntentId, setInstallIntentId] = useState<string | null>(null)
  // Install methods per plugin id, probed lazily for definitively-missing CLIs
  // only — the probe checks PATH prerequisites, so running it for installed
  // rows would be spend with no reader.
  const [methods, setMethods] = useState<Record<string, CliInstallMethodsLoad>>({})
  const methodsRef = useRef(methods)
  methodsRef.current = methods

  const catalogById = useMemo(() => {
    const map = new Map<string, PluginCatalogEntry>()
    for (const entry of runtime.catalogEntries) map.set(entry.id, entry)
    return map
  }, [runtime.catalogEntries])

  // One availability read on mount. The main process serves a 60s cache, so a
  // shelf visit right after boot or Settings reads the same probe rather than
  // spawning another login shell per CLI.
  const { refreshAvailability, cliRuntimes } = runtime
  useEffect(() => {
    void refreshAvailability({ cliRuntimes })
  }, [refreshAvailability, cliRuntimes])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.api?.cliInstallMethods !== 'function') return
    for (const entry of entries) {
      const pluginId = entry.plugin?.cli?.pluginId
      if (!pluginId || methodsRef.current[pluginId]) continue
      if (runtime.catalogStatus !== 'ready' || !catalogById.has(pluginId)) continue
      const availability = runtime.availability[pluginId]
      // Only a definitive negative probe needs the methods answer — it decides
      // Install vs "Not available on this platform".
      if (!availability || availability.installed) continue
      const override = cliRuntimeForPlugin(pluginId, runtime.cliRuntimes)
      setMethods((current) => ({ ...current, [pluginId]: { status: 'loading' } }))
      void window.api
        .cliInstallMethods(pluginId, { command: override.command, useWsl: override.useWsl })
        .then((loaded) => {
          setMethods((current) => ({ ...current, [pluginId]: { status: 'ready', methods: loaded } }))
        })
        .catch(() => {
          // An unanswered probe stays unknown: the row keeps its honest "Not
          // installed" line with no button rather than guessing either way.
          setMethods((current) => {
            const next = { ...current }
            delete next[pluginId]
            return next
          })
        })
    }
  }, [entries, runtime.availability, runtime.catalogStatus, runtime.cliRuntimes, catalogById])

  const onInstalled = useCallback(
    (pluginId: AgentCli, result: CliInstallResult) => {
      const override = cliRuntimeForPlugin(pluginId, runtime.cliRuntimes)
      // Persist the resolved binary path the way Settings does, so launches use
      // the binary the install actually produced.
      if (result.resolvedPath && !override.command) {
        runtime.setCliRuntime(pluginId, { command: result.resolvedPath, useWsl: override.useWsl })
      }
      void runtime.refreshCatalog()
      // Force past the main-process TTL so the freshly installed CLI reads as
      // installed here and in deployment pickers without an app restart.
      void runtime.refreshAvailability({ force: true, cliRuntimes: runtime.cliRuntimes })
    },
    [runtime],
  )

  return (
    <div>
      {entries.map((entry) => {
        const pluginId = entry.plugin?.cli?.pluginId ?? entry.id
        const catalog = catalogById.get(pluginId)
        const override = cliRuntimeForPlugin(pluginId, runtime.cliRuntimes)
        const state = agentCliShelfRowState({
          catalogStatus: runtime.catalogStatus,
          inCatalog: Boolean(catalog),
          availability: runtime.availability[pluginId],
          availabilityStatus: runtime.availabilityStatus,
          installMethods: methods[pluginId] ?? { status: 'unknown' },
          platform: runtime.platform,
          useWsl: override.useWsl,
        })
        return (
          <ProviderRow
            key={entry.key}
            icon={
              <PluginIcon
                iconUrl={entry.plugin ? resolveIconUrl(registryUrl, entry.plugin.icon) : null}
                name={entry.name}
                size={22}
              />
            }
            health={state.tone}
            name={entry.name}
            version={state.version}
            stateLine={
              state.words ??
              (state.provider && catalog ? (
                <CliProviderStateLine
                  state={state.provider}
                  binary={catalog.binary}
                  useWsl={override.useWsl}
                  // One list-wide fact, stated once above the band — not per row.
                  probeError={null}
                />
              ) : (
                ''
              ))
            }
            expanded={expandedId === entry.key}
            onExpandedChange={(next) => {
              setInstallIntentId(null)
              setExpandedId(next ? entry.key : null)
            }}
            actions={
              state.action === 'install' ? (
                <PrimaryButton
                  size="xs"
                  onClick={() => {
                    setInstallIntentId(entry.key)
                    setExpandedId(entry.key)
                  }}
                >
                  Install
                </PrimaryButton>
              ) : null
            }
          >
            <div className="space-y-2">
              {entry.summary ? (
                <p className="text-body leading-5 text-[color:var(--text-muted)]">{entry.summary}</p>
              ) : null}
              {catalog ? (
                <CliInstallControl
                  cli={pluginId}
                  displayName={catalog.displayName}
                  binary={catalog.binary}
                  command={override.command}
                  useWsl={override.useWsl}
                  showName={false}
                  showStatus={false}
                  autoOpenInstall={installIntentId === entry.key}
                  onInstalled={(result) => onInstalled(pluginId, result)}
                />
              ) : null}
            </div>
          </ProviderRow>
        )
      })}
    </div>
  )
}

export function ExtensionKindCanvas({
  kind,
  sources,
  workspaceRoot,
  cliRuntime,
  automationDefaultCli,
  onOpenAutomation,
  onAutomationAdded,
}: {
  kind: ExtensionKind
  sources: ConnectorSources
  workspaceRoot: string | null
  /** Runtime state + installers for the `cli` kind (MC-1858), read from the
   *  store by the door and passed down so this canvas stays store-free. Without
   *  it, inline CLI entries fall back to the plain registry row. */
  cliRuntime?: CliShelfRuntime
  /** The CLI an agent-backed automation falls back to when its own config names
   *  none. Only the app settings hold it, so the door reads it and passes it in;
   *  an install that would need it and does not get it is refused by the
   *  installer rather than creating a job that cannot launch. */
  automationDefaultCli?: string | null
  /** Hands an already-added automation to the Automations door, which owns
   *  everything about how it runs. */
  onOpenAutomation?: (definition: AutomationDefinition) => void
  /** A Get just landed. The shelf configures nothing (MC-2035), so it hands the
   *  new automation straight to the door that does — one navigation, not "it was
   *  added somewhere, go and find it". Only the store-issued id is known here;
   *  the door resolves it against its own index. */
  onAutomationAdded?: (automationId: string) => void
}): JSX.Element {
  const copy = KIND_COPY[kind]
  const isAutomation = kind === 'automation'
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // Everything the automation kind needs (item 2042). Called on every kind so
  // the hook order never changes; inactive it reads nothing and ticks nothing.
  const automations = useAutomationShelf({
    active: isAutomation,
    sources,
    workspaceRoot,
    automationDefaultCli,
    onOpenAutomation,
    onAutomationAdded,
  })

  const retry = (
    <GhostButton
      size="sm"
      onClick={() => void sources.loadRegistry(true)}
      className="border border-[color:var(--border-default)]"
    >
      Retry
    </GhostButton>
  )

  const entries = useMemo(
    () => (sources.registryLoad.status === 'ready' ? registryEntriesForKinds(sources.registryLoad.data, [kind]) : []),
    [sources.registryLoad, kind],
  )
  const matched = useMemo(() => searchConnectors(entries, query), [entries, query])

  // Kind canvases read the registry source alone — the MCP catalog carries no
  // modules, CLIs or automations, so its state must not gate (or blank) this page.
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

      {isAutomation ? <AutomationShelfBand shelf={automations} count={matched.length} /> : null}

      {/* The batch probe failing is one fact for the whole list (the settings
          rule): stated here once, while each row reads "availability unknown"
          without repeating the reason. */}
      {kind === 'cli' && cliRuntime && cliRuntime.availabilityStatus === 'error' && cliRuntime.availabilityError ? (
        <div className="mt-4">
          <InlineNotice tone="warn">{`Agent CLIs could not be checked: ${cliRuntime.availabilityError}`}</InlineNotice>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="px-1 py-10 text-center text-body text-[color:var(--text-muted)]">{copy.empty}</p>
      ) : matched.length === 0 ? (
        <p className="px-1 py-10 text-center text-body text-[color:var(--text-muted)]">
          {`No ${copy.label.toLowerCase()} match “${query.trim()}”.`}
        </p>
      ) : (
        <div className="mt-4 flex gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            {isAutomation ? null : <ConnectorSectionHeading label={copy.label} count={matched.length} />}
            {kind === 'cli' ? (
              <div>
                {/* Inline entries (`cli.pluginId`, the bundled twelve) carry
                    runtime state and install through the CLI runtime; signed
                    third-party CLI bundles keep the storefront Get flow. */}
                {cliRuntime ? (
                  <AgentCliRuntimeRows
                    entries={matched.filter((entry) => entry.plugin?.cli)}
                    registryUrl={sources.registryUrl}
                    runtime={cliRuntime}
                  />
                ) : null}
                {matched
                  .filter((entry) => !(cliRuntime && entry.plugin?.cli))
                  .map((entry) => (
                    <AgentCliRegistryRow
                      key={entry.key}
                      entry={entry}
                      registryUrl={sources.registryUrl}
                      selected={selectedKey === entry.key}
                      onOpen={() => setSelectedKey(entry.key)}
                    />
                  ))}
              </div>
            ) : isAutomation ? (
              <AutomationShelfRows
                shelf={automations}
                entries={matched}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
              />
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
            isAutomation ? (
              <AutomationShelfDetail
                key={selectedEntry.plugin.id}
                shelf={automations}
                entry={selectedEntry}
                plugin={selectedEntry.plugin}
                onClose={() => setSelectedKey(null)}
              />
            ) : (
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
            )
          ) : null}
        </div>
      )}
    </>
  )
}
