// An external author's module, compiled against the packed SDK tarball only.
// Exercises the v1 surface: manifest shape, entry.main registration (IPC,
// service token, sidecar, notification), and entry.renderer registration
// (panel, workspace type, Backlog action, command, settings section).

import { createElement, useEffect, useState } from 'react'

import {
  createServiceToken,
  getAutomationsService,
  getCompanionAgentsService,
  getModuleStorage,
  hasFileDropData,
  readFileDropPayload,
  registerAutomationAction,
  registerAutomationTrigger,
  type AutomationActionProvider,
  type AutomationTriggerProvider,
  type BacklogItemAction,
  type CapabilityManifest,
  type McpToolRegistration,
  type ModuleCommandDefinition,
  type ModuleWorkspaceView,
  type RegisterMain,
  type RegisterRenderer,
  type WorkspaceCreationStepProps,
  type WorkspaceLayoutTemplate,
  type WorkspacePanelComponent,
  type WorkspacePanelProps,
  type WorkspaceTypeCreateContext,
  type WorkspaceTypeDefinition,
  WorkspaceContextToken,
} from '@multicode/module-sdk'

export const manifest: CapabilityManifest = {
  id: 'weather-deck',
  displayName: 'Weather Deck',
  version: 1,
  publisher: 'example-author',
  summary: 'Forecast panel and quick-check command.',
  defaultEnabled: true,
  source: 'third-party',
  permissions: ['network', 'ipc:workspace-read', 'ipc:invoke', 'ipc:agents', 'automations.manage', 'backlog.read', 'agents:companion', 'storage'],
  dependsOn: ['automations', 'agent-runtime'],
  entry: {
    main: 'dist/main.cjs',
    renderer: 'dist/renderer.mjs',
  },
}

const forecastService = createServiceToken<{ refresh(): Promise<void> }>('weather-deck.forecast')

const forecastTrigger: AutomationTriggerProvider = {
  kind: 'weather-deck.forecast-ready',
  configSchema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
    },
  },
  subscribe: () => () => undefined,
  poll: async () => ({
    ok: true,
    events: [],
  }),
}

// An agent-reachable MCP tool on the Studio gateway (declares `ipc:agents`).
// Availability follows the module's enablement live: while Weather Deck is
// disabled the tool stays listed and answers an actionable enable error.
const forecastTool: McpToolRegistration = {
  name: 'weather_deck_forecast',
  description: 'Read the current forecast for a city.',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City to forecast.' },
    },
    required: ['city'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const city = typeof args.city === 'string' ? args.city.trim() : ''
    if (!city) {
      return {
        content: [{ type: 'text', text: 'invalid_arguments: "city" must be a city name.' }],
        structuredContent: { ok: false, error: { code: 'invalid_arguments', message: '"city" must be a city name.' } },
        isError: true,
      }
    }
    const structured = { city, summary: 'clear' }
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    }
  },
}

const forecastAction: AutomationActionProvider = {
  kind: 'weather-deck.refresh-forecast',
  configSchema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
    },
  },
  run: async (_config, context) => {
    context.reportProgress({ summary: 'Forecast refresh started.' })
    return { status: 'completed', summary: 'Forecast refreshed.' }
  },
}

