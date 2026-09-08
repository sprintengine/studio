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

// `panel:*` scopes form one open family that is USUALLY exclusive (module
// panel scopes derive from the single active workspace's mode), so same-key
// bindings across two panel scopes warn rather than block. They are not
// strictly exclusive — a module can push more than one panel scope, and
// feature contexts can ride foreign modes — in which co-active cases the
// dispatcher resolves the tie by registration order (shell first).
// Editor/terminal keep their fixed exclusive pair.
const MUTUALLY_EXCLUSIVE_SCOPE_GROUPS: readonly (readonly CommandScope[])[] = [
  ['editor', 'terminal'],
]

function isPanelScope(scope: CommandScope): boolean {
  return scope.startsWith('panel:')
}

function scopesOverlap(a: readonly CommandScope[], b: readonly CommandScope[]): boolean {
  return a.includes('global') || b.includes('global') || a.some((scope) => b.includes(scope))
}

function scopesAreMutuallyExclusive(a: readonly CommandScope[], b: readonly CommandScope[]): boolean {
  if (scopesOverlap(a, b)) return false
  if (a.some(isPanelScope) && b.some(isPanelScope)) return true
  return MUTUALLY_EXCLUSIVE_SCOPE_GROUPS.some((group) => (
    a.some((scope) => group.includes(scope)) && b.some((scope) => group.includes(scope))
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
