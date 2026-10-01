import {
  conversationCommandsFolderKey,
  type ConversationCommand,
  type ConversationCommandCatalog,
} from '../../shared/conversation/commands'

// The command list each chat CLI last reported, per folder. Adapters publish
// here whenever their CLI tells them (a live session's init, an ACP
// `available_commands_update`, a probe); the IPC layer reads and relays it.
// A list is kept per folder because project commands and skills differ by
// folder, and the same CLI can be open in several at once.
const catalogs = new Map<string, ConversationCommandCatalog>()
const listeners = new Set<(catalog: ConversationCommandCatalog) => void>()

// Keyed by the folder's normalised spelling, which the renderer keys by too.
const keyOf = (cli: string, cwd: string) => `${cli}\u0000${conversationCommandsFolderKey(cwd)}`

export function publishConversationCommands(input: {
  cli: string
  cwd: string
  commands: ConversationCommand[]
  error?: string
  /**
   * When the list was answered, for one restored from an earlier run's cache;
   * now when absent. An old list published as new would read as fresh and
   * never be asked for again. 0 publishes a stand-in that is shown but still
   * counts as unanswered, so it is asked for and never cached.
   */
  fetchedAt?: number
}): void {
  const previous = catalogs.get(keyOf(input.cli, input.cwd))
  const catalog: ConversationCommandCatalog = input.error
    ? {
        cli: input.cli,
        cwd: input.cwd,
        commands: previous?.commands ?? [],
        fetchedAt: previous?.fetchedAt ?? 0,
        error: input.error,
      }
    : { cli: input.cli, cwd: input.cwd, commands: input.commands, fetchedAt: input.fetchedAt ?? Date.now() }
  catalogs.set(keyOf(input.cli, input.cwd), catalog)
  for (const listener of listeners) listener(catalog)
}

/**
 * A live session reported the list already held, unchanged: it is as fresh as
 * that report, so the next ask does not probe for it again. Nothing is told,
 * since nothing a listener shows or stores has changed; a list with an error,
 * or none, is left for a real report.
 */
export function touchConversationCommands(cli: string, cwd: string, at = Date.now()): void {
  const known = catalogs.get(keyOf(cli, cwd))
  if (!known || known.error || known.fetchedAt <= 0) return
  catalogs.set(keyOf(cli, cwd), { ...known, fetchedAt: Math.max(known.fetchedAt, at) })
}

export function conversationCommandsFor(cli: string, cwd: string): ConversationCommandCatalog {
  return catalogs.get(keyOf(cli, cwd)) ?? { cli, cwd, commands: [], fetchedAt: 0 }
}

export function onConversationCommandsChanged(listener: (catalog: ConversationCommandCatalog) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
