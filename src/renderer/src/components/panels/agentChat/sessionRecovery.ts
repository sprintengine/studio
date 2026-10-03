import { CONVERSATION_SESSION_NOT_FOUND } from '../../../../../shared/conversation-runtime'

// A chat view keeps its session's id for as long as it is mounted, but the
// session can go while the view holds it: the server that held it restarted
// (a WSL distribution's, an SSH machine's, the desktop's own out of process)
// while the window stayed open, or the chat started another elsewhere. Its
// runtime then names the session as not found. The view does what it does
// after the whole app restarts: it starts the chat's session again, which
// resumes it from its transcript, and the send goes out on that one.

type ActionResult = { ok: true } | { ok: false; message: string; code?: string }

/** Whether a refusal says the session the view holds is gone. */
export function sessionWasLost(result: { ok: boolean; code?: unknown }): boolean {
  return !result.ok && result.code === CONVERSATION_SESSION_NOT_FOUND
}

/**
 * Send on `sessionId`; when its runtime no longer holds it, start the chat's
 * session again (`restart`) and send once more on that one. A restart that
 * fails answers with its own words, which say more than the lost session's.
 */
export async function sendRecoveringSession<R extends ActionResult>(input: {
  sessionId: string
  send(sessionId: string): Promise<R>
  restart(): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>
}): Promise<R | { ok: false; message: string }> {
  const first = await input.send(input.sessionId)
  if (!sessionWasLost(first)) return first
  const restarted = await input.restart()
  if (!restarted.ok) return { ok: false, message: restarted.message }
  return input.send(restarted.sessionId)
}
