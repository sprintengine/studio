import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot } from '../types/workspace'
import { GuidedBriefWorkspaceTypeIcon } from '../components/AppIcons'

const agent = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'agent', label })
const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })

const guidedBriefTab = () => ({
  type: 'tab',
  name: 'Design Wizard',
  component: 'guided-brief',
  enableClose: false,
})

export function createGuidedBriefTemplate(): LayoutTemplate {
  return {
    id: 'guided-brief-mode',
    name: 'Design Wizard',
    description: 'Plan, mockups, and build handoff before implementation.',
    previewSlots: [
      editor('Brief', 4, 4, 140, 102),
      agent('Strategist', 148, 4, 148, 48),
      editor('Mockup', 148, 58, 148, 48),
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
            children: [guidedBriefTab()],
          },
        ],
      },
    },
  }
}

export function registerDesignWizardWorkspaceTypes(host: RendererHost): void {
  // The Design Wizard's workspace type moved off the Sprint Engine module onto
  // its own `design-wizard` module (MC-1860). The 'guided-brief' id stays frozen
  // as a compatibility identifier so persisted workspaces keep opening.
  host.registerWorkspaceType({
    id: 'guided-brief',
    label: 'Design Wizard',
    description: 'Describe your idea in plain words. We turn it into a plan, screens, and a build — no setup needed.',
    icon: GuidedBriefWorkspaceTypeIcon,
    accentToken: '--accent-primary',
    searchTerms: ['design wizard', 'guided brief', 'brief', 'mockups', 'build handoff', 'idea'],
    createTemplate: createGuidedBriefTemplate,
    creationStepsId: 'guided-brief',
    pickerOrder: 40,
  })
}
