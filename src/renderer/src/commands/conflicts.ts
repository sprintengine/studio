import { normalizeKeybinding } from './keybindings'
import type { CommandDefinition, CommandScope } from './types'

export type KeybindingConflictSeverity = 'blocking' | 'warning'

export type KeybindingConflict = {
  severity: KeybindingConflictSeverity
  keybinding: string
  conflictingCommandId: string
  conflictingCommandTitle: string
  reason: string
}

export type KeybindingConflictCandidate = {
  commandId: string
  commandTitle?: string
  keybindings: readonly string[]
  scopes: readonly CommandScope[]
}

const MUTUALLY_EXCLUSIVE_SCOPE_GROUPS: readonly (readonly CommandScope[])[] = [
  ['panel:sprintengine', 'panel:watchtower', 'panel:switchboard'],
  ['editor', 'terminal'],
]

function scopesOverlap(a: readonly CommandScope[], b: readonly CommandScope[]): boolean {
  return a.includes('global') || b.includes('global') || a.some((scope) => b.includes(scope))
}

function scopesAreMutuallyExclusive(a: readonly CommandScope[], b: readonly CommandScope[]): boolean {
  return MUTUALLY_EXCLUSIVE_SCOPE_GROUPS.some((group) => (
    a.some((scope) => group.includes(scope)) && b.some((scope) => group.includes(scope)) && !scopesOverlap(a, b)
  ))
}

function toCandidate(command: CommandDefinition | KeybindingConflictCandidate): KeybindingConflictCandidate {
  const isDefinition = 'id' in command
  return {
    commandId: isDefinition ? command.id : command.commandId,
    commandTitle: isDefinition ? command.title : command.commandTitle,
    keybindings: isDefinition ? command.defaultKeybindings ?? [] : command.keybindings,
    scopes: command.scopes,
  }
}

export function findKeybindingConflicts(
  candidateInput: CommandDefinition | KeybindingConflictCandidate,
  commandInputs: readonly (CommandDefinition | KeybindingConflictCandidate)[],
): KeybindingConflict[] {
  const candidate = toCandidate(candidateInput)
  const candidateKeys = candidate.keybindings
    .map((keybinding) => normalizeKeybinding(keybinding))
    .filter((keybinding): keybinding is string => Boolean(keybinding))
  const conflicts: KeybindingConflict[] = []

  for (const commandInput of commandInputs) {
    const command = toCandidate(commandInput)
    if (command.commandId === candidate.commandId) continue
    const commandKeys = command.keybindings
      .map((keybinding) => normalizeKeybinding(keybinding))
      .filter((keybinding): keybinding is string => Boolean(keybinding))
    for (const keybinding of candidateKeys) {
      if (!commandKeys.includes(keybinding)) continue
      if (scopesOverlap(candidate.scopes, command.scopes)) {
        conflicts.push({
          severity: 'blocking',
          keybinding,
          conflictingCommandId: command.commandId,
          conflictingCommandTitle: command.commandTitle ?? command.commandId,
          reason: 'same-scope keybinding conflict',
        })
      } else if (scopesAreMutuallyExclusive(candidate.scopes, command.scopes)) {
        conflicts.push({
          severity: 'warning',
          keybinding,
          conflictingCommandId: command.commandId,
          conflictingCommandTitle: command.commandTitle ?? command.commandId,
          reason: 'same keys in mutually exclusive scopes',
        })
      }
    }
  }

  return conflicts
}

export function hasBlockingKeybindingConflict(conflicts: readonly KeybindingConflict[]): boolean {
  return conflicts.some((conflict) => conflict.severity === 'blocking')
}
