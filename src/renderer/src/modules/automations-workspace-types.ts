import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot } from '../types/workspace'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../types/workspace'
import { AutomationsWorkspaceTypeIcon } from '../components/AppIcons'

const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })

// The automations control center owns one non-closeable tab whose tabset hides
// the FlexLayout tab strip, so AutomationsPanel renders the only visible control
// chrome (mirrors the Switchboard single-surface pattern). Agent run terminals
// never stack into this tabset — `addAgentTabTiled` recognises the
// `automations-control-center` component and docks runs into a right-hand
// terminals tabset, so the control panel keeps its real estate and the live
// runs appear beside it.
const automationsControlCenterTab = () => ({
  type: 'tab',
  name: 'Automations',
  component: 'automations-control-center',
  enableClose: false,
})

export function createAutomationsTemplate(): LayoutTemplate {
  return {
    id: 'automations-mode',
    name: 'Automations Mode',
    description: 'Schedule agents on this project, watch run history, and manage triggers — with runs hosted as live terminals beside the control panel.',
    previewSlots: [
      editor('Automations', 4, 4, 292, 102),
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
            children: [automationsControlCenterTab()],
          },
        ],
      },
    },
  }
}

// The `automations-host` type stays REGISTERED but is hidden from the creation
// picker (global-surfaces epic 1704 / item 1707): automations are no longer
// user-created workspaces — the full-page Automations door owns "New automation"
// — but the executor still creates hidden host workspaces at runtime (through
// `createAutomationsTemplate`, imported directly) to host live run terminals, and
// existing hosts must still resolve their type to render. So, unlike the review
// and roadmap types (fully retired), this one is kept for the runtime container
// and only withheld from the picker via `hiddenFromPicker`.
export function registerAutomationsWorkspaceTypes(host: RendererHost): void {
  host.registerWorkspaceType({
    id: AUTOMATIONS_HOST_WORKSPACE_MODE,
    label: 'Automations',
    description: 'Schedule agents and tasks on this project, with run history and the live run terminals hosted in one place.',
    icon: AutomationsWorkspaceTypeIcon,
    accentToken: '--accent-primary',
    searchTerms: ['automations', 'schedule', 'cron', 'trigger', 'agent', 'recurring', 'runs'],
    createTemplate: createAutomationsTemplate,
    // Fixed single-surface layout, so the new-workspace wizard skips the
    // layout-picker step (same zero-config flow shape as Switchboard).
    creationStepsId: 'automations',
    // Not user-creatable: the door creates automations, not the workspace picker.
    // `hiddenFromPicker` withholds it from the creation picker; `pickerOrder`
    // stays only to keep its slot stable in the full `getWorkspaceTypes()` listing
    // (run-glyph/registry consumers), which the picker never reaches.
    hiddenFromPicker: true,
    pickerOrder: 35,
  })
}
