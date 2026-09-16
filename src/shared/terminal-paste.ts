/**
 * Bracketed-paste framing for text written into a PTY.
 *
 * A prompt pushed at an agent CLI has to arrive as one paste, not as a stream
 * of keystrokes: without the brackets a multi-line prompt submits on its first
 * newline and the rest lands in the next turn. CRLF is normalised to LF for the
 * same reason — a stray carriage return reads as a second submit.
 */
export function bracketedTerminalPaste(text: string): string {
  return `\x1b[200~${text.replace(/\r?\n/g, '\n')}\x1b[201~`
}
