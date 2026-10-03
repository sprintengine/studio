import { CONVERSATION_SESSION_NOT_FOUND } from '../../../../../shared/conversation-runtime'

// A chat view keeps its session's id for as long as it is mounted, but the
// session can go while the view holds it: the server that held it restarted
// (a WSL distribution's, an SSH machine's, the desktop's own out of process)
// while the window stayed open, or the chat started another elsewhere. Its
// runtime then names the session as not found. The view does what it does
// after the whole app restarts: it starts the chat's session again, which
// resumes it from its transcript, and the send goes out on that one.

type ActionResult = { ok: true } | { ok: false; message: string; code?: string }

// What a runtime from before the refusal carried a code (an SSH machine's
// server of an older build) says about a session it does not hold, and only
// about one: every other refusal has words of its own.
const LOST_SESSION_WORDS = 'Conversation session is invalid.'

/**
 * What an approval or an answer to a lost session is told: nothing waits for
 * it any more, and the next message starts the chat again.
 */
export const LOST_REQUEST =
  'This request ended with the session it belonged to (the server running the chat restarted). Send a message to carry on.'

/** Whether a refusal says the session the view holds is gone. */
export function sessionWasLost(result: { ok: boolean; code?: unknown; message?: unknown }): boolean {
  if (result.ok) return false
  if (result.code !== undefined) return result.code === CONVERSATION_SESSION_NOT_FOUND
  return result.message === LOST_SESSION_WORDS
}

/**
 * Send on `sessionId`; when its runtime no longer holds it, start the chat's
 * session again (`restart`) and send once more on that one. A restart that
 * fails answers with its own words, which say more than the lost session's;
 * where the view cannot start a session (`null`), the refusal stands.
 */
export async function sendRecoveringSession<R extends ActionResult>(input: {
  sessionId: string
  send(sessionId: string): Promise<R>
  restart(): Promise<{ ok: true; sessionId: string } | { ok: false; message: string } | null>
}): Promise<R | { ok: false; message: string }> {
  const first = await input.send(input.sessionId)
  if (!sessionWasLost(first)) return first
  const restarted = await input.restart()
  if (!restarted) return first
  if (!restarted.ok) return { ok: false, message: restarted.message }
  return input.send(restarted.sessionId)
}
