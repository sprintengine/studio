import { getCommandDefinition } from './commandRegistry'
import type { CommandAvailability, CommandDefinition, CommandScope, ModuleCommandContext } from './types'

/**
 * Runtime truth for each availability precondition a command can declare. The
 * keyboard dispatcher and the command palette both read this single context, so
 * a panel command is offered in exactly the situations it will actually run:
 * the palette never shows a row the shortcut path would refuse, and a shortcut
 * never fires a command the palette would hide.
 */
export type CommandAvailabilityContext = Partial<Record<CommandAvailability, boolean>>

/**
 * True when every availability precondition a command declares is satisfied.
 * Commands with no preconditions (or the `always` sentinel) are always
 * available. Conditions are ANDed — a command that names two conditions needs
 * both.
 */
export function isCommandAvailable(
  command: Pick<CommandDefinition, 'availability' | 'availabilityPredicate'>,
  context: CommandAvailabilityContext,
  moduleContext?: ModuleCommandContext,
): boolean {
  // Module predicate commands: evaluated against the published context view.
  // No context (early boot, a caller that never wires one) means unavailable —
  // fail closed rather than firing a command its module cannot gate.
  if (command.availabilityPredicate) {
    if (!moduleContext) return false
    // Third-party code: a throwing predicate fails closed instead of
    // unwinding the palette render or the keyboard dispatcher.
    try {
      return command.availabilityPredicate(moduleContext) === true
    } catch (error) {
      console.error('[modules] command availability predicate threw:', error)
      return false
    }
  }
  const conditions = command.availability
  if (!conditions || conditions.length === 0) return true
  return conditions.every((condition) => condition === 'always' || context[condition] === true)
}

/**
 * True when one of the command's declared scopes is currently active. Panel
 * commands carry a single `panel:*` scope, so scope membership is the same gate
 * the dispatcher applies before a keybinding can match.
 */
export function isCommandInScope(
  command: Pick<CommandDefinition, 'scopes'>,
  activeScopes: readonly CommandScope[],
): boolean {
  return command.scopes.some((scope) => activeScopes.includes(scope))
}

/**
 * Single predicate shared by the palette and the dispatcher: a command is
 * offered only when its scope is active and its preconditions are met.
 */
export function isCommandEnabled(
  command: Pick<CommandDefinition, 'scopes' | 'availability' | 'availabilityPredicate'>,
  activeScopes: readonly CommandScope[],
  context: CommandAvailabilityContext,
  moduleContext?: ModuleCommandContext,
): boolean {
  return isCommandInScope(command, activeScopes) && isCommandAvailable(command, context, moduleContext)
}

/**
 * Resolve a command id to its registry definition and evaluate availability.
 * Unknown ids are unavailable so a stale palette row id cannot surface a
 * command the registry no longer backs.
 */
export function isCommandIdEnabled(
  commandId: string,
  activeScopes: readonly CommandScope[],
  context: CommandAvailabilityContext,
  moduleContext?: ModuleCommandContext,
): boolean {
  const command = getCommandDefinition(commandId)
  return command ? isCommandEnabled(command, activeScopes, context, moduleContext) : false
}
