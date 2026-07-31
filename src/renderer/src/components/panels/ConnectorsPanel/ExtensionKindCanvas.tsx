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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AGENT_BACKED_ACTION_KINDS, type AutomationDefinition } from '../../../../../shared/automations/contracts'
import type { MarketplacePluginInstalledComponent } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import {
  CloseIconButton,
  DefinitionList,
  GhostButton,
  IconButton,
  InboxSearchInput,
  InlineNotice,
  PrimaryButton,
  ProviderRow,
  RefreshIcon,
  Spinner,
  Tooltip,
  type StatusTone,
} from '../../ui'
import { PlusIcon } from '../../AppIcons'
import { PluginDetailPanel, PluginIcon, pluginTrust, resolveIconUrl } from '../../settings/BrowseStorefront'
import { cadenceSummary } from '../AutomationsPanel/automationsFormat'
import { formatRelativeMsAgo } from '../../../utils/relativeTime'
import { ConnectorEntryRow, ConnectorSectionHeading } from './ConnectorRow'
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
// Automations: added-or-not, read from the project's own store
// ---------------------------------------------------------------------------

// The automations this project already has, keyed by the catalogue entry each
// one came from. `sourceCatalogueId` is the provenance the install stamps
// (MC-2030) and the only honest answer to "is this already added" — matching on
// the definition's name would call a hand-written automation of the same name a
// shelf install, and would miss a renamed one.
type ProjectAutomations =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; byCatalogueId: ReadonlyMap<string, AutomationDefinition> }

function useProjectAutomations(workspaceRoot: string | null, active: boolean): {
  state: ProjectAutomations
  reload: () => Promise<void>
} {
  const [state, setState] = useState<ProjectAutomations>({ status: 'loading' })

  const reload = useCallback(async () => {
    if (!active) return
    if (!workspaceRoot) {
      // No project open is not a failed read: nothing can be added yet, and the
      // Get affordance discloses why on its own.
      setState({ status: 'ready', byCatalogueId: new Map() })
      return
    }
    if (typeof window.api.listInstanceAutomations !== 'function') {
      setState({ status: 'error', message: 'Reading this project’s automations needs a newer app build.' })
      return
    }
    try {
      const result = await window.api.listInstanceAutomations()
      if (!result.ok) {
        setState({ status: 'error', message: result.message })
        return
      }
      const byCatalogueId = new Map<string, AutomationDefinition>()
      for (const entry of result.value.entries) {
        // The index spans every open project; this shelf answers for the one
        // Get would install into.
        if (entry.workspaceRoot !== workspaceRoot) continue
        const catalogueId = entry.definition.sourceCatalogueId
        if (catalogueId) byCatalogueId.set(catalogueId, entry.definition)
      }
      setState({ status: 'ready', byCatalogueId })
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not read this project’s automations.',
      })
    }
  }, [active, workspaceRoot])

  useEffect(() => {
    void reload()
  }, [reload])

  // Definitions can change from the Automations door (or another window) while
  // this shelf is open, so the row state follows the store rather than only the
  // installs this surface performed.
  useEffect(() => {
    if (!active || typeof window.api.onAutomationsDefinitionsChanged !== 'function') return
    return window.api.onAutomationsDefinitionsChanged((event) => {
      if (event.workspaceRoot === workspaceRoot) void reload()
    })
  }, [active, workspaceRoot, reload])

  return { state, reload }
}

// The trailing segment of a project root — what a person calls the project.
function projectName(workspaceRoot: string): string {
  const parts = workspaceRoot.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? workspaceRoot
}

// The permission a run will actually launch on. Wording matches the Automations
// editor's own options (AutomationEditor.tsx PERMISSION_PRESET_ITEMS) so the
// shelf and the place it hands off to say the same thing; an unset preset reads
// as the unattended default the spawn resolves, never as blank.
const PERMISSION_LABEL: Record<string, string> = {
  default: 'Default — asks before acting',
  auto_workspace: 'Auto in workspace — fewer prompts',
  bypass_all: 'Bypass all — runs unattended',
}

