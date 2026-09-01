// The automation half of the Extensions door's kind canvas (item 2042).
//
// `ExtensionKindCanvas.tsx` is the one canvas the three kinds share — the search
// box, the row list, the empty and unavailable states. Automations (MC-2034)
// needed far more than that shared shape: a read of THIS project's automations
// to answer added-or-not, an install that writes into it, a band with its own
// freshness and folder-add, and a detail aside that states what adding one will
// do. That weight is here rather than there, so a reader after the module canvas
// no longer reads the automation shelf to find it.
//
// Nothing about how an automation RUNS is configured on this shelf; that is the
// Automations door's job. The canvas keeps a single entry point: it calls
// `useAutomationShelf` once and renders the three pieces below in the slots the
// other kinds fill with their own.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  AGENT_BACKED_ACTION_KINDS,
  AUTOMATION_DEFAULT_PERMISSION_PRESET,
  type AutomationCliPermissionPreset,
  type AutomationDefinition,
} from '../../../../../shared/automations/contracts'
import type { MarketplacePluginInstalledComponent } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import {
  CloseIconButton,
  DefinitionList,
  GhostButton,
  IconButton,
  InlineNotice,
  PrimaryButton,
  ProviderRow,
  RefreshIcon,
  Spinner,
  Tooltip,
  type StatusTone,
} from '../../ui'
import { PlusIcon } from '../../AppIcons'
import { PluginIcon, resolveIconUrl } from '../../settings/BrowseStorefront'
import { cadenceSummary } from '../AutomationsPanel/automationsFormat'
import { formatRelativeMsAgo } from '../../../utils/relativeTime'
import { ConnectorSectionHeading } from './ConnectorRow'
import type { ConnectorEntry } from './connectorsFacets'
import type { ConnectorSources } from './useConnectorSources'

