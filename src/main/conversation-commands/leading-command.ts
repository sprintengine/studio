import type { ConversationCommand } from '../../shared/conversation/commands'
import { conversationCommandsFor } from './registry'

// The top-level folders a message is likely to open with when it is talking
// about a path rather than running a command: "/tmp is full", "/Users is on
// the other disk". Only consulted while no command list is known for the chat.
const PATH_ROOTS = new Set([
  'applications',
  'bin',
  'etc',
  'home',
  'library',
  'mnt',
  'opt',
  'private',
  'proc',
  'root',
  'sbin',
  'srv',
  'system',
  'tmp',
  'users',
  'usr',
  'var',
  'volumes',
])

/**
 * The slash command a message opens with — `review` for `/review HEAD~1` — or
 * null for prose. A path such as `/Users/dev/app` is not a command: a command
 * name never contains a second slash, and the CLI would not run it as one.
 *
 * A CLI runs a command only when the message starts with it and reads the rest
 * of the message as its arguments, so anything Studio adds to a turn has to
 * stay clear of a message this matches.
 *
 * `known` is the command list the chat's CLI reported for its folder. With
 * one, a name counts only when the list has it (by name or alias): the CLI
 * treats any other `/word` as prose too. Without one the name is judged by its
 * look, and a name with a dot in it (`/etc.conf`) or a top-level folder's name
 * (`/tmp is full`) reads as the path it is.
 */
export function leadingSlashCommand(message: string, known?: readonly ConversationCommand[] | null): string | null {
  const name = /^\/([^\s/]+)(?=\s|$)/.exec(message)?.[1] ?? null
  if (!name) return null
  if (known?.length)
    return known.some((command) => command.name === name || command.aliases?.includes(name)) ? name : null
  if (name.includes('.') || PATH_ROOTS.has(name.toLowerCase())) return null
  return name
}

/**
 * `leadingSlashCommand` against the list the chat's CLI last reported for its
 * folder, as the runtime and the adapters judge a message they are about to
 * send.
 */
export function leadingCommandFor(
  message: string,
  chat: { cli: string | null; cwd: string | null | undefined },
): string | null {
  const known = chat.cli && chat.cwd ? conversationCommandsFor(chat.cli, chat.cwd).commands : null
  return leadingSlashCommand(message, known)
}