export const registerMain: RegisterMain = (host) => {
  host.provideService(forecastService, () => ({
    refresh: async () => undefined,
  }))
  registerAutomationTrigger(host, forecastTrigger)
  registerAutomationAction(host, forecastAction)
  host.registerMcpTools([forecastTool])
  host.registerIpc('weather-deck:forecast', async (_event, city: unknown) => {
    if (typeof city !== 'string' || city.trim().length === 0) {
      throw new Error('weather-deck:forecast requires a city name.')
    }
    return { city, summary: 'clear' }
  })
  // Workspace context from entry.main: id → root/name/mode for per-workspace
  // persistence paths. Unknown ids resolve to null, never a throw.
  host.registerIpc('weather-deck:workspace-root', async (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      throw new Error('weather-deck:workspace-root requires a workspace id.')
    }
    const workspaces = host.requireService(WorkspaceContextToken)
    const view = await workspaces.get(workspaceId)
    return { folderPath: view?.folderPath ?? null }
  })
  // Scoped module storage composed with the workspace context: resolve the
  // root, persist under it (host-placed), read back. Declare `storage`.
  host.registerIpc('weather-deck:save-preferences', async (_event, input: unknown) => {
    const { workspaceId, preferences } = (input ?? {}) as { workspaceId?: unknown; preferences?: unknown }
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      throw new Error('weather-deck:save-preferences requires a workspace id.')
    }
    const view = await host.requireService(WorkspaceContextToken).get(workspaceId)
    // Not-yet-resolvable (null view) is a transient state — fail the save so
    // the caller retries, rather than silently writing to a scope the data
    // would later appear "lost" from. A RESOLVED workspace without a folder
    // is genuinely folderless: its data lives in the global per-user store.
    if (!view) throw new Error(`Workspace "${workspaceId}" is not resolvable yet — retry the save.`)
    const storage = getModuleStorage(host)
    const scope = view.folderPath ? { workspaceRoot: view.folderPath } : {}
    const saved = await storage.set({ ...scope, key: 'preferences', value: preferences ?? {} })
    if (!saved.ok) throw new Error(`${saved.code}: ${saved.message}`)
    const roundTrip = await storage.get({ ...scope, key: 'preferences' })
    if (!roundTrip.ok) throw new Error(`${roundTrip.code}: ${roundTrip.message}`)
    return { found: roundTrip.found, value: roundTrip.value }
  })
  // Owned-automation CRUD through the scoped service. Idempotent via the fixed
  // id: a second call finds the existing record in list() and skips creation.
  host.registerIpc('weather-deck:setup-refresh-automation', async (_event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
      throw new Error('weather-deck:setup-refresh-automation requires a workspace root.')
    }
    const automations = getAutomationsService(host)
    const existing = await automations.list({ workspaceRoot })
    if (!existing.ok) throw new Error(`${existing.code}: ${existing.message}`)
    if (existing.automations.some((definition) => definition.id === 'weather-deck-refresh')) {
      return { created: false }
    }
    const created = await automations.create({
      workspaceRoot,
      draft: {
        id: 'weather-deck-refresh',
        name: 'Weather Deck: refresh forecast',
        status: 'paused',
        trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '09:00' }, timezone: 'UTC' } },
        action: { kind: 'weather-deck.refresh-forecast', config: { city: 'Dublin' } },
      },
    })
    if (!created.ok) throw new Error(`${created.code}: ${created.message}`)
    return { created: true, automationId: created.automation.id }
  })
  // Cross-surface briefing (seam proof): ONE channel that composes workspace
  // context resolution with a scoped storage round-trip — the resolved view's
  // folderPath picks the storage scope, and the stored counter survives the
  // get→set→return chain. The renderer half (below) feeds the result into
  // per-module workspace state, so the value crosses three published
  // surfaces end to end instead of each being exercised in isolation.
  host.registerIpc('weather-deck:workspace-briefing', async (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      throw new Error('weather-deck:workspace-briefing requires a workspace id.')
    }
    const view = await host.requireService(WorkspaceContextToken).get(workspaceId)
    if (!view) throw new Error(`Workspace "${workspaceId}" is not resolvable yet — retry the briefing.`)
    const storage = getModuleStorage(host)
    const scope = view.folderPath ? { workspaceRoot: view.folderPath } : {}
    const read = await storage.get({ ...scope, key: 'briefing-count' })
    if (!read.ok) throw new Error(`${read.code}: ${read.message}`)
    const briefingCount = (read.found && typeof read.value === 'number' ? read.value : 0) + 1
    const wrote = await storage.set({ ...scope, key: 'briefing-count', value: briefingCount })
    if (!wrote.ok) throw new Error(`${wrote.code}: ${wrote.message}`)
    return { workspaceName: view.name, mode: view.mode, briefingCount }
  })
  // Companion agent: a workspace-bound background helper that answers a
  // structured question. Exercises the SDK's CompanionAgentsService surface.
  host.registerIpc('weather-deck:ask-guide', async (_event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
      throw new Error('weather-deck:ask-guide requires a workspace root.')
    }
    const companions = getCompanionAgentsService(host)
    const guide = companions.attach({
      workspaceId: 'weather-deck',
      agentId: 'forecast-guide',
      name: 'Forecast Guide',
      workspaceRoot,
      systemPrompt: 'You summarize the forecast as strict JSON.',
    })
    guide.onStatus((status) => void status)
    const summary = await guide.runStructured<{ outlook: string }>({
      prompt: 'Summarize today as {"outlook": string}.',
      retries: 1,
      validate: (raw) => {
        const record = raw as { outlook?: unknown }
        return typeof record.outlook === 'string'
          ? { ok: true, value: { outlook: record.outlook } }
          : { ok: false, errors: ['outlook must be a string'] }
      },
    })
    guide.dispose()
    return summary
  })
  host.registerSidecar({ id: 'weather-deck-poller', kind: 'process', description: 'Background forecast poller.' })
  host.onStartup(() => {
    host.notify({ severity: 'info', title: 'Weather Deck ready' })
  })
}

