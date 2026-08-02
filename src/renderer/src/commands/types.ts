import type { KeybindingPlatform } from './keybindings'

export type CommandCategory =
  | 'settings'
  | 'command_palette'
  | 'workspace'
  | 'panel'
  | 'specialist'
  | 'voice'
  | 'editor'
  | 'sprintengine'
  | 'git'
  | 'terminal'
  | 'diagnostics'

export type CommandScope =
  | 'global'
  | 'workspace'
  | 'workspace-navigation'
  | 'editor'
  | 'terminal'
  | 'panel'
  | 'panel:sprintengine'
  | 'panel:watchtower'
  // Open scope family (MC-1533): `panel:<moduleId>` scopes are derived from
  // the workspace-type registry — the shell pushes one when the active
  // workspace's mode belongs to that module — so a capability module's
  // commands can gate on "my workspace is active" without growing this union
  // per module. `panel:switchboard` is a member of this family;
  // `panel:watchtower` stays a named literal because Watchtower is a surface
  // of the switchboard module, not a workspace mode of its own, and
  // `panel:sprintengine` stays named because its module id ('sprint-engine')
  // differs from its mode id. `(string & {})` keeps the named literals in
  // completions while accepting the derived family.
  | (string & {})

export type CommandAvailability =
  | 'always'
  | 'activeWorkspace'
  | 'activeFile'
  | 'sprintengineWorkspace'
  | 'sprintengineHasArchitect'
  | 'sprintengineFocusAgentVisible'
  // The memory-graph capability module is enabled, so the Knowledge Graph
  // panel component is registered and a toggle can actually mount it. The
  // panel has no rail glyph; the palette/menu toggle is its only entry point.
  | 'memoryGraphEnabled'
  // The sprint-engine capability module is enabled, so the app-level Sprint
  // Engines aside (the global run survey docked right of the workspace card)
  // can be toggled.
  | 'sprintEngineEnabled'
  // The Git panel is mounted in the active workspace, so its panel-command
  // handlers (refresh/fetch/commit) can receive and act on a dispatch.
  | 'gitPanelActive'
  // The active workspace has at least one live terminal session to focus/stop.
  | 'terminalActive'
  // Dev build or MULTICODE_DIAGNOSTICS=1: the performance diagnostics panel is
  // an engineering tool, so its command is offered only when diagnostics are on.
  | 'diagnosticsEnabled'
  // The automations capability module is enabled, so the global Automations
  // screen has a backing store/IPC and can be opened.
  | 'automationsEnabled'
  // Open at the type level (MC-1533) so a compiled module built against a
  // newer SDK enum never breaks on an older shell: an unknown condition is
  // simply absent from the runtime context, so the command stays unavailable
  // (fail closed). Module-specific gating belongs in availability predicates,
  // not new enum members.
  | (string & {})

export type CommandHandlerPath =
  | { kind: 'workspace-manager'; handler: string }
  | { kind: 'panel-event'; eventId: string }
  | { kind: 'app-menu'; command: string }
  | { kind: 'command-palette'; handler: string }
  | { kind: 'context-bound'; owner: string; action: string }

// The published context view a module availability predicate is evaluated
// against. Deliberately tiny — extend only by demonstrated need; anything a
// module knows about its own state it checks inside the predicate itself.
export type ModuleCommandContext = {
  activeWorkspaceId: string | null
  activeWorkspaceMode: string | null
}

// The shape shared by every command the palette, keybindings pipeline, and
// dispatcher consume. Shell commands attach a handlerPath descriptor on top of
// this (CommandDefinition); module commands attach their handler callback
// directly (RegisteredModuleCommand in modules/renderer-host.ts). Module
// commands group under their module's own label, so `category` is open here
// and narrowed to CommandCategory on CommandDefinition.
export type CommandContribution = {
  id: string
  title: string
  category: CommandCategory | (string & {})
  scopes: readonly CommandScope[]
  defaultKeybindings?: readonly string[]
  availability?: readonly CommandAvailability[]
  // Module commands only: a predicate over the published context view,
  // replacing per-module growth of the CommandAvailability enum. Evaluated by
  // the same availability gate the palette and dispatcher share; absent a
  // context (early boot) the command is unavailable, never a silent no-op.
  availabilityPredicate?: (context: ModuleCommandContext) => boolean
  keybindingContext?: string
  allowInEditableTarget?: boolean
}

export type CommandDefinition = CommandContribution & {
  category: CommandCategory
  handlerPath: CommandHandlerPath
}

export type PlatformKeybindingMap = Partial<Record<KeybindingPlatform, readonly string[]>>
