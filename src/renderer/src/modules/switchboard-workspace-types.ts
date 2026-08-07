import type { RendererHost } from './renderer-host'
import type { LayoutTemplate } from '../types/workspace'
import { SWITCHBOARD_TEMPLATE } from '../../../shared/layouts/templates'
import { SwitchboardWorkspaceTypeIcon } from '../components/AppIcons'

// Watchtower + Switchboard share one workspace surface whose internal icon
// sub-nav switches between them. The wrapper tab is non-closeable and its
// tabset hides the FlexLayout tab strip so the SwitchboardWorkspacePanel owns
// the visible chrome. The layout itself lives in `shared` (MC-2158) so a
// switchboard main mints headlessly is the same workspace a window mints.
export function createSwitchboardTemplate(): LayoutTemplate {
  return SWITCHBOARD_TEMPLATE
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
