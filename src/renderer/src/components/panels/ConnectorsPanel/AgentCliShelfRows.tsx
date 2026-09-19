// The agent-CLI rows, shared by the Extensions door's Agent CLIs catalogue and
// the kind canvas this was extracted from.
//
// Two row shapes, because there are two populations: the twelve CLIs the app
// knows how to detect and install (runtime state, install in the row's own
// disclosure) and a signed third-party CLI bundle (the storefront's Get flow).
// They moved out of ExtensionKindCanvas when the source-tabs ruling
// (2026-09-05) made Agent CLIs a catalogue of its own: the catalogue hands
// them ONE PAGE of entries at a time, which a component that fetched its own
// list could not do.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type {
  AgentCli,
  AgentCliAvailabilityMap,
  CliInstallResult,
  CliRuntimeSettings,
  CliVersionAdvisory,
  CliVersionAdvisoryMap,
} from '../../../../../shared/electron-api'
import { CliProviderStateLine, GhostButton, PrimaryButton, ProviderRow, type MarkBadge } from '../../ui'
import type { CliProbeStatus } from '../../ui/cliProviderState'
import { CliInstallControl } from '../../settings/CliInstallControl'
import { PluginIcon, pluginTrust, resolveIconUrl } from '../../settings/BrowseStorefront'
import { cliRuntimeForPlugin } from '../../workspace/newWorkspace/cliRuntimeOptions'
import type { PluginCatalogEntry, PluginCatalogStatus } from '../../../types/workspace'
import { agentCliShelfRowState, cliUpdateAvailable, type CliInstallMethodsLoad } from './agentCliShelfState'
import type { ConnectorEntry } from './connectorsFacets'

// An agent CLI in the marketplace, on the shared provider anatomy (item 1994).
// Same row as the installed list in Settings → Agents, read from what this
// surface actually knows: there is no local health probe here, so the state line
// carries the registry's own signing tier — the thing that decides whether you
// should run this CLI at all — and never implies an install state the registry
// cannot see. Version is the registry's bundle version, so it is labelled rather
// than dressed up as a semver.
//
// No health dot (owner, 2026-09-10). The tier is words on the state line and it
// is the same word on nearly every row here; a column of identical dots is a
// status idiom spent on a fact nobody is scanning for, and it crowds the corner
// the update count needs on the runtime rows beside it.
//
// Nothing else in the marketplace wears this anatomy: item 1994 gave it to the
// Agent CLIs list alone, and the capability-modules list it was measured
// against has since left the door entirely (module switches live in Settings →
// Modules, source-tabs ruling 2026-09-05).
//
// Both rows here draw the provider row's card surface: the catalogue puts each
// group in the settings list card (list-card ruling 2026-09-15), and a row
// loose in that card — its own radius, the narrower page inset — reads as a
// card in a card. The catalogue is these rows' only host, so the surface is
// stated here rather than threaded through a prop for one caller.
export function AgentCliRegistryRow({
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
      surface="card"
      icon={
        <PluginIcon iconUrl={plugin ? resolveIconUrl(registryUrl, plugin.icon) : null} name={entry.name} size={22} />
      }
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
// Agent CLIs with runtime state: the inline entries
// ---------------------------------------------------------------------------

/**
 * The corner count on a CLI's mark: one update, or nothing at all.
 *
 * The number is always 1, and that is the point — it is the unread pip, not an
 * inventory. What it buys is the thing the dot could not do: from across the
 * page, WHICH of the ten marks wants you. The name is in the label because
 * "1" beside a logo is not a sentence, and the version it is behind is in there
 * too, so the reader gets what the toast said without opening the row.
 */
export function agentCliUpdateBadge(
  name: string,
  advisory: CliVersionAdvisory | undefined,
  /** Whether the CLI is actually on the machine, from this row's own probe.
   *  The advisory map is NOT cleared when a refresh fails — the slice keeps the
   *  last good answer on purpose — so a CLI uninstalled since the last good
   *  check still reads `behind_latest`. Without this the row would recede AND
   *  wear a pip, which is the one combination `ProviderRow` says cannot happen,
   *  and the pip would be drawn at 60% inside the receded mark. Settings →
   *  Agents gates its own advisory line the same way. */
  present: boolean,
): MarkBadge | null {
  if (!present || !cliUpdateAvailable(advisory)) return null
  const latest = advisory?.latestVersion
  return {
    count: 1,
    tone: 'accent',
    label: latest ? `${name} — update available: ${latest}` : `${name} — update available`,
  }
}

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
  /** Installed version against the registry's newest, per CLI — the same
   *  advisories the update toast and the bell row read, so a row's corner count
   *  and the toast that announced it can never disagree. */
  versionAdvisories: CliVersionAdvisoryMap
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
//
// What a row says at a glance, after the owner arrived here from a notification
// and could not tell which CLI it was about (2026-09-10):
//
//   - no health dot. Ten rows, nine of them the same green, and the one fact
//     the person came for was not among them.
//   - a corner count on the mark where a CLI is behind its published version.
//     One update is "1", which is the pip's job: it is not a quantity, it is
//     "this one, here".
//   - a CLI this machine does not have recedes a contrast step, so the list
//     reads as what is here first and what could be here second.
export function AgentCliRuntimeRows({
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
            surface="card"
            icon={
              <PluginIcon
                iconUrl={entry.plugin ? resolveIconUrl(registryUrl, entry.plugin.icon) : null}
                name={entry.name}
                size={22}
              />
            }
            badge={agentCliUpdateBadge(entry.name, runtime.versionAdvisories[pluginId as AgentCli], state.present)}
            recessed={!state.present}
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
