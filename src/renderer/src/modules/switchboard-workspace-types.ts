import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot } from '../types/workspace'
import { SwitchboardWorkspaceTypeIcon } from '../components/AppIcons'

const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })

// Watchtower + Switchboard share one workspace surface whose internal icon
// sub-nav switches between them. The wrapper tab is non-closeable and its
// tabset hides the FlexLayout tab strip so the SwitchboardWorkspacePanel owns
// the visible chrome.
const switchboardWorkspaceTab = () => ({
  type: 'tab',
  name: 'Switchboard',
  component: 'switchboard-workspace',
  enableClose: false,
})

export function createSwitchboardTemplate(): LayoutTemplate {
  return {
    id: 'switchboard-mode',
    name: 'Switchboard Mode',
    description: 'Watchtower triage inbox and the durable Switchboard task board.',
    previewSlots: [
      editor('Switchboard', 4, 4, 292, 102),
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            enableTabStrip: false,
            children: [switchboardWorkspaceTab()],
          },
        ],
      },
    },
  }
}

export function registerSwitchboardWorkspaceTypes(host: RendererHost): void {
  host.registerWorkspaceType({
    id: 'switchboard',
    label: 'Switchboard',
    description: 'Triage board and Watchtower review, fed by agent-created inbox tasks.',
    icon: SwitchboardWorkspaceTypeIcon,
    accentToken: '--tool-switchboard',
    searchTerms: ['switchboard', 'watchtower', 'triage', 'review', 'inbox'],
    createTemplate: createSwitchboardTemplate,
    creationStepsId: 'switchboard',
    pickerOrder: 10,
  })
}
