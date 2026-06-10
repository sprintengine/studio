import React from 'react'

import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot, SprintEngineMockConfig, SprintEngineTask } from '../types/workspace'
import { GuidedBriefWorkspaceTypeIcon, SprintEngineWorkspaceTypeIcon } from '../components/AppIcons'
import { deriveSprintEngineRunGlyph } from '../utils/sprintengine'
import type { WorkspaceActivityKind, WorkspaceRunGlyphProviderInput } from '../utils/workspaceRunGlyph'

const SprintEngineAutoRunSupervisor = React.lazy(
  () => import('../components/workspace/SprintEngineAutoRunSupervisor')
)

const agent = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'agent', label })
const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })

const sprintEngineBoardTab = () => ({
  type: 'tab',
  name: 'Sprint Engine',
  component: 'sprintengine',
  enableClose: false,
})

const guidedBriefTab = () => ({
  type: 'tab',
  name: 'Guided Brief',
  component: 'guided-brief',
  enableClose: false,
})

export const defaultSprintEngineTemplateConfig: SprintEngineMockConfig = {
  name: 'Sprint Engine',
  goal: '',
  roleCounts: {} as SprintEngineMockConfig['roleCounts'],
}

export function createGuidedBriefTemplate(): LayoutTemplate {
  return {
    id: 'guided-brief-mode',
    name: 'Guided Brief',
    description: 'Product brief, mockups, and build handoff before implementation.',
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

export function createSprintEngineTemplate(_config: SprintEngineMockConfig): LayoutTemplate {
  return {
    id: 'sprintengine-mode',
    name: 'SprintEngine Mode',
    description: 'Inbox, Roster, and Tasks together in one stable board.',
    previewSlots: [
      editor('Sprint Engine', 4, 4, 292, 102),
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
            children: [sprintEngineBoardTab()],
          },
        ],
      },
    },
  }
}

function isSprintEngineRunGlyphWorkspace(workspace: WorkspaceRunGlyphProviderInput): boolean {
  return workspace.mode === 'sprintengine' || Boolean(workspace.sprintEngineContext)
}

function latestTaskCompletionAt(tasks: SprintEngineTask[]): number | null {
  let latest: number | null = null
  for (const task of tasks) {
    if (!task.completedAt) continue
    const at = Date.parse(task.completedAt)
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at
  }
  return latest
}

// AutoRun never reaches `complete` on a manual run, so a run whose tasks all
// finished by hand still reads as done.
function manualRunCompletedAt(workspace: WorkspaceRunGlyphProviderInput): number | null {
  const tasks = workspace.sprintEngineState?.tasks ?? []
  if (tasks.length === 0 || !tasks.every((task) => task.status === 'done')) return null
  return latestTaskCompletionAt(tasks) ?? 0
}

// Completion is news once: the done glyph shows only until the user next has
// the workspace active while the run is complete (markSprintEngineRunCompletionSeen),
// then the row reverts to recency text. An undatable completion counts as
// unseen until any seen mark exists.
function completionSeen(workspace: WorkspaceRunGlyphProviderInput, completedAt: number | null): boolean {
  const seenAt = workspace.sprintEngineAutoState?.completionSeenAt
  if (typeof seenAt !== 'number') return false
  return completedAt === null || seenAt >= completedAt
}

export function isSprintEngineRunCompletionUnseen(workspace: WorkspaceRunGlyphProviderInput): boolean {
  if (!isSprintEngineRunGlyphWorkspace(workspace)) return false
  const rollup = deriveSprintEngineRunGlyph({
    sprintEngineState: workspace.sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
  })
  if (rollup && rollup.state !== 'done') return false
  const completedAt = rollup?.state === 'done'
    ? workspace.sprintEngineAutoState?.changedAt ?? manualRunCompletedAt(workspace)
    : manualRunCompletedAt(workspace)
  if (rollup?.state !== 'done' && completedAt === null) return false
  return !completionSeen(workspace, completedAt)
}

export function deriveSprintEngineWorkspaceRunGlyph(
  workspace: WorkspaceRunGlyphProviderInput,
  _activity: WorkspaceActivityKind,
) {
  const rollup = deriveSprintEngineRunGlyph({
    sprintEngineState: workspace.sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
  })
  if (rollup && rollup.state !== 'done') return rollup
  if (
    (rollup?.state === 'done' || manualRunCompletedAt(workspace) !== null)
    && isSprintEngineRunCompletionUnseen(workspace)
  ) {
    return { state: 'done', live: false, label: 'Run completed' } as const
  }
  return null
}

export function registerSprintEngineWorkspaceTypes(host: RendererHost): void {
  host.registerWorkspaceType({
    id: 'sprintengine',
    label: 'Sprint Engine',
    description: 'Specialist roster, architect plan, kanban, and evidence trail.',
    icon: SprintEngineWorkspaceTypeIcon,
    accentToken: '--tool-sprintengine',
    searchTerms: ['sprint engine', 'sprintengine', 'roster', 'kanban', 'evidence'],
    createTemplate: () => createSprintEngineTemplate(defaultSprintEngineTemplateConfig),
    isRunGlyphProviderForWorkspace: isSprintEngineRunGlyphWorkspace,
    deriveRunGlyph: deriveSprintEngineWorkspaceRunGlyph,
    isRunCompletionUnseen: isSprintEngineRunCompletionUnseen,
    supervisors: [
      { Component: SprintEngineAutoRunSupervisor, scope: 'global' },
    ],
    creationStepsId: 'sprintengine',
    pickerOrder: 20,
  })
  // Guided Brief hands off into Sprint Engine, so this dependent workspace type
  // is registered by the Sprint Engine capability module.
  host.registerWorkspaceType({
    id: 'guided-brief',
    label: 'Guided brief',
    description: 'Answer questions. We produce a brief, screens, and a build handoff before any code starts.',
    icon: GuidedBriefWorkspaceTypeIcon,
    accentToken: '--accent-primary',
    searchTerms: ['guided brief', 'brief', 'mockups', 'build handoff'],
    createTemplate: createGuidedBriefTemplate,
    creationStepsId: 'guided-brief',
    pickerOrder: 40,
  })
}
