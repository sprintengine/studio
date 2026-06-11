// An external author's module, compiled against the packed SDK tarball only.
// Exercises the v1 surface: manifest shape, entry.main registration (IPC,
// service token, sidecar, notification), and entry.renderer registration
// (panel, workspace type, Backlog action, command, settings section).

import {
  createServiceToken,
  type BacklogItemAction,
  type CapabilityManifest,
  type ModuleCommandDefinition,
  type RegisterMain,
  type RegisterRenderer,
  type WorkspaceLayoutTemplate,
  type WorkspacePanelComponent,
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
  permissions: ['network', 'ipc:workspace-read'],
  entry: {
    main: 'dist/main.cjs',
    renderer: 'dist/renderer.mjs',
  },
}

const forecastService = createServiceToken<{ refresh(): Promise<void> }>('weather-deck.forecast')

export const registerMain: RegisterMain = (host) => {
  host.provideService(forecastService, () => ({
    refresh: async () => undefined,
  }))
  host.registerIpc('weather-deck:forecast', async (_event, city: unknown) => {
    if (typeof city !== 'string' || city.trim().length === 0) {
      throw new Error('weather-deck:forecast requires a city name.')
    }
    return { city, summary: 'clear' }
  })
  host.registerSidecar({ id: 'weather-deck-poller', kind: 'process', description: 'Background forecast poller.' })
  host.onStartup(() => {
    host.notify({ severity: 'info', title: 'Weather Deck ready' })
  })
}

const ForecastPanel: WorkspacePanelComponent = () => null

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

const quickCheck: ModuleCommandDefinition = {
  id: 'quick-check',
  title: 'Weather: Quick Check',
  category: 'Weather Deck',
  scopes: ['global'],
  run: () => undefined,
}

export const registerRenderer: RegisterRenderer = (host) => {
  host.registerPanel('weather-deck.forecast', ForecastPanel)
  host.registerWorkspaceType(forecastWorkspaceType)
  host.registerBacklogItemAction(markChecked)
  host.registerCommand(quickCheck)
  host.registerSettingsSection({
    id: 'weather-deck',
    label: 'Weather Deck',
    icon: () => null,
    Component: () => null,
  })
}