// The panel exercises the Backlog read API: list seeds the count on mount,
// watch keeps it live, and the watch is unsubscribed on unmount. Both calls
// throw/reject when the backlog module is disabled, so a well-behaved panel
// guards them and degrades instead of crashing its subtree. No JSX — the
// fixture compiles as plain TS.
function createForecastPanel(host: Parameters<RegisterRenderer>[0]): WorkspacePanelComponent {
  return function ForecastPanel({ workspaceId }: WorkspacePanelProps) {
    const [backlogCount, setBacklogCount] = useState<number | null>(null)
    const [backlogUnavailable, setBacklogUnavailable] = useState(false)
    const [workspace, setWorkspace] = useState<ModuleWorkspaceView | null>(null)
    const [liveAgents, setLiveAgents] = useState(0)
    const [briefingCount, setBriefingCount] = useState(0)
    useEffect(() => {
      // Renderer half of the cross-surface briefing: bridge → main channel
      // (workspace context + storage round-trip) → per-module workspace
      // state write-back. The stored entry is read first so the briefing
      // composes with — never clobbers — whatever else the module keeps on
      // this workspace (the lastCity entry the other effect maintains).
      let disposed = false
      const brief = () => {
        void host.invoke('weather-deck:workspace-briefing', workspaceId)
          .then((briefing) => {
            if (disposed) return
            const record = briefing as { briefingCount?: unknown }
            const count = typeof record.briefingCount === 'number' ? record.briefingCount : 0
            const prior = host.getWorkspaceModuleState<{ lastCity?: string; briefingCount?: number }>(workspaceId)
            // A false write-back (unknown workspace, early boot) means "not
            // stored" — nothing to branch on here, because the next briefing
            // rewrites the entry anyway; just never treat the in-memory
            // count as durably persisted.
            host.setWorkspaceModuleState(workspaceId, { ...(prior ?? {}), briefingCount: count })
            setBriefingCount(count)
          })
          // A refused bridge invoke or a not-yet-resolvable workspace keeps
          // the last rendered count; the palette command retries on demand.
          .catch(() => undefined)
      }
      brief()
      const onPanelCommand = (event: Event) => {
        if ((event as CustomEvent<{ id?: string }>).detail?.id === 'weather-deck.refresh.briefing') brief()
      }
      window.addEventListener('multicode:panel-command', onPanelCommand)
      return () => {
        disposed = true
        window.removeEventListener('multicode:panel-command', onPanelCommand)
      }
    }, [workspaceId])
    useEffect(() => {
      // Live runtime surfaces: session observation (snapshot + change) and a
      // workspace-relative file watch — resolved against the effective
      // working root (getWorkingRoot), so a worktree-backed workspace
      // watches the worktree — both torn down on unmount.
      let offSessions: (() => void) | undefined
      try {
        offSessions = host.watchAgentSessions(workspaceId, (sessions) => {
          setLiveAgents(sessions.filter((session) => session.isLive).length)
        })
      } catch {
        // Session source unavailable (early boot, module disabled) — stay 0.
      }
      void host.getWorkingRoot(workspaceId).catch(() => null)
      let offFile: (() => void) | undefined
      void host.watchWorkspaceFile(workspaceId, 'forecast/config.json', () => undefined)
        .then((off) => { offFile = off })
        .catch(() => undefined)
      return () => {
        offSessions?.()
        offFile?.()
      }
    }, [workspaceId])
    useEffect(() => {
      let disposed = false
      // Per-module workspace state (MC-1573): the module's own durable entry
      // on this workspace — typed read, write-back with the reported result
      // honored (false = not stored: unknown workspace or early boot; retry
      // later, never assume success). Scoped to this module by the host.
      const deckState = host.getWorkspaceModuleState<{ lastCity?: string }>(workspaceId)
      const stored = host.setWorkspaceModuleState(workspaceId, {
        lastCity: deckState?.lastCity ?? 'Dublin',
      })
      if (!stored) {
        // Not stored — keep rendering from the in-memory value; the next
        // visit retries once the shell has wired workspace state.
      }
      // Workspace context resolution: the supported id → root/name/mode read
      // (replaces deriving the root from drop payloads or backlog paths).
      // Reset per workspace so a switch never renders the previous
      // workspace's folder against the new one's data; null means "not
      // currently resolvable", so the panel just omits the folder.
      setWorkspace(null)
      host.getWorkspace(workspaceId)
        .then((view) => {
          if (!disposed) setWorkspace(view)
        })
        .catch(() => {
          if (!disposed) setWorkspace(null)
        })
      // Reset per workspace: one workspace's failure must not latch the
      // unavailable state after switching to a workspace that reads fine.
      setBacklogUnavailable(false)
      setBacklogCount(null)
      host.listBacklogItems(workspaceId)
        .then((items) => {
          if (!disposed) setBacklogCount(items.length)
        })
        .catch(() => {
          if (!disposed) setBacklogUnavailable(true)
        })
      let off: (() => void) | undefined
      try {
        off = host.watchBacklogItems(workspaceId, (items) => setBacklogCount(items.length))
      } catch {
        setBacklogUnavailable(true)
      }
      return () => {
        disposed = true
        off?.()
      }
    }, [workspaceId])
    return createElement(
      'div',
      {
        // Theme tokens re-skin the panel with the active app theme; only the
        // variable NAMES are contract, never resolved values or hex literals.
        style: { background: 'var(--bg-surface)', color: 'var(--text-muted)' },
        // getData is blanked during dragover (DnD protected mode), so gating
        // uses the types-based check; only Multicode/file drags are accepted.
        onDragOver: (event: { preventDefault(): void; dataTransfer: DataTransfer }) => {
          if (hasFileDropData(event.dataTransfer)) event.preventDefault()
        },
        // Accepts drags from the Backlog panel / Files tree via the published
        // file-drop contract; unknown or malformed payloads parse to null.
        onDrop: (event: { preventDefault(): void; dataTransfer: DataTransfer }) => {
          event.preventDefault()
          const payload = readFileDropPayload(event.dataTransfer)
          if (payload) console.log('[weather-deck] dropped', payload.files[0]?.path)
        },
      },
      backlogUnavailable
        ? 'Backlog unavailable'
        : backlogCount === null
          ? 'Loading backlog…'
          : `${backlogCount} backlog items${workspace?.folderPath ? ` in ${workspace.folderPath}` : ''} · ${liveAgents} live agents · briefing #${briefingCount}`
    )
  }
}

