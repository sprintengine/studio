import { conversationClis } from './conversation-harness'
import { isWslHostId, type ExecutionHostId, type ExecutionHostSettings } from './execution-host'

type CliRuntime = { command?: string; hostId?: ExecutionHostId }

/**
 * The CLI runtimes a chat in a workspace runs with. A workspace on a WSL
 * machine runs every chat CLI from that machine (its command override there,
 * and the host id that sends the child into the distribution), the way a
 * terminal agent there does; on this machine they are the app's own. Shared
 * because a window starts most chats and main starts the rest (a scheduled
 * agent's run, a module's create), and the two must send a chat to the same
 * machine.
 */
export function conversationCliRuntimesForHost<T extends CliRuntime>(
  cliRuntimes: Partial<Record<string, Partial<T>>> | undefined,
  hostId: ExecutionHostId | null | undefined,
  hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>> | undefined,
): Partial<Record<string, Partial<T>>> | undefined {
  if (!hostId || !isWslHostId(hostId)) return cliRuntimes
  const onHost: Partial<Record<string, Partial<T>>> = { ...cliRuntimes }
  for (const cli of conversationClis()) {
    onHost[cli] = {
      ...cliRuntimes?.[cli],
      // This machine's command means nothing there: an empty one is found on
      // the distribution's own PATH.
      command: hosts?.[hostId]?.cliCommands[cli] ?? '',
      hostId,
    } as Partial<T>
  }
  return onHost
}
