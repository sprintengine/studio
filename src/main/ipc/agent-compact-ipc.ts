import type { IpcMain } from 'electron'

import { terminalCompactBlocker, type CompactableTerminal } from '../../shared/prompt-cache'

/**
 * Compact a terminal agent's conversation: type `/compact` at its prompt and
 * submit it, through the agent control plane (paste, then a separate Enter).
 * Offered when its prompt cache is about to expire or already has, so the
 * next message re-sends a summary instead of the whole conversation.
 *
 * Main enforces the same rule the button is shown by (terminalCompactBlocker)
 * against the session as main sees it at the moment of typing, not as the
 * renderer last saw it: the agent could have started a turn, or the person
 * typed at its prompt, in between.
 */
export type AgentCompactIpcDependencies = {
  findTerminal(sessionId: string): CompactableTerminal | null
  /** Type `text` and submit it, once `precondition` (checked in the session's queue, right before typing) allows. */
  sendPrompt(
    sessionId: string,
    text: string,
    precondition: () => string | null,
  ): Promise<{ ok: true } | { ok: false; message: string }>
}

export type AgentCompactResult = { ok: true } | { ok: false; message: string }

/** Cap on an id off the wire. Session ids are uuid-shaped; this is an abuse guard. */
const MAX_ID_LENGTH = 512

export function registerAgentCompactIpc(ipcMain: IpcMain, deps: AgentCompactIpcDependencies): void {
  ipcMain.handle('agent:compact', (_event, sessionId: unknown) => compactTerminalAgent(deps, sessionId))
}

export async function compactTerminalAgent(
  deps: AgentCompactIpcDependencies,
  sessionId: unknown,
): Promise<AgentCompactResult> {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_ID_LENGTH || sessionId.includes('\0')) {
    return { ok: false, message: 'No agent session to compact.' }
  }
  // Checked now, for a prompt answer, and again inside the queue right before
  // typing: another send queued for the session ahead of this one can leave
  // the agent working, or the prompt holding text, by the time it is typed.
  const blockerNow = (): string | null => {
    const session = deps.findTerminal(sessionId)
    return session ? terminalCompactBlocker(session) : 'The agent session is gone.'
  }
  const blocker = blockerNow()
  if (blocker) return { ok: false, message: blocker }
  return deps.sendPrompt(sessionId, '/compact', blockerNow)
}
