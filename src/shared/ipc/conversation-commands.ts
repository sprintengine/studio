// The IPC contract for a chat composer's slash-command list: the renderer asks
// for the list of one CLI in one folder, and main pushes every list it hears
// afterwards (a probe, a live session's init, an ACP update) to every window.
// The lists themselves are kept in main (src/main/conversation-commands).
export const CONVERSATION_COMMANDS_LIST_CHANNEL = 'conversation-commands:list'
export const CONVERSATION_COMMANDS_CHANGED_CHANNEL = 'conversation-commands:changed'

export type ConversationCommandsRequest = {
  /** The chat CLI id ('claude-code', 'codex', …). */
  cli: string
  /** The chat's working folder, as the runtime sees it. */
  cwd: string
  /** Ask the CLI again even when the list is fresh. */
  refresh?: boolean
  /**
   * `false` answers with what main already holds and never asks the CLI: a
   * chat reads this as it mounts, so opening many chats at launch starts no
   * CLI process. The ask itself waits for the person to open the `/` menu.
   */
  probe?: false
}
