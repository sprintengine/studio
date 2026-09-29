import type { ConversationCliRuntimeOverrides } from '../../../../../shared/conversation-runtime'
import { LOCAL_HOST_ID } from '../../../../../shared/execution-host'
import { focusOrAddTerminalTab } from '../../../utils/modelRegistry'

/**
 * Opens a terminal tab in the chat's workspace that runs the chat CLI's own
 * sign-in, so a turn that failed on a lapsed login can be fixed where it
 * failed. The command and the machine are main's: the executable the
 * conversation provider runs, on the machine it runs there — a chat on a WSL
 * machine signs in inside that distribution, This PC's chat with the native
 * Claude Code. Interactive on purpose — the login opens a browser and may ask
 * for a code pasted back.
 */
export async function openCliSignInTerminal(input: {
  workspaceId: string
  providerId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
  now?: () => number
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const resolved = await window.api.conversationProviderSignIn({
    providerId: input.providerId,
    ...(input.cliRuntimes ? { cliRuntimes: input.cliRuntimes } : {}),
  })
  if (!resolved.ok) return resolved
  const terminalId = `sign-in-${(input.now ?? Date.now)()}`
  const sessionId = `terminal-${terminalId}`
  const spawned = await window.api.terminalSpawn(
    sessionId,
    100,
    30,
    resolved.cwd,
    false,
    undefined,
    undefined,
    undefined,
    true,
    { kind: 'terminal', workspaceId: input.workspaceId, terminalId, hostId: resolved.hostId ?? LOCAL_HOST_ID },
  )
  if (!spawned.ok) return { ok: false, message: spawned.message }
  await window.api.terminalWrite(sessionId, `${resolved.commandLine}\r`)
  focusOrAddTerminalTab(input.workspaceId, terminalId, 'Sign in')
  return { ok: true }
}
