import type { ModuleCommandDefinition, RendererHost } from './renderer-host'
import { dispatchPanelCommandEvent } from '../utils/panelCommands'
import type { FuturePlanWorkspaceSource } from '../types/workspace'

// Sprint Engine palette/shortcut commands (MC-2577). Bare ids become
// `sprint-engine.<id>` at registration. Board listeners still hear the
// legacy `sprintengine.*` panel-command event ids — the board does not
// move in this step. Persisted keybinding overrides keyed by those
// legacy ids ride LEGACY_COMMAND_ID_ALIASES.

export const SPRINT_ENGINE_NEW_MODAL_ID = 'sprint-engine-new'

export const SPRINT_ENGINE_COMMAND_LEGACY_ALIASES: Readonly<Record<string, string>> = {
  'sprint-engine.verify.progress': 'sprintengine.verify.progress',
  'sprint-engine.add.role': 'sprintengine.add.role',
  'sprint-engine.read.plan': 'sprintengine.read.plan',
  'sprint-engine.focus.agent': 'sprintengine.focus.agent',
  'sprint-engine.refresh.board': 'sprintengine.refresh.board',
  'sprint-engine.goto.inbox': 'sprintengine.goto.inbox',
  'sprint-engine.goto.roster': 'sprintengine.goto.roster',
  'sprint-engine.goto.tasks': 'sprintengine.goto.tasks',
  'sprint-engine.goto.graph': 'sprintengine.goto.graph',
  'sprint-engine.goto.kanban': 'sprintengine.goto.kanban',
  'sprint-engine.open.settings': 'sprintengine.open.settings',
}

function dispatchBoard(eventId: string): void {
  dispatchPanelCommandEvent(eventId)
}

const BOARD_COMMANDS: readonly ModuleCommandDefinition[] = [
  {
    id: 'verify.progress',
    title: 'Verify progress',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    availability: ['sprintengineWorkspace', 'sprintengineHasArchitect'],
    run: () => dispatchBoard('sprintengine.verify.progress'),
  },
  {
    id: 'add.role',
    title: 'More roles',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    availability: ['sprintengineWorkspace', 'workflowRolesInstalled'],
    run: () => dispatchBoard('sprintengine.add.role'),
  },
  {
    id: 'read.plan',
    title: 'Read plan',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    availability: ['sprintengineWorkspace'],
    run: () => dispatchBoard('sprintengine.read.plan'),
  },
  {
    id: 'focus.agent',
    title: 'Focus active agent',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    availability: ['sprintengineWorkspace', 'sprintengineFocusAgentVisible'],
    run: () => dispatchBoard('sprintengine.focus.agent'),
  },
  {
    id: 'refresh.board',
    title: 'Refresh board',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    availability: ['sprintengineWorkspace'],
    run: () => dispatchBoard('sprintengine.refresh.board'),
  },
  {
    id: 'goto.inbox',
    title: 'Inbox',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    defaultKeybindings: ['G then I'],
    availability: ['sprintengineWorkspace'],
    run: () => dispatchBoard('sprintengine.goto.inbox'),
  },
  {
    id: 'goto.roster',
    title: 'Agents',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    defaultKeybindings: ['G then R'],
    availability: ['sprintengineWorkspace'],
    run: () => dispatchBoard('sprintengine.goto.roster'),
  },
  {
    id: 'goto.tasks',
    title: 'Tasks',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    defaultKeybindings: ['G then T'],
    availability: ['sprintengineWorkspace'],
    run: () => dispatchBoard('sprintengine.goto.tasks'),
  },
  {
    id: 'goto.graph',
    title: 'Tasks → Graph layout',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    defaultKeybindings: ['G then G'],
    availability: ['sprintengineWorkspace'],
    run: () => dispatchBoard('sprintengine.goto.graph'),
  },
  {
    id: 'goto.kanban',
    title: 'Tasks → Kanban layout',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    defaultKeybindings: ['G then K'],
    availability: ['sprintengineWorkspace'],
    run: () => dispatchBoard('sprintengine.goto.kanban'),
  },
  {
    id: 'open.settings',
    title: 'Run configuration',
    category: 'Sprint',
    scopes: ['panel:sprint-engine'],
    defaultKeybindings: ['Primary+,'],
    availability: ['sprintengineWorkspace'],
    run: () => dispatchBoard('sprintengine.open.settings'),
  },
]

const NEW_SPRINT_COMMAND: ModuleCommandDefinition = {
  id: 'new',
  title: 'New sprint',
  category: 'Sprint',
  scopes: ['global'],
  defaultKeybindings: ['Primary+Shift+N'],
  run: () => {
    void import('./sprint-engine-new-sprint').then(({ openSprintEngineNewSprint }) => {
      openSprintEngineNewSprint()
    })
  },
}

export function registerSprintEngineCommands(host: RendererHost): void {
  for (const command of BOARD_COMMANDS) host.registerCommand(command)
  host.registerCommand(NEW_SPRINT_COMMAND)
}

export type NewSprintOpenArgs = {
  folderPath?: string | null
  source?: FuturePlanWorkspaceSource | null
}