function createForecastTemplate(context?: WorkspaceTypeCreateContext): WorkspaceLayoutTemplate {
  // The creation step's collected value arrives here; a broken/skipped step
  // hands undefined, so the template must always work without it.
  const city =
    typeof context?.stepValue === 'string' && context.stepValue.trim() ? context.stepValue.trim() : null
  return {
    id: 'weather-deck-board',
    name: 'Weather board',
    description: 'Forecast panel beside one agent terminal.',
    previewSlots: [
      { x: 4, y: 4, w: 144, h: 102, type: 'editor', label: 'Forecast' },
      { x: 152, y: 4, w: 144, h: 102, type: 'agent', label: 'Agent' },
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', weight: 50, children: [{ type: 'tab', name: city ? `Forecast: ${city}` : 'Forecast', component: 'weather-deck.forecast' }] },
          { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'agent-1' } }] },
        ],
      },
    },
  }
}

// Render-nothing background component: the shell mounts it globally while the
// module is enabled — the home for pollers/sync loops (composed with the
// published live-runtime surfaces).
function ForecastSupervisor(): null {
  useEffect(() => {
    const timer = setInterval(() => undefined, 60_000)
    return () => clearInterval(timer)
  }, [])
  return null
}

// Module-owned config step in the creation hub: the collected value reaches
// createTemplate(context) on create; isReady gates the Create button.
function ForecastCityStep({ value, setValue }: WorkspaceCreationStepProps) {
  return createElement('input', {
    value: typeof value === 'string' ? value : '',
    placeholder: 'City to forecast',
    onChange: (event: { target: { value: string } }) => setValue(event.target.value),
  })
}