// `action.config` is provider-owned `unknown` — a third-party action may put
// anything there — so every read of it is defensive rather than a cast.
function actionField(definition: AutomationDefinition, field: string): string | null {
  const config = definition.action.config
  if (!config || typeof config !== 'object') return null
  const value = (config as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim() ? value : null
}

function isAgentBacked(definition: AutomationDefinition): boolean {
  return AGENT_BACKED_ACTION_KINDS.includes(definition.action.kind)
}

function permissionLabel(definition: AutomationDefinition): string {
  const preset = actionField(definition, 'permissionPreset') ?? 'bypass_all'
  return PERMISSION_LABEL[preset] ?? PERMISSION_LABEL.bypass_all
}

// What an automation row says and offers, derived from the one thing that
// decides it: whether this project already holds the automation this catalogue
// entry produces.
//
// The state line is STATE, and the dot follows it — good once added, neutral
// while it is not. It is NOT a trust tier: signing does not apply to this kind,
// so no verified/unsigned/community vocabulary appears here or anywhere else on
// this surface. The action is earned by the state, because an automation already
// in this project cannot be added to it again.
//
// Until the project's store has been read the answer is genuinely unknown, and
// the row says so rather than defaulting to "Not added": a definitive negative
// offering a Get, shown while the read is still in flight or after it failed,
// is the surface lying about the one state it exists to carry.
export function automationShelfRowState(
  entry: ConnectorEntry,
  added: AutomationDefinition | null,
  projectKnown: boolean,
): { health: StatusTone; stateLine: string; action: 'get' | 'open' | 'none' } {
  if (added) {
    return {
      health: 'good',
      stateLine: `${added.status === 'enabled' ? 'Added' : `Added, ${added.status}`} — ${cadenceSummary(added.trigger)}`,
      action: 'open',
    }
  }
  if (!projectKnown) {
    return {
      health: 'neutral',
      stateLine: `Checking this project — published by ${entry.plugin?.publisher.name ?? 'an unnamed publisher'}`,
      action: 'none',
    }
  }
  return {
    health: 'neutral',
    stateLine: `Not added — published by ${entry.plugin?.publisher.name ?? 'an unnamed publisher'}`,
    action: 'get',
  }
}

function AutomationRegistryRow({
  entry,
  registryUrl,
  added,
  projectKnown,
  selected,
  installing,
  busy,
  onSelect,
  onGet,
  onOpen,
}: {
  entry: ConnectorEntry
  registryUrl: string | null
  added: AutomationDefinition | null
  projectKnown: boolean
  selected: boolean
  installing: boolean
  /** Any install is in flight. Adds write to one per-project store, so the shelf
   *  runs one at a time rather than racing two writers on the same file. */
  busy: boolean
  onSelect: () => void
  onGet: () => void
  onOpen: () => void
}): JSX.Element {
  const plugin = entry.plugin
  const state = automationShelfRowState(entry, added, projectKnown)
  return (
    <ProviderRow
      icon={
        <PluginIcon
          iconUrl={plugin ? resolveIconUrl(registryUrl, plugin.icon) : null}
          name={entry.name}
          size={22}
        />
      }
      health={state.health}
      name={entry.name}
      // The registry's bundle revision is not the automation's version, and an
      // automation has no version of its own. The slot stays empty rather than
      // saying "unknown".
      version={null}
      stateLine={state.stateLine}
      selected={selected}
      onSelect={onSelect}
      actions={
        state.action === 'open' ? (
          <GhostButton
            size="xs"
            onClick={onOpen}
            className="border border-[color:var(--border-default)]"
            aria-label={`Open ${entry.name} in Automations`}
          >
            Open
          </GhostButton>
        ) : state.action === 'get' ? (
          <GhostButton
            size="xs"
            onClick={onGet}
            disabled={busy}
            className="border border-[color:var(--border-default)]"
            aria-label={`Get ${entry.name}`}
          >
            {installing ? <Spinner size={12} /> : 'Get'}
          </GhostButton>
        ) : // Nothing to offer until the project's store has answered: a Get here
        // would act on a state the surface does not yet know.
        null
      }
    />
  )
}

// The automation detail aside. Everything the row may not carry lives here: the
// description, what adding it will do, and — once it is added — the schedule and
// prompt the project actually holds. One primary, because an inspector aside is
// its own view.
//
// Nothing here is editable: this shelf configures nothing. The facts are read
// from the real definition once there is one, and before that only from what the
// install path itself guarantees (`catalogueDraftInput` in
// src/main/automations/definition-write.ts forces `status: 'enabled'` and strips
// `runInWorktree`, so both are true of every automation added from here). The
// registry index carries no automation payload, so the cadence, agent and prompt
// of an entry that is NOT yet added are genuinely unknown to this surface and
// are left out rather than guessed at.
function AutomationDetailPanel({
  plugin,
  registryUrl,
  added,
  projectKnown,
  workspaceRoot,
  installing,
  onGet,
  onOpen,
  onClose,
}: {
  plugin: MarketplacePluginEntry
  registryUrl: string | null
  added: AutomationDefinition | null
  projectKnown: boolean
  workspaceRoot: string | null
  installing: boolean
  onGet: () => void
  onOpen: () => void
  onClose: () => void
}): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Selecting a row opens this pane, so focus follows the selection into it and
  // Escape gives it back — the same contract PluginDetailPanel keeps for the
  // other kinds, so a keyboard user is not stranded on a list beside a pane they
  // cannot reach.
  useEffect(() => {
    headingRef.current?.focus()
  }, [plugin.id])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const prompt = added ? actionField(added, 'prompt') : null
  const facts = added
    ? [
        { term: 'Runs', description: cadenceSummary(added.trigger) },
        {
          term: 'Runs in',
          description: added.runInWorktree === false ? 'This project’s checkout' : 'Its own worktree and branch',
        },
        // Agent and permission belong to an action that launches one. A
        // non-agent action has neither, so it gets neither row rather than a
        // default that would not be true of it.
        ...(isAgentBacked(added)
          ? [
              {
                term: 'Agent',
                description: (() => {
                  const specialist = actionField(added, 'specialistId')
                  return specialist ? `Role — ${specialist}` : 'Plain — no role, no soul'
                })(),
              },
              { term: 'Permission', description: permissionLabel(added) },
            ]
          : []),
      ]
    : [
        { term: 'Runs in', description: 'Its own worktree and branch' },
        { term: 'Starts', description: 'Enabled, on its own schedule' },
        { term: 'Adds to', description: workspaceRoot ? projectName(workspaceRoot) : 'No project is open' },
      ]

  return (
    <aside
      aria-label={`${plugin.name} details`}
      className="sticky top-2 w-88 shrink-0 self-start rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginIcon iconUrl={resolveIconUrl(registryUrl, plugin.icon)} name={plugin.name} size={32} />
          <div className="min-w-0">
            <h5
              ref={headingRef}
              tabIndex={-1}
              // design-system-allow: heading is a programmatic focus target only (tabIndex -1, moved to on selection) — it never receives keyboard focus
              className="truncate text-title font-semibold text-[color:var(--text-strong)] focus:outline-none"
            >
              {plugin.name}
            </h5>
            <div className="mt-0.5 truncate text-meta text-[color:var(--text-muted)]">{plugin.publisher.name}</div>
          </div>
        </div>
        <CloseIconButton onClick={onClose} aria-label="Close details" />
      </div>

      <p className="mb-5 mt-4 text-body leading-5 text-[color:var(--text-default)]">{plugin.summary}</p>

      <DefinitionList items={facts} />

      {prompt ? (
        <p className="mt-5 whitespace-pre-wrap rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3 font-mono text-micro leading-[var(--text-line-relaxed)] text-[color:var(--text-muted)]">
          {prompt}
        </p>
      ) : null}

      <div className="mt-6">
        {added ? (
          <PrimaryButton size="md" className="h-control-md w-full" onClick={onOpen}>
            Open in Automations
          </PrimaryButton>
        ) : (
          <PrimaryButton
            size="md"
            className="h-control-md w-full"
            // Until the project's store has answered, adding could act on an
            // automation that is already there — so it waits rather than guessing.
            disabled={!workspaceRoot || !projectKnown || installing}
            onClick={onGet}
          >
            {installing ? 'Adding…' : 'Add to Automations'}
          </PrimaryButton>
        )}
        {!added && !workspaceRoot ? (
          <p className="mt-2 text-meta leading-4 text-[color:var(--text-subtle)]">
            Open a project to add this automation to it.
          </p>
        ) : null}
      </div>
    </aside>
  )
}

