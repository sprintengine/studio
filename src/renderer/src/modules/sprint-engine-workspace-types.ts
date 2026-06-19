import React from 'react'

import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot, SprintEngineMockConfig } from '../types/workspace'
import { GuidedBriefWorkspaceTypeIcon, SprintEngineWorkspaceTypeIcon } from '../components/AppIcons'
import { deriveSprintEngineRunGlyph } from '../utils/sprintengine'
import { isSprintEngineWorkspace } from '../utils/sprintEnginesNav'
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
  name: 'Design Wizard',
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

// AutoRun never reaches `complete` on a manual run, so a run whose tasks all
// finished by hand still reads as done.
function isManualRunCompleted(workspace: WorkspaceRunGlyphProviderInput): boolean {
  const tasks = workspace.sprintEngineState?.tasks ?? []
  return tasks.length > 0 && tasks.every((task) => task.status === 'done')
}

function parseCompletionTime(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function manualRunCompletionAt(workspace: WorkspaceRunGlyphProviderInput): number | null {
  if (!isManualRunCompleted(workspace)) return null
  const completedAt = (workspace.sprintEngineState?.tasks ?? [])
    .map((task) => parseCompletionTime(task.completedAt))
    .filter((value): value is number => typeof value === 'number')
  return completedAt.length > 0 ? Math.max(...completedAt) : 1
}

function sprintEngineCompletionAt(workspace: WorkspaceRunGlyphProviderInput, rollupState: string | null): number | null {
  if (rollupState === 'done') {
    return typeof workspace.sprintEngineAutoState?.changedAt === 'number'
      && Number.isFinite(workspace.sprintEngineAutoState.changedAt)
      ? workspace.sprintEngineAutoState.changedAt
      : 1
  }
  return manualRunCompletionAt(workspace)
}

function completionIsUnseen(workspace: WorkspaceRunGlyphProviderInput, completionAt: number): boolean {
  return typeof workspace.sprintEngineCompletionSeenAt !== 'number'
    || !Number.isFinite(workspace.sprintEngineCompletionSeenAt)
    || workspace.sprintEngineCompletionSeenAt < completionAt
}

// A completed run wears the done glyph until the user views the workspace after
// completion. Recency survives in the glyph tooltip and returns once the
// completion has been acknowledged.
export function deriveSprintEngineWorkspaceRunGlyph(
  workspace: WorkspaceRunGlyphProviderInput,
  activity: WorkspaceActivityKind,
) {
  const rollup = deriveSprintEngineRunGlyph({
    sprintEngineState: workspace.sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
  })
  if (rollup && rollup.state !== 'done') return rollup
  // Busy or failed terminals outrank a finished run: new activity in a
  // completed workspace reads as live again via the caller's fallback.
  if (activity === 'working' || activity === 'failed') return null
  if (rollup?.state === 'done' || isManualRunCompleted(workspace)) {
    const completionAt = sprintEngineCompletionAt(workspace, rollup?.state ?? null)
    if (completionAt !== null && completionIsUnseen(workspace, completionAt)) {
      return { state: 'done', live: false, label: 'Run completed' } as const
    }
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
    isRunGlyphProviderForWorkspace: isSprintEngineWorkspace,
    deriveRunGlyph: deriveSprintEngineWorkspaceRunGlyph,
    supervisors: [
      { Component: SprintEngineAutoRunSupervisor, scope: 'global' },
    ],
    creationStepsId: 'sprintengine',
    pickerOrder: 20,
  })
  // Design Wizard (internal id 'guided-brief') hands off into Sprint Engine, so
  // this dependent workspace type is registered by the Sprint Engine capability
  // module. The 'guided-brief' id stays frozen as a compatibility identifier.
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
