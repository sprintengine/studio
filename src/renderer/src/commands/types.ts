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
  | 'multiloop'
  | 'watchtower'
  | 'switchboard'
  | 'git'
  | 'terminal'

export type CommandScope =
  | 'global'
  | 'workspace'
  | 'workspace-navigation'
  | 'editor'
  | 'terminal'
  | 'panel'
  | 'panel:sprintengine'
  | 'panel:multiloop'
  | 'panel:watchtower'
  | 'panel:switchboard'

export type CommandAvailability =
  | 'always'
  | 'activeWorkspace'
  | 'activeFile'
  | 'voiceDictationEnabled'
  | 'sprintengineWorkspace'
  | 'sprintengineHasArchitect'
  | 'sprintengineFocusAgentVisible'
  | 'multiloopWorkspace'
  | 'multiloopStateLoaded'
  | 'switchboardWorkspace'
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

export type CommandHandlerPath =
  | { kind: 'workspace-manager'; handler: string }
  | { kind: 'panel-event'; eventId: string }
  | { kind: 'app-menu'; command: string }
  | { kind: 'command-palette'; handler: string }
  | { kind: 'context-bound'; owner: string; action: string }

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
  keybindingContext?: string
  allowInEditableTarget?: boolean
}

export type CommandDefinition = CommandContribution & {
  category: CommandCategory
  handlerPath: CommandHandlerPath
}

export type PlatformKeybindingMap = Partial<Record<KeybindingPlatform, readonly string[]>>
