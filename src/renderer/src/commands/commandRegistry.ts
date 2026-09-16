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
    handlerPath: { kind: 'app-menu', command: 'app.updates.check' },
  }),
  command({
    id: 'commandPalette.open',
    title: 'Open Command Palette',
    category: 'command_palette',
    scopes: ['global'],
    defaultKeybindings: ['Primary+K', 'Primary+Shift+P'],
    handlerPath: { kind: 'workspace-manager', handler: 'setCommandPaletteOpen(true)' },
  }),
  // Search Everywhere. `Shift Shift` is here for the reason a person reaches
  // for it: their hands are in a terminal and they
  // want the palette NOW. The dispatcher fires a lone-modifier double tap
  // regardless of target suppression, so it works inside xterm and Monaco where
  // ⌘K deliberately does not.
  //
  // It raises the SAME overlay `commandPalette.open` does, with the same
  // groups. The two are separate commands only so they are separately
  // rebindable and separately disableable: disable and rebind are per command,
  // so while the gesture rode the palette's id, turning off Double Shift meant
  // turning off ⌘K with it (double-shift review, 2026-09-10).
  command({
    id: 'search.everywhere',
    title: 'Search Everywhere',
    category: 'command_palette',
    scopes: ['global'],
    defaultKeybindings: ['Shift Shift'],
    handlerPath: { kind: 'workspace-manager', handler: 'setCommandPaletteOpen(true)' },
  }),
  // Find in Path. The same overlay `commandPalette.open` raises, opened filtered
  // to the file-backed groups — a snippet of code should not be ranked against
  // command and workspace rows. Global scope, like the palette itself: with no
  // workspace open the overlay says so rather than refusing to appear, which is
  // the behaviour a user pressing a search shortcut expects.
  command({
    id: 'search.files.open',
    title: 'Search in Files',
    category: 'command_palette',
    scopes: ['global'],
    defaultKeybindings: ['Primary+Shift+F'],
    handlerPath: { kind: 'workspace-manager', handler: 'setCommandPaletteOpen(true, "text")' },
  }),
  // Opens the pre-creation New Chat panel — the one way to start (owner,
  // 2026-09-04; the New workspace command and its hub are gone). Global-scope:
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
  // The chat composer's model picker (remote-sessions-ux / selector-menus-
  // premium). Works from inside the
  // composer's textarea — that is where a person is when they want to change
  // model — so it is allowed in editable targets. The chat view listens for
  // the panel event of the same id, which both the shell's runCommand (the
  // palette row) and the view's own binding resolution dispatch.
  command({
    id: 'chat.modelPicker.toggle',
    title: 'Toggle Model Picker',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+M'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'chat.modelPicker.toggle' },
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
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'stepNavigationHistory(..., -1) -> setActiveWorkspaceForWindow | openGlobalSurface (per visited entry kind)' },
  }),
  command({
    id: 'workspace.history.forward',
    title: 'Go Forward (Recent Workspace)',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'context-bound', owner: 'WorkspaceManager', action: 'stepNavigationHistory(..., 1) -> setActiveWorkspaceForWindow | openGlobalSurface (per visited entry kind)' },
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
  // Reveal-in-file-manager for the active checkout, and the keyboard half of
  // the workspace bar's open-in-editor split button (item 1990). The reveal
  // target is the workspace's mounted worktree when it has one, so this and the
  // control resolve the same folder; the control owns that resolution and this
  // command routes to it as a panel event.
  //
  // Consequence of routing to the control: it acts only while the workspace bar
  // is on screen. A door surface replaces the identity cluster with its own bar
  // (WorkspaceHeader), so this is inert there — the same shape as the git.*
  // panel commands, which gate on `gitPanelActive` for the same reason. It has
  // no equivalent flag because the control's presence also depends on the
  // main-process target probe, which the renderer cannot report as availability.
  command({
    id: 'workspace.folder.reveal',
    title: 'Reveal Workspace Folder',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+O'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'workspace.folder.reveal' },
  }),
  // Files, Git and (later) the browser live in the workspace pane — the
  // full-height column on the right (browser-pane epic). The pane toggle takes
  // ⌘⌥B — the whole column, one chord away from the ⌘B a person already reads
  // as "show or hide the side panel"; Files and Git keep theirs and now toggle
  // their pane tab.
  command({
    id: 'pane.toggle',
    title: 'Toggle Workspace Pane',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+B'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: 'setPaneOpen(windowActiveWorkspaceId, !paneOpen)' },
  }),
  command({
    id: 'panel.files.toggle',
    title: 'Toggle File Explorer',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+E'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'panel.files.toggle' },
  }),
  command({
    id: 'panel.editor.toggle',
    title: 'Toggle Code Editor',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+O'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'panel.editor.toggle' },
  }),
  command({
    id: 'panel.git.toggle',
    title: 'Toggle Git Panel',
    category: 'git',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+G'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'panel.git.toggle' },
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
  command({
    id: 'git.worktrees.open',
    title: 'Git: Manage Worktrees',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: "openPaneTab(windowActiveWorkspaceId, { kind: 'git' })" },
  }),
  // Git refresh/fetch/commit run the Git panel's real handlers via the
  // panel-command bridge, so they are only available while the Git tab is
  // showing in the active workspace's pane. No default keybindings: refresh is safe but
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
  // The Commit window's row actions, reachable from the keyboard with the menu
  // closed (git-commit-window T6). They act on the changes list's SELECTION, so
  // they are gated on the Git panel exactly as the three above are, and the
  // panel itself refuses them while one of its dialogs is open.
  //
  // ⌘D and ⌥⌘Z ship bound because they are the two the mockup's menu carries a
  // hint for and neither chord is spoken for. `git.changes.moveToChangelist`
  // ships UNBOUND on purpose: ⇧⌘M already belongs to the model picker
  // at workspace scope here, the dispatcher takes the first match, and a default
  // that quietly loses to another command is worse than none — so the menu
  // carries no hint for it either, per the kit's menu rule.
  command({
    id: 'git.changes.showDiff',
    title: 'Git: Show Diff For The Selected File',
    category: 'git',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+D'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.changes.showDiff' },
  }),
  command({
    id: 'git.changes.discard',
    title: 'Git: Discard Changes In The Selected Files',
    category: 'git',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+Z'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.changes.discard' },
  }),
  command({
    id: 'git.changes.moveToChangelist',
    title: 'Git: Move The Selected Files To Another Changelist',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.changes.moveToChangelist' },
  }),
  // No Fleet command: the Fleet panel (MC-2167) was retired on 2026-09-05
  // (remote-sessions-in-the-sidebar). Paired machines' sessions are rows in
  // the sidebar's Remote band; machine management is Settings → Remote and
  // the top bar's Remote glyph (WorkspaceActions → RemotePopover).
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
  // Find in the pane you are looking at — the scrollback of one terminal.
  //
  // The sibling of `search.files.open` (⌘⇧F, the workspace's files through
  // ripgrep), not a rival to it: same registry, same Shortcuts tab (where it
  // sits with the other Terminal commands and can be rebound), one key
  // narrower for one pane. It is the only command on the
  // `terminal` scope, which WorkspaceManager activates for exactly the
  // keystrokes that came from inside a terminal surface — so ⌘F anywhere else
  // (Monaco's own find, a text field) is untouched. `allowInEditableTarget`
  // because the keystroke arrives at xterm's hidden textarea, which
  // `isGlobalShortcutSuppressedTarget` treats as editable.
  command({
    id: 'terminal.find',
    title: 'Find in Terminal',
    category: 'terminal',
    scopes: ['terminal'],
    defaultKeybindings: ['Primary+F'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'terminal.find' },
  }),
  // Jump between the prompts OSC 133 marks. Same registry, same Shortcuts tab
  // and the same `terminal` scope as Find in Terminal — the scope
  // WorkspaceManager activates for exactly the keystrokes that came from inside
  // a terminal surface, so these keys are free everywhere else.
  //
  // Only a plain terminal answers. Agent panes are never sent the shell
  // integration that emits the marks, and this is shell ergonomics, not a
  // status feed: agent phase comes from `agent-state.ts` over the state socket.
  // `allowInEditableTarget` because the keystroke arrives at xterm's hidden
  // textarea, which `isGlobalShortcutSuppressedTarget` treats as editable.
  command({
    id: 'terminal.promptPrevious',
    title: 'Jump to Previous Prompt',
    category: 'terminal',
    scopes: ['terminal'],
    defaultKeybindings: ['Primary+Shift+ArrowUp'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'terminal.promptPrevious' },
  }),
  command({
    id: 'terminal.promptNext',
    title: 'Jump to Next Prompt',
    category: 'terminal',
    scopes: ['terminal'],
    defaultKeybindings: ['Primary+Shift+ArrowDown'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'terminal.promptNext' },
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
    id: 'specialist.spawn.architect',
    title: 'Spawn Architect Specialist',
    category: 'specialist',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+P'],
    availability: ['activeWorkspace', 'workflowRolesInstalled'],
    handlerPath: { kind: 'workspace-manager', handler: "addNewSpecialist('architect')" },
  }),
  command({
    id: 'specialist.spawn.performance',
    title: 'Spawn Performance Specialist',
    category: 'specialist',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+M'],
    availability: ['activeWorkspace', 'workflowRolesInstalled'],
    handlerPath: { kind: 'workspace-manager', handler: "addNewSpecialist('performance')" },
  }),
  command({
    id: 'specialist.spawn.frontend-design-review',
    title: 'Spawn Frontend Designer Specialist',
    category: 'specialist',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+F'],
    availability: ['activeWorkspace', 'workflowRolesInstalled'],
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
    availability: ['sprintengineWorkspace', 'workflowRolesInstalled'],
    handlerPath: { kind: 'panel-event', eventId: 'sprintengine.add.role' },
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
  // The Automations module's built-in commands are registered through
  // the module path (automations-module.ts) — the in-tree proof that
  // module-defined command scopes/availability carry a real feature.
] as const satisfies readonly CommandDefinition[]

export type CommandId = (typeof COMMAND_REGISTRY)[number]['id']

export function getCommandDefinition(commandId: string): CommandDefinition | undefined {
  return COMMAND_REGISTRY.find((commandDefinition) => commandDefinition.id === commandId)
}