// The list's chrome row: title on the left, the freshness of the registry read
// and the two list-wide controls on the right. One band rather than a toolbar
// stacked on a status line — the same shape Settings → Agent CLIs uses.
function AutomationsBand({
  count,
  checkedAt,
  now,
  addPending,
  onAdd,
  onRefresh,
}: {
  count: number
  checkedAt: number | null
  now: number
  addPending: boolean
  onAdd: () => void
  onRefresh: () => void
}): JSX.Element {
  const freshness = formatRelativeMsAgo(checkedAt, now)
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="text-title font-semibold text-[color:var(--text-strong)]">Automations</h3>
        <span className="tabular-nums text-body text-[color:var(--text-muted)]">{count}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {freshness ? (
          <span className="text-micro text-[color:var(--text-subtle)]">{`Checked ${freshness}`}</span>
        ) : null}
        <Tooltip content="Add an automation from a folder">
          <IconButton aria-label="Add an automation from a folder" disabled={addPending} onClick={onAdd}>
            {addPending ? <Spinner className="icon-sm" /> : <PlusIcon className="icon-sm" />}
          </IconButton>
        </Tooltip>
        <Tooltip content="Check the marketplace again">
          <IconButton aria-label="Check the marketplace again" onClick={onRefresh}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  )
}