// ---------------------------------------------------------------------------
// Added-or-not, read from the project's own store
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
// editor's own options (AgentFields.tsx PERMISSION_PRESET_ITEMS) so the
// shelf and the place it hands off to say the same thing; an unset preset reads
// as the unattended default the spawn resolves, never as blank.
// Keyed by the closed preset union rather than by `string`, so the map must
// cover every preset: DEFAULT_PERMISSION_LABEL below reads out of it, and a
// preset added to the union without a label here would otherwise blank the
// aside's row rather than fail the build.
const PERMISSION_LABEL: Record<AutomationCliPermissionPreset, string> = {
  none: 'CLI default — whatever the CLI does',
  manual: 'Manual — asks before acting',
  auto: 'Auto — fewer prompts, CLI-supervised',
  bypass: 'Bypass all — runs unattended',
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

// The label an automation naming no preset will run on. Both asides read it from
// AUTOMATION_DEFAULT_PERMISSION_PRESET rather than from a literal of their own,
// so the pre-add and post-add asides cannot drift apart — or away from what
// parseSpawnAgentConfig actually resolves at launch.
const DEFAULT_PERMISSION_LABEL = PERMISSION_LABEL[AUTOMATION_DEFAULT_PERMISSION_PRESET]

function permissionLabel(definition: AutomationDefinition): string {
  // `permissionPreset` comes off provider-owned config, so it is any string
  // until it is checked against the map that has a label for it.
  const preset = actionField(definition, 'permissionPreset')
  return preset && preset in PERMISSION_LABEL
    ? PERMISSION_LABEL[preset as AutomationCliPermissionPreset]
    : DEFAULT_PERMISSION_LABEL
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

// The aside's fact list, over the one thing that decides it: whether this
// project already holds the automation. Once it does, every fact is read from
// the definition itself. Before that the surface has no automation payload —
// the registry index carries none — so it states only what adding it is
// guaranteed to produce: what `catalogueDraftInput`
// (src/main/automations/definition-write.ts) forces or strips, the project the
// add writes to, and the permission preset the app resolves for a run that pins
// none. Anything else about an unadded entry — its cadence, agent and prompt —
// is genuinely unknown here and is left out rather than guessed at.
export function automationDetailFacts(
  added: AutomationDefinition | null,
  workspaceRoot: string | null,
): Array<{ term: string; description: string }> {
  if (added) {
    return [
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
  }
  return [
    { term: 'Runs in', description: 'Its own worktree and branch' },
    // The cadence itself is unknown before the add, but the zone it will be read
    // in is not: the install resolves a catalogue schedule to this machine's zone
    // (`localiseCatalogueSchedule`, src/main/automations/definition-write.ts), so
    // an authored "nightly at 02:00" is 02:00 here. Said before Get, because
    // after Get the cadence row says the resolved time and this is the only
    // place the guarantee behind it can be read.
    { term: 'Starts', description: 'Enabled, on its own schedule in your timezone' },
    { term: 'Adds to', description: workspaceRoot ? projectName(workspaceRoot) : 'No project is open' },
    // Last, because it is the last thing read before Get: that this will run an
    // agent unattended with permissions bypassed is the most consequential fact
    // about adding one, and holding it back until after the add was backwards.
    // It is the app's own resolved default rather than a read of the entry —
    // the install pins no preset, so an added automation naming none renders the
    // same string off the same constant, and the two asides cannot disagree.
    // The permission is machine-wide, which is why the worktree row above is not
    // written as if it fenced the agent in: a worktree bounds what git sees,
    // never what the process can reach.
    { term: 'Permission', description: DEFAULT_PERMISSION_LABEL },
  ]
}

// The automation detail aside. Everything the row may not carry lives here: the
// description, what adding it will do, and — once it is added — the schedule and
// prompt the project actually holds. One primary, because an inspector aside is
// its own view.
//
// Nothing here is editable: this shelf configures nothing. The fact list is
// automationDetailFacts above; what may honestly be said before the add is
// settled there.
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
  const facts = automationDetailFacts(added, workspaceRoot)

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
              // design-tokens-allow: heading is a programmatic focus target only (tabIndex -1, moved to on selection) — it never receives keyboard focus
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

// The list's chrome row: the shared section heading on the left, the freshness
// of the registry read and the two list-wide controls on the right. One band
// rather than a toolbar stacked on a status line — the same shape
// Settings → Agent CLIs uses.
//
// This is in-content chrome inside a scrolling padded canvas, NOT a panel
// identity row: the Extensions door already names itself in the surface bar
// (`GlobalSurfaceShell`, 36px / `px-3` / `text-body font-semibold` — the same
// anatomy `ui/PanelHeader` draws), and the rail names the section. So the
// primitive this owes is `ConnectorSectionHeading`, the heading its own module
// and agent-CLI siblings render three lines further down. It used to hand-roll
// an `h3` at `text-title` instead, which is why the automation shelf's heading
// sat a type step above the other two kinds on the same component (2112).
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
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <ConnectorSectionHeading label="Automations" count={count} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
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

// ---------------------------------------------------------------------------
// The shelf itself: one hook the canvas calls, three pieces it renders
// ---------------------------------------------------------------------------

/** Everything the automation shelf's three pieces read. Held by the canvas so
 *  the band, the rows and the aside share one install and one project read —
 *  the same single owner they had when all of this lived in the canvas. */
export type AutomationShelfState = {
  registryUrl: string | null
  workspaceRoot: string | null
  install: ShelfInstallState
  folderPending: boolean
  checkedAt: number | null
  now: number
  projectError: string | null
  /** Added-or-not is only answerable once the project's store has been read. A
   *  loading or failed read is `false`, and the row says "Checking" rather than
   *  the definitive negative it would otherwise imply. */
  projectKnown: boolean
  addedFor: (entry: ConnectorEntry) => AutomationDefinition | null
  installingKey: string | null
  /** Any install is in flight — a Get, or a folder add. */
  busy: boolean
  get: (entry: ConnectorEntry) => void
  open: (definition: AutomationDefinition) => void
  addFromFolder: () => void
  refreshRegistry: () => void
}

export function useAutomationShelf({
  active,
  sources,
  workspaceRoot,
  automationDefaultCli,
  onOpenAutomation,
  onAutomationAdded,
}: {
  /** The canvas is on the automation kind. Called unconditionally either way, so
   *  the hook order never changes; inactive it neither reads the project's
   *  automations nor ticks the band's clock. */
  active: boolean
  sources: ConnectorSources
  workspaceRoot: string | null
  automationDefaultCli?: string | null
  onOpenAutomation?: (definition: AutomationDefinition) => void
  onAutomationAdded?: (automationId: string) => void
}): AutomationShelfState {
  const [install, setInstall] = useState<ShelfInstallState>({ status: 'idle' })
  const [folderPending, setFolderPending] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const project = useProjectAutomations(workspaceRoot, active)
  const projectReload = project.reload

  // The band's freshness has to age or it lies: "Checked just now" would stay on
  // screen an hour later.
  const registryStatus = sources.registryLoad.status
  useEffect(() => {
    if (!active) return
    if (registryStatus === 'ready') setCheckedAt(Date.now())
  }, [active, registryStatus, sources.registryLoad])
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [active])

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

  const projectState = project.state
  const addedFor = useCallback(
    (entry: ConnectorEntry): AutomationDefinition | null =>
      projectState.status === 'ready' ? (projectState.byCatalogueId.get(entry.id) ?? null) : null,
    [projectState],
  )

  const { loadRegistry } = sources
  return useMemo(
    () => ({
      registryUrl: sources.registryUrl,
      workspaceRoot,
      install,
      folderPending,
      checkedAt,
      now,
      projectError: projectState.status === 'error' ? projectState.message : null,
      projectKnown: projectState.status === 'ready',
      addedFor,
      installingKey: install.status === 'installing' ? install.key : null,
      busy: install.status === 'installing' || folderPending,
      get: (entry: ConnectorEntry) => {
        if (entry.plugin) void installAutomation(entry.plugin, entry.key)
      },
      open: (definition: AutomationDefinition) => onOpenAutomation?.(definition),
      addFromFolder: () => void addFromFolder(),
      refreshRegistry: () => void loadRegistry(true),
    }),
    [
      sources.registryUrl,
      workspaceRoot,
      install,
      folderPending,
      checkedAt,
      now,
      projectState,
      addedFor,
      installAutomation,
      addFromFolder,
      onOpenAutomation,
      loadRegistry,
    ],
  )
}

// The band and the list-wide facts above the rows: the freshness and controls,
// then anything the whole list must be told once rather than per row.
export function AutomationShelfBand({
  shelf,
  count,
}: {
  shelf: AutomationShelfState
  count: number
}): JSX.Element {
  return (
    <div className="mt-4 space-y-2">
      <AutomationsBand
        count={count}
        checkedAt={shelf.checkedAt}
        now={shelf.now}
        addPending={shelf.folderPending}
        onAdd={shelf.addFromFolder}
        onRefresh={shelf.refreshRegistry}
      />
      {/* This project's automations are what decides added-or-not. A store
          that cannot be read must say so: without it every row would read
          "Not added" and offer a Get that lands on one already there. */}
      {shelf.projectError ? (
        <InlineNotice tone="warn">
          {`This project’s automations could not be read, so no row can say whether it is already added: ${shelf.projectError}`}
        </InlineNotice>
      ) : null}
      {shelf.install.status === 'done' ? (
        <div className="text-meta text-[color:var(--text-muted)]" role="status">
          {shelf.install.message}
        </div>
      ) : null}
      {shelf.install.status === 'error' ? (
        <InlineNotice tone="error">
          <div>{shelf.install.message}</div>
          {shelf.install.issues?.length ? (
            <ul className="mt-1 list-disc pl-4">
              {shelf.install.issues.slice(0, 4).map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </InlineNotice>
      ) : null}
    </div>
  )
}

export function AutomationShelfRows({
  shelf,
  entries,
  selectedKey,
  onSelect,
}: {
  shelf: AutomationShelfState
  entries: ConnectorEntry[]
  selectedKey: string | null
  onSelect: (key: string) => void
}): JSX.Element {
  return (
    <div>
      {entries.map((entry) => (
        <AutomationRegistryRow
          key={entry.key}
          entry={entry}
          registryUrl={shelf.registryUrl}
          added={shelf.addedFor(entry)}
          projectKnown={shelf.projectKnown}
          selected={selectedKey === entry.key}
          installing={shelf.installingKey === entry.key}
          busy={shelf.busy}
          onSelect={() => onSelect(entry.key)}
          onGet={() => shelf.get(entry)}
          onOpen={() => {
            const definition = shelf.addedFor(entry)
            if (definition) shelf.open(definition)
          }}
        />
      ))}
    </div>
  )
}

export function AutomationShelfDetail({
  shelf,
  entry,
  plugin,
  onClose,
}: {
  shelf: AutomationShelfState
  entry: ConnectorEntry
  plugin: MarketplacePluginEntry
  onClose: () => void
}): JSX.Element {
  return (
    <AutomationDetailPanel
      plugin={plugin}
      registryUrl={shelf.registryUrl}
      added={shelf.addedFor(entry)}
      projectKnown={shelf.projectKnown}
      workspaceRoot={shelf.workspaceRoot}
      installing={shelf.installingKey === entry.key}
      onGet={() => shelf.get(entry)}
      onOpen={() => {
        const definition = shelf.addedFor(entry)
        if (definition) shelf.open(definition)
      }}
      onClose={onClose}
    />
  )
}