const forecastWorkspaceType: WorkspaceTypeDefinition = {
  id: 'weather-deck',
  label: 'Weather Deck',
  description: 'Plan work around the forecast.',
  icon: () => null,
  creationStep: {
    id: 'forecast-city',
    heading: 'Which city?',
    description: 'The forecast panel opens on this city.',
    Component: ForecastCityStep,
    isReady: (value) => typeof value === 'string' && value.trim().length > 0,
    blockedHint: 'Name a city to forecast.',
  },
  createTemplate: createForecastTemplate,
  supervisors: [{ Component: ForecastSupervisor, scope: 'global' }],
  // Sidebar status from module-owned state (sync — a supervisor-maintained
  // cache in real modules). Only called for this type's own workspaces, so no
  // mode check; null would mean "no run signal".
  deriveRunGlyph: () => ({ state: 'in_progress', live: false, label: '2 scheduled today' }),
}

const markChecked: BacklogItemAction = {
  id: 'weather-deck.mark-checked',
  label: 'Mark weather-checked',
  category: 'organize',
  isVisible: (context) => context.item.status !== 'archived',
  run: async (context) => {
    await context.updateModuleMetadata('weather-deck', { checkedAt: Date.now() })
  },
}

// The command round-trips to entry.main through the bridge: registerIpc set
// the channel up, host.invoke calls it from renderer code. The palette fires
// command run() without awaiting it, so a refusal (channel never registered,
// permission missing) must be handled here — an unhandled rejection surfaces
// nowhere the user can see.
function quickCheck(host: Parameters<RegisterRenderer>[0]): ModuleCommandDefinition {
  return {
    id: 'quick-check',
    title: 'Weather: Quick Check',
    category: 'Weather Deck',
    scopes: ['global'],
    run: async () => {
      try {
        await host.invoke('weather-deck:forecast', 'Dublin')
      } catch (error) {
        console.error('[weather-deck] forecast check failed:', error)
      }
    },
  }
}

export const registerRenderer: RegisterRenderer = (host) => {
  host.registerPanel('weather-deck.forecast', createForecastPanel(host))
  host.registerWorkspaceType(forecastWorkspaceType)
  host.registerBacklogItemAction(markChecked)
  host.registerCommand(quickCheck(host))
  // Agent spawn through the app's SHARED session runtime; structured result,
  // runtime picked from the published availability-filtered catalog.
  host.registerCommand({
    id: 'spawn.forecaster',
    title: 'Weather: Spawn forecaster agent',
    category: 'Weather Deck',
    scopes: ['panel:weather-deck'],
    run: async () => {
      const runtimes = host.listAgentRuntimes()
      const result = await host.spawnAgent({
        workspaceId: 'active',
        name: 'Forecaster',
        cli: runtimes[0]?.id,
        prompt: 'Summarize today\'s forecast for the workspace city.',
      })
      if (!result.ok) console.error('[weather-deck] spawn failed:', result.code, result.message)
    },
  })
  // Workspace-gated command: `panel:weather-deck` is derived by the shell
  // from the workspace-type registry (active while a weather-deck-mode
  // workspace is active), and the availability predicate narrows further
  // against the published context view — no shell enum entry involved.
  host.registerCommand({
    id: 'refresh.forecast',
    title: 'Weather: Refresh forecast',
    category: 'Weather Deck',
    scopes: ['panel:weather-deck'],
    availability: (context) => context.activeWorkspaceMode === 'weather-deck',
    run: () => {
      window.dispatchEvent(new CustomEvent('multicode:panel-command', { detail: { id: 'weather-deck.refresh.forecast' } }))
    },
  })
  // Predicate-gated entry point for the cross-surface briefing: the shell
  // derives the `panel:weather-deck` scope, the availability predicate
  // narrows against the published context view, and run() dispatches the
  // documented panel-command event the ForecastPanel briefing effect handles.
  host.registerCommand({
    id: 'refresh.briefing',
    title: 'Weather: Refresh workspace briefing',
    category: 'Weather Deck',
    scopes: ['panel:weather-deck'],
    availability: (context) => context.activeWorkspaceMode === 'weather-deck',
    run: () => {
      window.dispatchEvent(new CustomEvent('multicode:panel-command', { detail: { id: 'weather-deck.refresh.briefing' } }))
    },
  })
  host.registerSettingsSection({
    id: 'weather-deck',
    label: 'Weather Deck',
    icon: () => null,
    Component: () => null,
  })
}
