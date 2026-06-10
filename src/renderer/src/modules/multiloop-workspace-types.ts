import React from 'react'

import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot } from '../types/workspace'
import { MultiloopWorkspaceTypeIcon } from '../components/AppIcons'

const MultiloopAutoRunSupervisor = React.lazy(
  () => import('../components/workspace/MultiloopAutoRunSupervisor')
)

const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })

const multiloopBoardTab = () => ({
  type: 'tab',
  name: 'Multiloop',
  component: 'multiloop-board',
})

export function createMultiloopTemplate(): LayoutTemplate {
  return {
    id: 'multiloop-mode',
    name: 'Multiloop Mode',
    description: 'Milestone roadmap, active work, blockers, and evidence.',
    previewSlots: [
      editor('Goal', 4, 4, 292, 22),
      editor('Roadmap', 4, 30, 92, 76),
      editor('Active Milestone', 100, 30, 196, 76),
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
            children: [multiloopBoardTab()],
          },
        ],
      },
    },
  }
}

export function registerMultiloopWorkspaceTypes(host: RendererHost): void {
  host.registerWorkspaceType({
    id: 'multiloop',
    label: 'Multiloop',
    description: 'Roadmap, milestones, decisions, and evidence for long-running work.',
    icon: MultiloopWorkspaceTypeIcon,
    accentToken: '--text-muted',
    searchTerms: ['multiloop', 'roadmap', 'milestones', 'decisions', 'evidence'],
    createTemplate: createMultiloopTemplate,
    // The top-bar view switcher for Multiloop workspaces (was VIEWS_FOR_MODE in
    // WorkspaceTopBar). Sprint Engine and Switchboard intentionally contribute
    // none — they own their own in-panel sub-navs — so only Multiloop has views.
    topBarViews: {
      label: 'Multiloop',
      views: [{ component: 'multiloop-board', name: 'Multiloop' }],
    },
    supervisors: [
      { Component: MultiloopAutoRunSupervisor, scope: 'global' },
    ],
    creationStepsId: 'multiloop',
    pickerOrder: 30,
  })
}
