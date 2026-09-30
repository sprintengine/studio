import { isWslHostId, type ExecutionHostId, type ExecutionHostSettings } from './execution-host'

// The one CLI whose chats run inside a WSL distribution: its chat provider
// starts the CLI as a child process, and the host id sends that child into the
// distribution. Every other chat runtime starts its CLI on this machine.
const WSL_CHAT_CLI = 'claude-code'

type CliRuntime = { command?: string; hostId?: ExecutionHostId }

/**
 * The CLI runtimes a chat in a workspace runs with. A workspace on a WSL
 * machine runs its Claude chat with that machine's `claude` (its command
 * override there, and the host id that sends the child into the distribution);
 * every other runtime is the app's own. Shared because a window starts most
 * chats and main starts the rest (a scheduled agent's run, a module's create),
 * and the two must send a chat to the same machine.
 */
export function conversationCliRuntimesForHost<T extends CliRuntime>(
  cliRuntimes: Partial<Record<string, Partial<T>>> | undefined,
  hostId: ExecutionHostId | null | undefined,
  hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>> | undefined,
): Partial<Record<string, Partial<T>>> | undefined {
  if (!hostId || !isWslHostId(hostId)) return cliRuntimes
  return {
    ...cliRuntimes,
    [WSL_CHAT_CLI]: {
      ...cliRuntimes?.[WSL_CHAT_CLI],
      command: hosts?.[hostId]?.cliCommands[WSL_CHAT_CLI] ?? '',
      hostId,
    } as Partial<T>,
  }
}
