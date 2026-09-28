/**
 * A slash command the chat composer can offer. The list for a chat is what its
 * CLI reports it will run in that folder — the chat never expands a command
 * file itself, so a command that is listed and one that works stay the same
 * set. The composer inserts `/name ` as plain text and the CLI does the rest,
 * except for the commands the app runs itself (`source: 'app'`).
 */
export type ConversationCommand = {
  /** Without the leading slash, e.g. `compact`, `review`, `acme:deploy`. */
  name: string
  description?: string
  /** What the command expects after it, e.g. `[pr-number]`. */
  argumentHint?: string
  aliases?: string[]
  /**
   * What choosing it puts in the composer when that is not `/name ` — Codex
   * takes its skills as `$name ` mentions, not slash commands.
   */
  insertText?: string
  /**
   * Where it comes from, for grouping and the row's secondary label:
   * `app` — handled by Studio before anything is sent (e.g. `model`);
   * `cli` — built into the agent CLI;
   * `custom` — the user's or a plugin's command the CLI loaded;
   * `skill` — a skill the CLI exposes as a command.
   */
  source: 'app' | 'cli' | 'custom' | 'skill'
}

/** The command list for one CLI in one folder. */
export type ConversationCommandCatalog = {
  cli: string
  cwd: string
  commands: ConversationCommand[]
  /** Epoch ms of the answer this list came from; 0 when nothing has answered yet. */
  fetchedAt: number
  /** Set when the last attempt to list failed; `commands` then holds the last good list. */
  error?: string
}

/**
 * The spelling a command list is kept under for a folder, so the list a
 * runtime publishes for its session's folder is the one the composer asks for
 * whatever small differences the two spellings carry: a trailing separator,
 * doubled separators, `.` segments, and on a Windows path the drive's case and
 * the direction of its slashes (the file system ignores both). Main keys its
 * registry and disk cache by it and the renderer its cache, so a catalog's
 * `cwd` as published and the folder a chat asks with meet on the same key.
 *
 * Lexical only: symlinks are not resolved, because every publisher and the
 * composer take the folder from the same place (the workspace's folder, handed
 * to the session when it starts) and never from what a CLI reports back.
 */
export function conversationCommandsFolderKey(cwd: string): string {
  const unc = cwd.startsWith('\\\\')
  const windows = unc || /^[A-Za-z]:[\\/]/.test(cwd)
  let path = windows ? cwd.replace(/\\/g, '/') : cwd
  const lead = unc ? '//' : path.startsWith('/') ? '/' : ''
  const segments = path.split('/').filter((segment) => segment && segment !== '.')
  path = lead + segments.join('/')
  if (windows && !unc && segments.length === 1) path += '/'
  if (!path) path = cwd
  return windows ? path.toLowerCase() : path
}
