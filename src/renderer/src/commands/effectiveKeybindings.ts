import { getCommandDefinition, type CommandId } from './commandRegistry'
import { parseKeybinding, renderKeybinding, type KeybindingPlatform } from './keybindings'
import type { CommandContribution } from './types'

export type KeybindingSettingsLike = {
  overrides?: Readonly<Record<string, readonly string[]>>
  disabled?: Readonly<Record<string, boolean>>
}

const SPECIALIST_COMMAND_BY_ID: Readonly<Record<string, CommandId>> = {
  architect: 'specialist.spawn.architect',
  performance: 'specialist.spawn.performance',
  'frontend-design-review': 'specialist.spawn.frontend-design-review',
  'nuclear-review': 'specialist.spawn.nuclear-review',
}

export function platformKeybindingsFromApiPlatform(platform: string): KeybindingPlatform {
  if (platform === 'darwin') return 'darwin'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

export function getSpecialistCommandId(specialistId: string): CommandId | null {
  return SPECIALIST_COMMAND_BY_ID[specialistId] ?? null
}

// `command` carries the registry defaults for commands that live outside the
// static shell registry (module contributions); shell commands resolve through
// getCommandDefinition as before.
export function getEffectiveKeybindings(
  commandId: string,
  settings?: KeybindingSettingsLike | null,
  command?: Pick<CommandContribution, 'defaultKeybindings'> | null,
): readonly string[] {
  if (settings?.disabled?.[commandId] === true) return []
  const override = settings?.overrides?.[commandId]
  if (override && override.length > 0) return override
  return (command ?? getCommandDefinition(commandId))?.defaultKeybindings ?? []
}

export function getEffectiveKeybindingLabel(
  commandId: string,
  settings?: KeybindingSettingsLike | null,
  platform: KeybindingPlatform = 'linux',
  command?: Pick<CommandContribution, 'defaultKeybindings'> | null,
): string | null {
  const keybinding = getEffectiveKeybindings(commandId, settings, command)[0]
  return keybinding ? renderKeybinding(keybinding, platform) : null
}

export function getElectronAccelerator(
  commandId: string,
  settings?: KeybindingSettingsLike | null,
): string | null {
  const keybinding = getEffectiveKeybindings(commandId, settings)[0]
  if (!keybinding) return null
  const parsed = parseKeybinding(keybinding)
  if (!parsed.ok || parsed.chord.strokes.length !== 1) return null
  const stroke = parsed.chord.strokes[0]
  const modifiers = stroke.modifiers.map((modifier) => {
    if (modifier === 'primary') return 'CmdOrCtrl'
    if (modifier === 'ctrl') return 'Ctrl'
    if (modifier === 'meta') return 'Command'
    if (modifier === 'alt') return 'Alt'
    return 'Shift'
  })
  const key = stroke.key.length === 1
    ? stroke.key.toUpperCase()
    : stroke.key.replace(/^arrow/u, '')
  return [...modifiers, key].join('+')
}
