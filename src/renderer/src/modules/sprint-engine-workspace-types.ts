import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot, SprintEngineMockConfig } from '../types/workspace'
import { GuidedBriefWorkspaceTypeIcon, RoadmapWorkspaceTypeIcon, SprintEngineWorkspaceTypeIcon } from '../components/AppIcons'
import { deriveSprintEngineRunGlyph } from '../utils/sprintengine'
import { isSprintEngineWorkspace } from '../utils/sprintEnginesNav'
import type { WorkspaceRunGlyph, WorkspaceRunGlyphProviderInput } from '../utils/workspaceRunGlyph'

const agent = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'agent', label })
const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })

const sprintEngineBoardTab = () => ({
  type: 'tab',
  name: 'Sprint',
  component: 'sprintengine',
  enableClose: false,
})

const guidedBriefTab = () => ({
  type: 'tab',
  name: 'Design Wizard',
  component: 'guided-brief',
  enableClose: false,
})

const roadmapBoardTab = () => ({
  type: 'tab',
  name: 'Roadmap',
  component: 'roadmap',
  enableClose: false,
})

export const defaultSprintEngineTemplateConfig: SprintEngineMockConfig = {
  name: 'Sprint Roster',
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

// The roadmap steering board (MC-1620) is a workspace lens over the project's
// roadmap files — it is not "created" like a sprint run, so it carries no creation
// wizard: opening the mode drops you straight onto the board, which reads every
// roadmap in the project.
export function createRoadmapTemplate(): LayoutTemplate {
  return {
    id: 'roadmap-mode',
    name: 'Roadmap',
    description: 'See what ran, what is running, what is next, and what is waiting on you.',
    previewSlots: [editor('Roadmap', 4, 4, 292, 102)],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [roadmapBoardTab()],
          },
        ],
      },
    },
  }
}

export function createSprintEngineTemplate(_config: SprintEngineMockConfig): LayoutTemplate {
  return {
    id: 'sprintengine-mode',
    name: 'Sprint',
    description: 'Inbox, Agents, and Tasks together in one stable board.',
    previewSlots: [
      editor('Sprint', 4, 4, 292, 102),
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

// A sprint's run glyph is a pure function of sprint state — the task board plus
// the AutoRun runtime (see deriveSprintEngineRunGlyph). Terminals are ephemeral
// and deliberately excluded: a single agent terminal sitting at a prompt must
// not light the whole sprint. The rollup already covers a manually-completed run
// (all tasks done → `done`), so there is nothing terminal-derived to fold in.
export function deriveSprintEngineWorkspaceRunGlyph(
  workspace: WorkspaceRunGlyphProviderInput,
): WorkspaceRunGlyph | null {
  return deriveSprintEngineRunGlyph({
    sprintEngineState: workspace.sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
  })
}

export function registerSprintEngineWorkspaceTypes(host: RendererHost): void {
  host.registerWorkspaceType({
    id: 'sprintengine',
    label: 'Sprint',
    description: 'Specialist team, architect plan, kanban, and evidence trail.',
    icon: SprintEngineWorkspaceTypeIcon,
    accentToken: '--tool-sprintengine',
    searchTerms: ['sprint engine', 'sprintengine', 'roster', 'kanban', 'evidence'],
    createTemplate: () => createSprintEngineTemplate(defaultSprintEngineTemplateConfig),
    isRunGlyphProviderForWorkspace: isSprintEngineWorkspace,
    deriveRunGlyph: deriveSprintEngineWorkspaceRunGlyph,
    // The auto-run supervisor component is retired (sprint-runtime-ownership
    // Phase 3): scheduling AND session reconcile run in the main-process
    // scheduler (src/main/sprint-runtime.ts); the runtime bridge mirrors its
    // store mutations into every window. No renderer supervisor remains.
    creationStepsId: 'sprintengine',
    pickerOrder: 20,
  })
  // Roadmap steering board (MC-1620): a searchable workspace lens over the
  // project's roadmap files. No creation wizard — the mode opens straight onto the
  // board (createRoadmapTemplate).
  host.registerWorkspaceType({
    id: 'roadmap',
    label: 'Roadmap',
    description: 'Steer a multi-week roadmap: progress, pull requests, and what is waiting on you.',
    icon: RoadmapWorkspaceTypeIcon,
    accentToken: '--tool-sprintengine',
    searchTerms: ['roadmap', 'roadmaps', 'plan', 'steering', 'lanes', 'up next', 'waiting on you'],
    createTemplate: createRoadmapTemplate,
    pickerOrder: 25,
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
