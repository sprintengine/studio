import { getCommandDefinition } from './commandRegistry'
import type { CommandAvailability, CommandDefinition, CommandScope } from './types'

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
 * available. Conditions are ANDed — `sprintengine.verify.progress` needs both a
 * Sprint Engine workspace and an architect on the roster.
 */
export function isCommandAvailable(
  command: Pick<CommandDefinition, 'availability'>,
  context: CommandAvailabilityContext,
): boolean {
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
  command: Pick<CommandDefinition, 'scopes' | 'availability'>,
  activeScopes: readonly CommandScope[],
  context: CommandAvailabilityContext,
): boolean {
  return isCommandInScope(command, activeScopes) && isCommandAvailable(command, context)
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
): boolean {
  const command = getCommandDefinition(commandId)
  return command ? isCommandEnabled(command, activeScopes, context) : false
}
