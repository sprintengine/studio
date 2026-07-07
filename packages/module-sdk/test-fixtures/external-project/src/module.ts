// An external author's module, compiled against the packed SDK tarball only.
// Exercises the v1 surface: manifest shape, entry.main registration (IPC,
// service token, sidecar, notification), and entry.renderer registration
// (panel, workspace type, Backlog action, command, settings section).

import { createElement, useEffect, useState } from 'react'

import {
  createServiceToken,
  getAutomationsService,
  hasFileDropData,
  readFileDropPayload,
  registerAutomationAction,
  registerAutomationTrigger,
  type AutomationActionProvider,
  type AutomationTriggerProvider,
  type BacklogItemAction,
  type CapabilityManifest,
  type ModuleCommandDefinition,
  type RegisterMain,
  type RegisterRenderer,
  type WorkspaceLayoutTemplate,
  type WorkspacePanelComponent,
  type WorkspacePanelProps,
  type WorkspaceTypeDefinition,
} from '@multicode/module-sdk'

export const manifest: CapabilityManifest = {
  id: 'weather-deck',
  displayName: 'Weather Deck',
  version: 1,
  publisher: 'example-author',
  summary: 'Forecast panel and quick-check command.',
  defaultEnabled: true,
  source: 'third-party',
  permissions: ['network', 'ipc:workspace-read', 'ipc:invoke', 'automations.manage', 'backlog.read'],
  dependsOn: ['automations'],
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
        autonomyDefault: 'review_only',
      },
    })
    if (!created.ok) throw new Error(`${created.code}: ${created.message}`)
    return { created: true, automationId: created.automation.id }
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
    useEffect(() => {
      let disposed = false
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
          : `${backlogCount} backlog items`
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
