import { collapseDuplicateKeybindings } from './keybindings'
import type { CommandDefinition } from './types'

function command(definition: CommandDefinition): CommandDefinition {
  return {
    ...definition,
    defaultKeybindings: definition.defaultKeybindings
      ? collapseDuplicateKeybindings(definition.defaultKeybindings)
      : undefined,
  }
}

export const COMMAND_REGISTRY = [
  command({
    id: 'app.settings.open',
    title: 'Open Settings',
    category: 'settings',
    scopes: ['global'],
    defaultKeybindings: ['Primary+,'],
    handlerPath: { kind: 'workspace-manager', handler: 'openSettings(false)' },
  }),
  command({
    id: 'app.updates.check',
    title: 'Check For Updates',
    category: 'settings',
    scopes: ['global'],
    handlerPath: { kind: 'app-menu', command: 'check-for-updates' },
  }),
  command({
    id: 'commandPalette.open',
    title: 'Open Command Palette',
    category: 'command_palette',
    scopes: ['global'],
    defaultKeybindings: ['Primary+K', 'Primary+Shift+P'],
    handlerPath: { kind: 'workspace-manager', handler: 'setCommandPaletteOpen(true)' },
  }),
  command({
    id: 'workspace.new',
    title: 'New Workspace',
    category: 'workspace',
    scopes: ['global'],
    defaultKeybindings: ['Primary+T'],
    handlerPath: { kind: 'workspace-manager', handler: 'openNewWorkspacePanel()' },
  }),
  // Opens the pre-creation New Chat panel. Global-scope like workspace.new:
  // openNewChatPanel() resolves to the active workspace's folder when one exists
  // and to null otherwise, so it works with no active workspace.
  command({
    id: 'chat.new',
    title: 'New Chat',
    category: 'workspace',
    scopes: ['global'],
    defaultKeybindings: ['Primary+N'],
    handlerPath: { kind: 'workspace-manager', handler: 'openNewChatPanel()' },
  }),
  command({
    id: 'workspace.close',
    title: 'Close Workspace',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+W'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'closeWorkspaceById(windowActiveWorkspaceId)' },
  }),
  command({
    id: 'workspace.switch.next',
    title: 'Switch Workspace Forward',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    defaultKeybindings: ['Primary+`', 'Meta+Alt+ArrowRight'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'getNextWorkspaceId(..., 1) -> setActiveWorkspaceForWindow(workspaceWindowId, nextWorkspaceId)' },
  }),
  command({
    id: 'workspace.switch.previous',
    title: 'Switch Workspace Back',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    defaultKeybindings: ['Primary+Shift+`', 'Meta+Alt+ArrowLeft'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'getNextWorkspaceId(..., -1) -> setActiveWorkspaceForWindow(workspaceWindowId, previousWorkspaceId)' },
  }),
  command({
    id: 'workspace.history.back',
    title: 'Go Back (Recent Workspace)',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'stepWorkspaceHistory(..., -1) -> setActiveWorkspaceForWindow(workspaceWindowId, visitedWorkspaceId)' },
  }),
  command({
    id: 'workspace.history.forward',
    title: 'Go Forward (Recent Workspace)',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'stepWorkspaceHistory(..., 1) -> setActiveWorkspaceForWindow(workspaceWindowId, visitedWorkspaceId)' },
  }),
  ...Array.from({ length: 9 }, (_, index) => {
    const workspaceNumber = index + 1
    return command({
      id: `workspace.switch.${workspaceNumber}`,
      title: `Switch to Workspace ${workspaceNumber}`,
      category: 'workspace',
      scopes: ['workspace-navigation'],
      defaultKeybindings: [`Primary+${workspaceNumber}`],
      availability: ['activeWorkspace'],
      handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: `setActiveWorkspaceForWindow(workspaceWindowId, visibleWorkspaces[${index}].id)` },
    })
  }),
  command({
    id: 'workspace.sidebar.toggle',
    title: 'Toggle Sidebar',
    category: 'workspace',
    scopes: ['global'],
    defaultKeybindings: ['Primary+B'],
    handlerPath: { kind: 'workspace-manager', handler: 'setSidebarCollapsed(!sidebarCollapsed)' },
  }),
  command({
    id: 'layout.tab.next',
    title: 'Next Layout Tab',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Tab', 'Meta+Shift+]'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'cycleActiveLayoutTab(windowActiveWorkspaceId, 1)' },
  }),
  command({
    id: 'layout.tab.previous',
    title: 'Previous Layout Tab',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+Tab', 'Meta+Shift+['],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'cycleActiveLayoutTab(windowActiveWorkspaceId, -1)' },
  }),
  command({
    id: 'layout.tab.close',
    title: 'Close Layout Tab',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+W'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'closeActiveLayoutTab(windowActiveWorkspaceId, terminalSessions)' },
  }),
  command({
    id: 'panel.files.toggle',
    title: 'Toggle File Explorer',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+E'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'toggle-explorer' },
  }),
  command({
    id: 'panel.editor.toggle',
    title: 'Toggle Code Editor',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+O'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'toggle-editor' },
  }),
  command({
    id: 'panel.git.toggle',
    title: 'Toggle Git Panel',
    category: 'git',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+G'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'toggle-git' },
  }),
  // The Knowledge Graph has no rail glyph (the rail is reserved for the
  // navigational core: Files / Git / Backlog), so this
  // command — surfaced in the palette and the View menu — is its entry point.
  // It ships unbound; users can bind it in Shortcuts settings.
  command({
    id: 'panel.knowledge-graph.toggle',
    title: 'Toggle Knowledge Graph',
    category: 'panel',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'memoryGraphEnabled'],
    handlerPath: { kind: 'app-menu', command: 'panel.knowledge-graph.toggle' },
  }),
  // The Sprint Engines aside is app-level chrome (it surveys every workspace
  // and survives workspace switches), so unlike the rail panel toggles it is
  // global scope and needs no active workspace. It ships unbound; users can
  // bind it in Shortcuts settings.
  command({
    id: 'panel.sprint-engines.toggle',
    title: 'Toggle Sprints',
    category: 'panel',
    scopes: ['global'],
    availability: ['sprintEngineEnabled'],
    handlerPath: { kind: 'workspace-manager', handler: 'setSprintEnginesAsideOpen(!sprintEnginesAsideOpen)' },
  }),
  // The Attention Queue is core shell chrome (cross-workspace "agents awaiting
  // you"), so it is global-scope and ungated — no active workspace and no module
  // required. Ships unbound; users can bind it in Shortcuts settings.
  command({
    id: 'panel.attention-queue.toggle',
    title: 'Toggle Attention Queue',
    category: 'panel',
    scopes: ['global'],
    handlerPath: { kind: 'workspace-manager', handler: 'setAttentionQueueOpen(!attentionQueueOpen)' },
  }),
  command({
    id: 'git.worktrees.open',
    title: 'Git: Manage Worktrees',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: "revealNavRailComponent(windowActiveWorkspaceId, 'git', 'Git')" },
  }),
  // Git refresh/fetch/commit run the Git panel's real handlers via the
  // panel-command bridge, so they are only available while the Git panel is
  // mounted in the active workspace. No default keybindings: refresh is safe but
  // unbound by default, and commit/fetch are stateful — users can bind them in
  // the Shortcuts settings (commit is destructive-adjacent, so it ships unbound
  // per the plan's no-risky-default rule).
  command({
    id: 'git.refresh',
    title: 'Git: Refresh Status',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.refresh' },
  }),
  command({
    id: 'git.fetch',
    title: 'Git: Fetch Remotes',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.fetch' },
  }),
  command({
    id: 'git.commit',
    title: 'Git: Commit Staged Changes',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.commit' },
  }),
  command({
    id: 'terminal.new',
    title: 'Open Plain Terminal',
    category: 'terminal',
    scopes: ['workspace'],
    defaultKeybindings: ["Primary+Shift+'"],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: 'addNewTerminal()' },
  }),
  // Focus/stop act on the active workspace's live terminal, so they require a
  // terminal session to exist. Unbound by default: focus is benign but bindable,
  // and stop kills a session (destructive) so it ships without a default key.
  command({
    id: 'terminal.focus',
    title: 'Focus Terminal',
    category: 'terminal',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'terminalActive'],
    handlerPath: { kind: 'workspace-manager', handler: 'focusActiveTerminal()' },
  }),
  command({
    id: 'terminal.stop',
    title: 'Stop Active Terminal',
    category: 'terminal',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'terminalActive'],
    handlerPath: { kind: 'workspace-manager', handler: 'stopActiveTerminal()' },
  }),
  // The performance diagnostics panel is a dev/diagnostics-only engineering
  // tool (process metrics, terminal/replay footprint, retention warnings).
  // Gated on diagnosticsEnabled so it never surfaces in a normal build; ships
  // unbound (users can bind it in Shortcuts settings).
  command({
    id: 'diagnostics.open',
    title: 'Diagnostics: Performance Panel',
    category: 'diagnostics',
    scopes: ['global'],
    availability: ['diagnosticsEnabled'],
    handlerPath: { kind: 'workspace-manager', handler: 'setDiagnosticsOpen(true)' },
  }),
  command({
    id: 'voice.toggle',
    title: 'Toggle Voice Transcription',
    category: 'voice',
    scopes: ['global'],
    defaultKeybindings: ['Primary+Shift+1'],
    availability: ['voiceDictationEnabled'],
    handlerPath: { kind: 'workspace-manager', handler: 'voiceDictation.toggle()' },
    keybindingContext: 'Allowed in editable targets so dictation can start while composing.',
    allowInEditableTarget: true,
  }),
  command({
    id: 'specialist.spawn.architect',
    title: 'Spawn Architect Specialist',
    category: 'specialist',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+P'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: "addNewSpecialist('architect')" },
  }),
  command({
    id: 'specialist.spawn.performance',
    title: 'Spawn Performance Specialist',
    category: 'specialist',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+M'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: "addNewSpecialist('performance')" },
  }),
  command({
    id: 'specialist.spawn.frontend-design-review',
    title: 'Spawn Frontend Designer Specialist',
    category: 'specialist',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+F'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: "addNewSpecialist('frontend-design-review')" },
  }),
  command({
    id: 'sprintengine.verify.progress',
    title: 'Sprint: Verify Progress',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    availability: ['sprintengineWorkspace', 'sprintengineHasArchitect'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.verify.progress' },
  }),
  command({
    id: 'sprintengine.add.role',
    title: 'Sprint: More Roles',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.add.role' },
  }),
  command({
    id: 'sprintengine.request.plan-reviews',
    title: 'Sprint: Request Plan Reviews',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.request.plan-reviews' },
  }),
  command({
    id: 'sprintengine.address.feedback',
    title: 'Sprint: Address Feedback',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.address.feedback' },
  }),
  command({
    id: 'sprintengine.read.plan',
    title: 'Sprint: Read Plan',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.read.plan' },
  }),
  command({
    id: 'sprintengine.focus.agent',
    title: 'Sprint: Focus Active Agent',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    availability: ['sprintengineWorkspace', 'sprintengineFocusAgentVisible'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.focus.agent' },
  }),
  command({
    id: 'sprintengine.refresh.board',
    title: 'Sprint: Refresh Board',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.refresh.board' },
  }),
  command({
    id: 'sprintengine.goto.inbox',
    title: 'Sprint: Inbox',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    defaultKeybindings: ['G then I'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.goto.inbox' },
  }),
  command({
    id: 'sprintengine.goto.roster',
    title: 'Sprint: Agents',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    defaultKeybindings: ['G then R'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.goto.roster' },
  }),
  command({
    id: 'sprintengine.goto.tasks',
    title: 'Sprint: Tasks',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    defaultKeybindings: ['G then T'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.goto.tasks' },
  }),
  command({
    id: 'sprintengine.goto.graph',
    title: 'Sprint: Tasks Graph Layout',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    defaultKeybindings: ['G then G'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.goto.graph' },
  }),
  command({
    id: 'sprintengine.goto.kanban',
    title: 'Sprint: Tasks Kanban Layout',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    defaultKeybindings: ['G then K'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.goto.kanban' },
  }),
  command({
    id: 'sprintengine.open.settings',
    title: 'Sprint: Run Configuration',
    category: 'sprintengine',
    scopes: ['panel:sprintengine'],
    defaultKeybindings: ['Primary+,'],
    availability: ['sprintengineWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.open.settings' },
  }),
  command({
    id: 'multiloop.toggle.auto-run',
    title: 'Multiloop: Toggle Auto-run',
    category: 'multiloop',
    scopes: ['panel:multiloop'],
    availability: ['multiloopWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'multiloop.toggle.auto-run' },
  }),
  command({
    id: 'multiloop.open.coordinator',
    title: 'Multiloop: Open Coordinator',
    category: 'multiloop',
    scopes: ['panel:multiloop'],
    availability: ['multiloopWorkspace', 'multiloopStateLoaded'],
    handlerPath: { kind: 'panel-event', eventId: 'multiloop.open.coordinator' },
  }),
  command({
    id: 'multiloop.open.settings',
    title: 'Multiloop: Settings',
    category: 'multiloop',
    scopes: ['panel:multiloop'],
    defaultKeybindings: ['Primary+,'],
    availability: ['multiloopWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'multiloop.open.settings' },
  }),
  command({
    id: 'switchboard.refresh.board',
    title: 'Switchboard: Refresh Board',
    category: 'switchboard',
    scopes: ['panel:switchboard'],
    availability: ['switchboardWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'switchboard.refresh.board' },
  }),
  command({
    id: 'switchboard.open.runner',
    title: 'Switchboard: Open Runner',
    category: 'switchboard',
    scopes: ['panel:switchboard'],
    availability: ['switchboardWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'switchboard.open.runner' },
  }),
  command({
    id: 'watchtower.run.review',
    title: 'Watchtower: Run Review',
    category: 'watchtower',
    scopes: ['panel:watchtower'],
    handlerPath: { kind: 'panel-event', eventId: 'watchtower.run.review' },
  }),
  command({
    id: 'watchtower.triage.inbox',
    title: 'Watchtower: Triage Inbox',
    category: 'watchtower',
    scopes: ['panel:watchtower'],
    handlerPath: { kind: 'panel-event', eventId: 'watchtower.triage.inbox' },
  }),
  command({
    id: 'watchtower.open.active-review',
    title: 'Watchtower: Active Review',
    category: 'watchtower',
    scopes: ['panel:watchtower'],
    handlerPath: { kind: 'panel-event', eventId: 'watchtower.open.active-review' },
  }),
  command({
    id: 'watchtower.import.github',
    title: 'Watchtower: Import From GitHub',
    category: 'watchtower',
    scopes: ['panel:watchtower'],
    handlerPath: { kind: 'panel-event', eventId: 'watchtower.import.github' },
  }),
  command({
    id: 'watchtower.import.jira',
    title: 'Watchtower: Import From Jira',
    category: 'watchtower',
    scopes: ['panel:watchtower'],
    handlerPath: { kind: 'panel-event', eventId: 'watchtower.import.jira' },
  }),
  command({
    id: 'watchtower.refresh.board',
    title: 'Watchtower: Refresh',
    category: 'watchtower',
    scopes: ['panel:watchtower'],
    handlerPath: { kind: 'panel-event', eventId: 'watchtower.refresh.board' },
  }),
] as const satisfies readonly CommandDefinition[]

export type CommandId = (typeof COMMAND_REGISTRY)[number]['id']

export function getCommandDefinition(commandId: string): CommandDefinition | undefined {
  return COMMAND_REGISTRY.find((commandDefinition) => commandDefinition.id === commandId)
}

export function getAvailableCommandDefinitions(): readonly CommandDefinition[] {
  return COMMAND_REGISTRY
}
