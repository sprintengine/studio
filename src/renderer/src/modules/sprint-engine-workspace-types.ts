import { lazy } from 'react'
import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, SprintEngineMockConfig } from '../types/workspace'
import { createSprintEngineLayoutTemplate } from '../../../shared/sprintengine/workspace-record'

export type { SprintEngineModuleState } from '../../../shared/sprintengine/workspace-record'
import { SprintEngineWorkspaceTypeIcon } from '../components/AppIcons'
import { deriveSprintEngineRunGlyph } from '../utils/sprintengine'
import { isSprintEngineWorkspace } from '../utils/sprintEngineWorkspace'
import type { WorkspaceRunGlyph, WorkspaceRunGlyphProviderInput } from '../utils/workspaceRunGlyph'
import { sprintEngineRunState } from '../store/slices/workspaceModuleState'

const SprintEngineProjectionSupervisor = lazy(() => import('../components/workspace/SprintEngineProjectionSupervisor'))
const SprintEngineRunChangeSubscriber = lazy(() => import('../components/workspace/SprintEngineRunChangeSubscriber'))

const defaultSprintEngineTemplateConfig: SprintEngineMockConfig = {
  name: 'Sprint Roster',
  goal: '',
  roleCounts: {} as SprintEngineMockConfig['roleCounts'],
}

// The layout itself lives in `shared/sprintengine/workspace-record.ts` (MC-2160)
// so a headlessly minted sprint workspace and a window-minted one record the
// same template id and board tab. The config has never shaped the layout.
export function createSprintEngineTemplate(_config: SprintEngineMockConfig): LayoutTemplate {
  return createSprintEngineLayoutTemplate()
}

// A sprint's run glyph is a pure function of sprint state — the task board plus
// the AutoRun runtime (see deriveSprintEngineRunGlyph). Terminals are ephemeral
// and deliberately excluded: a single agent terminal sitting at a prompt must
// not light the whole sprint. The rollup already covers a manually-completed run
// (all tasks done → `done`), so there is nothing terminal-derived to fold in.
function deriveSprintEngineWorkspaceRunGlyph(
  workspace: WorkspaceRunGlyphProviderInput,
): WorkspaceRunGlyph | null {
  return deriveSprintEngineRunGlyph({
    sprintEngineState: sprintEngineRunState(workspace),
    autoState: workspace.sprintEngineAutoState,
  })
}

export function registerSprintEngineWorkspaceTypes(host: RendererHost): void {
  host.registerWorkspaceType({
    id: 'sprintengine',
    label: 'Sprint',
    description: 'Inbox, Agents, and Tasks together in one stable board.',
    icon: SprintEngineWorkspaceTypeIcon,
    accentToken: '--tool-sprintengine',
    searchTerms: ['sprint engine', 'sprintengine', 'roster', 'kanban', 'evidence'],
    createTemplate: () => createSprintEngineTemplate(defaultSprintEngineTemplateConfig),
    isRunGlyphProviderForWorkspace: isSprintEngineWorkspace,
    deriveRunGlyph: deriveSprintEngineWorkspaceRunGlyph,
    // Projection refresh and the quiesced-run change subscriber used to be
    // propful mounts in WorkspaceManager (they needed the window's workspace
    // list). They now read that list from the store themselves, so they ship
    // as zero-prop WorkspaceTypeDefinition.supervisors. Auto-run scheduling
    // still lives in the main-process scheduler; these only keep this
    // window's bag projection current.
    supervisors: [
      { Component: SprintEngineProjectionSupervisor, scope: 'all-windows' },
      { Component: SprintEngineRunChangeSubscriber, scope: 'all-windows' },
    ],
    // Sprint creation left the wizard (MC-2062): picking this type anywhere —
    // the hub rail, the sidebar "+" menu — opens the New sprint dialog, never
    // a wizard flow. There is no sprint creation flow, so no creationStepsId:
    // the type registers for the sake of existing sprint workspaces, and the
    // hub reroutes any selection of it to the dialog.
    pickerOrder: 20,
  })
  // The `roadmap` workspace type retired (MC-1692) and its door was deleted on
  // 2026-09-05, so nothing registers it. The plans it steered are still files
  // under the home project's `backlog/roadmaps/`.
}
