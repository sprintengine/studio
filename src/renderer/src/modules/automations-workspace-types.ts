import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot } from '../types/workspace'
import { AutomationsWorkspaceTypeIcon } from '../components/AppIcons'
// Eager (not React.lazy): the always-mounted background-run observer must
// subscribe with no chunk-load gap that could drop an early run-event. Its
// module is intentionally store-free (resolves folders on demand), so this
// eager import keeps the registry graph / bundled-ids free of the workspace
// store + FlexLayout.
import AutomationsRunSupervisor from '../components/automations/AutomationsRunSupervisor'

const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })

// The automations control center owns one non-closeable tab whose tabset hides
// the FlexLayout tab strip, so AutomationsPanel renders the only visible chrome
// (mirrors the Switchboard single-surface pattern).
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
    description: 'Schedule agents on this project, watch run history, and manage triggers.',
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

export function registerAutomationsWorkspaceTypes(host: RendererHost): void {
  host.registerWorkspaceType({
    id: 'automations',
    label: 'Automations',
    description: 'Schedule agents and tasks on this project, with run history and per-project control.',
    icon: AutomationsWorkspaceTypeIcon,
    accentToken: '--accent-primary',
    searchTerms: ['automations', 'schedule', 'cron', 'trigger', 'agent', 'recurring'],
    createTemplate: createAutomationsTemplate,
    // Always-mounted (primary-window) observer for background scheduled-run
    // notifications; mounts on module-enablement even when no automations
    // workspace is open (Sprint Engine / Multiloop precedent).
    supervisors: [
      { Component: AutomationsRunSupervisor, scope: 'global' },
    ],
    // Fixed single-surface layout, so the new-workspace wizard skips the
    // layout-picker step (same flow shape as Switchboard).
    creationStepsId: 'automations',
    pickerOrder: 35,
  })
}
