import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, SprintEngineMockConfig } from '../types/workspace'
import { createSprintEngineLayoutTemplate } from '../../../shared/sprintengine/workspace-record'
import { SprintEngineWorkspaceTypeIcon } from '../components/AppIcons'
import { deriveSprintEngineRunGlyph } from '../utils/sprintengine'
import { isSprintEngineWorkspace } from '../utils/sprintEngineWorkspace'
import type { WorkspaceRunGlyph, WorkspaceRunGlyphProviderInput } from '../utils/workspaceRunGlyph'

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
    sprintEngineState: workspace.sprintEngineState,
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
    // The auto-run supervisor component is retired (sprint-runtime-ownership
    // Phase 3): scheduling AND session reconcile run in the main-process
    // scheduler (src/main/sprint-runtime.ts); the runtime bridge mirrors its
    // store mutations into every window. No renderer supervisor remains.
    // Sprint creation left the wizard (MC-2062): picking this type anywhere —
    // the hub rail, the sidebar "+" menu — opens the New sprint dialog, never
    // a wizard flow. There is no sprint creation flow, so no creationStepsId:
    // the type registers for the sake of existing sprint workspaces, and the
    // hub reroutes any selection of it to the dialog.
    pickerOrder: 20,
  })
  // The `roadmap` workspace type retired (MC-1692): Roadmap is now an
  // instance-global door in the sidebar (the `roadmap` capability module's
  // sidebar-nav contribution), not a per-project workspace you mint from the
  // picker. Its board panel + sidebar door live in `roadmap-module.ts`.
}