// What the last Get did, stated once above the list rather than per row: a
// success names the project it landed in (a wrong-project install is otherwise
// invisible), a failure carries the installer's own reason.
type ShelfInstallState =
  | { status: 'idle' }
  | { status: 'installing'; key: string }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string; issues?: string[] }

// Automations are declarative — a trigger, a schedule and a prompt the app's own
// engine interprets — which is why this shelf adds them in one press with no
// signing or trust language anywhere. A bundle that ALSO carries a module or a
// CLI is code, and its access belongs on the shelf that discloses it, so this
// one refuses it rather than granting trust on the user's behalf.
function codeBearing(plugin: MarketplacePluginEntry): boolean {
  return plugin.provides.some((kind) => kind === 'module' || kind === 'cli')
}

// What a successful add says. The installer's own component message is the
// authority on WHAT happened — it distinguishes a fresh add from an entry that
// was already there, which is also a success (idempotence, not a second copy) —
// and the shelf adds the one thing only it knows: WHICH project it landed in,
// since an add into the wrong project is otherwise invisible.
function addedMessage(
  installed: MarketplacePluginInstalledComponent[],
  fallbackName: string,
  workspaceRoot: string,
): string {
  const outcome = installed.find((entry) => entry.kind === 'automation')?.message ?? `Added ${fallbackName}.`
  return `${outcome} (${projectName(workspaceRoot)})`
}

