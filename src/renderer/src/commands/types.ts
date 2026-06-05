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

export type CommandHandlerPath =
  | { kind: 'workspace-manager'; handler: string }
  | { kind: 'panel-event'; eventId: string }
  | { kind: 'app-menu'; command: string }
  | { kind: 'command-palette'; handler: string }
  | { kind: 'context-bound'; owner: string; action: string }

export type CommandDefinition = {
  id: string
  title: string
  category: CommandCategory
  scopes: readonly CommandScope[]
  defaultKeybindings?: readonly string[]
  availability?: readonly CommandAvailability[]
  handlerPath: CommandHandlerPath
  keybindingContext?: string
  allowInEditableTarget?: boolean
}

export type PlatformKeybindingMap = Partial<Record<KeybindingPlatform, readonly string[]>>
