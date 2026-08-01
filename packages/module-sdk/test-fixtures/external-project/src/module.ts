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
  type ModuleCommandDefinition,
  type ModuleWorkspaceView,
  type RegisterMain,
  type RegisterRenderer,
  type WorkspaceLayoutTemplate,
  type WorkspacePanelComponent,
  type WorkspacePanelProps,
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
  permissions: ['network', 'ipc:workspace-read', 'ipc:invoke', 'automations.manage', 'backlog.read', 'agents:companion', 'storage'],
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
    useEffect(() => {
      let disposed = false
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
          : `${backlogCount} backlog items${workspace?.folderPath ? ` in ${workspace.folderPath}` : ''}`
    )
  }
}

function createForecastTemplate(): WorkspaceLayoutTemplate {
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
          { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Forecast', component: 'weather-deck.forecast' }] },
          { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'agent-1' } }] },
        ],
      },
    },
  }
}

const forecastWorkspaceType: WorkspaceTypeDefinition = {
  id: 'weather-deck',
  label: 'Weather Deck',
  description: 'Plan work around the forecast.',
  icon: () => null,
  createTemplate: createForecastTemplate,
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
  host.registerSettingsSection({
    id: 'weather-deck',
    label: 'Weather Deck',
    icon: () => null,
    Component: () => null,
  })
}