export function ExtensionKindCanvas({
  kind,
  sources,
  workspaceRoot,
  automationDefaultCli,
  onOpenAutomation,
  onAutomationAdded,
}: {
  kind: ExtensionKind
  sources: ConnectorSources
  workspaceRoot: string | null
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
  const [install, setInstall] = useState<ShelfInstallState>({ status: 'idle' })
  const [folderPending, setFolderPending] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const project = useProjectAutomations(workspaceRoot, isAutomation)
  const projectReload = project.reload

  // The band's freshness has to age or it lies: "Checked just now" would stay on
  // screen an hour later.
  const registryStatus = sources.registryLoad.status
  useEffect(() => {
    if (registryStatus === 'ready') setCheckedAt(Date.now())
  }, [registryStatus, sources.registryLoad])
  useEffect(() => {
    if (!isAutomation) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [isAutomation])

  const installAutomation = useCallback(
    async (plugin: MarketplacePluginEntry, key: string) => {
      if (!workspaceRoot) {
        setInstall({ status: 'error', message: 'Open the project this automation should run in, then add it again.' })
        return
      }
      if (codeBearing(plugin)) {
        setInstall({
          status: 'error',
          message: `${plugin.name} also installs code, so it is added from the Modules or Agent CLIs shelf, where the access it asks for is shown first.`,
        })
        return
      }
      if (typeof window.api.installMarketplacePluginFromRegistry !== 'function') {
        setInstall({ status: 'error', message: 'Adding automations needs a newer app build. Update and restart.' })
        return
      }
      setInstall({ status: 'installing', key })
      try {
        const result = await window.api.installMarketplacePluginFromRegistry({
          entry: plugin,
          // An automation carries no code, so there is no access to disclose and
          // no trust decision to put in front of the user — the same rule skills
          // and MCP entries already follow. The code-bearing refusal above is
          // what keeps this from becoming a blanket grant.
          trustGranted: true,
          workspaceRoot,
          mcpSettings: sources.mcpSettings,
          ...(automationDefaultCli ? { automationDefaultCli } : {}),
        })
        if (!result.ok) {
          setInstall({
            status: 'error',
            message: result.message,
            ...(result.issues?.length ? { issues: result.issues.map((issue) => issue.message) } : {}),
          })
          return
        }
        setInstall({ status: 'done', message: addedMessage(result.installed, plugin.name, workspaceRoot) })
        // Re-read this project's automations, not the whole registry: the row
        // flips because the store changed, and the marketplace did not.
        await projectReload()
        // Then leave: the automation is tailored in the Automations door, never
        // here (MC-2035). The receipt names the id the store issued, which is the
        // only handle this surface has on the definition it just created — the
        // door resolves it against its own index. Landing there IS the
        // confirmation, which is why it supersedes the "Added …" line rather
        // than competing with it.
        const addedId = result.installed.find((entry) => entry.kind === 'automation')?.id
        if (addedId) onAutomationAdded?.(addedId)
      } catch (error) {
        setInstall({
          status: 'error',
          message: error instanceof Error ? error.message : 'The automation could not be added.',
        })
      }
    },
    [workspaceRoot, sources.mcpSettings, automationDefaultCli, projectReload, onAutomationAdded],
  )

  const addFromFolder = useCallback(async () => {
    if (typeof window.api.installMarketplacePluginFolder !== 'function' || typeof window.api.openDir !== 'function') {
      setInstall({ status: 'error', message: 'Adding an automation from a folder needs a newer app build.' })
      return
    }
    if (!workspaceRoot) {
      setInstall({ status: 'error', message: 'Open the project this automation should run in, then add it again.' })
      return
    }
    setFolderPending(true)
    try {
      const folder = await window.api.openDir()
      if (!folder) return
      const result = await window.api.installMarketplacePluginFolder({
        localFolder: folder,
        workspaceRoot,
        mcpSettings: sources.mcpSettings,
        ...(automationDefaultCli ? { automationDefaultCli } : {}),
      })
      if (!result.ok) {
        setInstall({
          status: 'error',
          message: result.message,
          ...(result.issues?.length ? { issues: result.issues.map((issue) => issue.message) } : {}),
        })
        return
      }
      setInstall({ status: 'done', message: addedMessage(result.installed, result.displayName, workspaceRoot) })
      await projectReload()
      // Same hand-off as a Get: a folder that added an automation lands in the
      // door that configures it. A folder carrying no automation component
      // stays put — there is nothing for the door to open.
      const addedId = result.installed.find((entry) => entry.kind === 'automation')?.id
      if (addedId) onAutomationAdded?.(addedId)
    } catch (error) {
      setInstall({
        status: 'error',
        message: error instanceof Error ? error.message : 'The automation could not be added.',
      })
    } finally {
      setFolderPending(false)
    }
  }, [workspaceRoot, sources.mcpSettings, automationDefaultCli, projectReload, onAutomationAdded])

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
  // Added-or-not is only answerable once the project's store has been read. A
  // loading or failed read is `false` here, and the row says "Checking" rather
  // than the definitive negative it would otherwise imply.
  const projectKnown = project.state.status === 'ready'
  const addedFor = (entry: ConnectorEntry): AutomationDefinition | null =>
    project.state.status === 'ready' ? (project.state.byCatalogueId.get(entry.id) ?? null) : null
  const openAutomation = (definition: AutomationDefinition): void => onOpenAutomation?.(definition)

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

      {isAutomation ? (
        <div className="mt-4 space-y-2">
          <AutomationsBand
            count={matched.length}
            checkedAt={checkedAt}
            now={now}
            addPending={folderPending}
            onAdd={() => void addFromFolder()}
            onRefresh={() => void sources.loadRegistry(true)}
          />
          {/* This project's automations are what decides added-or-not. A store
              that cannot be read must say so: without it every row would read
              "Not added" and offer a Get that lands on one already there. */}
          {project.state.status === 'error' ? (
            <InlineNotice tone="warn">
              {`This project’s automations could not be read, so no row can say whether it is already added: ${project.state.message}`}
            </InlineNotice>
          ) : null}
          {install.status === 'done' ? (
            <div className="text-meta text-[color:var(--text-muted)]" role="status">
              {install.message}
            </div>
          ) : null}
          {install.status === 'error' ? (
            <InlineNotice tone="error">
              <div>{install.message}</div>
              {install.issues?.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {install.issues.slice(0, 4).map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
            </InlineNotice>
          ) : null}
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
            ) : isAutomation ? (
              <div>
                {matched.map((entry) => (
                  <AutomationRegistryRow
                    key={entry.key}
                    entry={entry}
                    registryUrl={sources.registryUrl}
                    added={addedFor(entry)}
                    projectKnown={projectKnown}
                    selected={selectedKey === entry.key}
                    installing={install.status === 'installing' && install.key === entry.key}
                    busy={install.status === 'installing' || folderPending}
                    onSelect={() => setSelectedKey(entry.key)}
                    onGet={() => {
                      if (entry.plugin) void installAutomation(entry.plugin, entry.key)
                    }}
                    onOpen={() => {
                      const definition = addedFor(entry)
                      if (definition) openAutomation(definition)
                    }}
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
            isAutomation ? (
              <AutomationDetailPanel
                key={selectedEntry.plugin.id}
                plugin={selectedEntry.plugin}
                registryUrl={sources.registryUrl}
                added={addedFor(selectedEntry)}
                projectKnown={projectKnown}
                workspaceRoot={workspaceRoot}
                installing={install.status === 'installing' && install.key === selectedEntry.key}
                onGet={() => {
                  if (selectedEntry.plugin) void installAutomation(selectedEntry.plugin, selectedEntry.key)
                }}
                onOpen={() => {
                  const definition = addedFor(selectedEntry)
                  if (definition) openAutomation(definition)
                }}
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
