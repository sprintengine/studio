import type { RendererHost } from './renderer-host'
import type { LayoutTemplate } from '../types/workspace'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../types/workspace'
import { AUTOMATIONS_HOST_TEMPLATE } from '../../../shared/layouts/templates'
import { AutomationsWorkspaceTypeIcon } from '../components/AppIcons'

// The automations control center owns one non-closeable tab whose tabset hides
// the FlexLayout tab strip, so AutomationsPanel renders the only visible control
// chrome (the single-surface host pattern). Agent run terminals
// never stack into this tabset — `addAgentTabTiled` recognises the
// `automations-control-center` component and docks runs into a right-hand
// terminals tabset, so the control panel keeps its real estate and the live
// runs appear beside it. The layout lives in `shared` so a host the
// automation executor mints headlessly carries the same control centre.
function createAutomationsTemplate(): LayoutTemplate {
  return AUTOMATIONS_HOST_TEMPLATE
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
    description:
      'Schedule agents and tasks on this project, with run history and the live run terminals hosted in one place.',
    icon: AutomationsWorkspaceTypeIcon,
    accentToken: '--accent-primary',
    searchTerms: ['automations', 'schedule', 'cron', 'trigger', 'agent', 'recurring', 'runs'],
    createTemplate: createAutomationsTemplate,
    // Fixed single-surface layout, so the new-workspace wizard skips the
    // layout-picker step (a zero-config creation flow).
    creationStepsId: 'automations',
    // Not user-creatable: the door creates automations, not the workspace picker.
    // `hiddenFromPicker` withholds it from the creation picker; `pickerOrder`
    // stays only to keep its slot stable in the full `getWorkspaceTypes()` listing
    // (run-glyph/registry consumers), which the picker never reaches.
    hiddenFromPicker: true,
    pickerOrder: 35,
  })
}
