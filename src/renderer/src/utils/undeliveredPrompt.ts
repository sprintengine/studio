import type { TerminalPromptUndelivered } from '../../../shared/electron-api'
import type { DiagnosticLogEntry } from '../types/workspace'

// A first message main could not type into its agent CLI
// (src/main/deferred-prompt-delivery.ts), turned into what the person sees: a
// toast saying so, and a bell row that keeps the message and gives it back.
//
// The row is added to the bell directly instead of going through
// `publishDiagnostic`, because that also writes the entry to the diagnostics
// log on disk, and the entry carries the person's message. Main already logged
// that it happened, without the text.

export type UndeliveredPromptNotice = {
  title: string
  message: string
  /** The toast's line: where the message went. */
  toastDescription: string
}

/** Why nothing was typed, in a sentence about the CLI. */
function reasonSentence(event: TerminalPromptUndelivered, cliName: string): string {
  switch (event.reason) {
    case 'exited':
      return `${cliName} exited before it was ready for input, so nothing was typed into it.`
    case 'not-ready':
      return `${cliName} did not show its message box in time, so nothing was typed into it.`
    case 'write-failed':
      return `The terminal stopped taking input before your message could be typed into ${cliName}.`
  }
}

export function undeliveredPromptNotice(
  event: TerminalPromptUndelivered,
  cliDisplayName: (cli: string) => string,
): UndeliveredPromptNotice {
  const cliName = event.cli ? cliDisplayName(event.cli) : 'The agent'
  const who = event.agentName?.trim() || cliName
  return {
    title: `${who} did not get your first message`,
    message: `${reasonSentence(event, cliName)} Copy message puts it on the clipboard.`,
    toastDescription: 'Your message is kept in Notifications, where Copy message gives it back.',
  }
}

/** The bell row for an undelivered first message, carrying the message itself. */
export function undeliveredPromptEntry(
  event: TerminalPromptUndelivered,
  notice: UndeliveredPromptNotice,
  now: Date = new Date(),
  id: string = crypto.randomUUID(),
): DiagnosticLogEntry {
  return {
    id,
    timestamp: now.toISOString(),
    level: 'error',
    source: 'terminal',
    title: notice.title,
    message: notice.message,
    returnedPrompt: event.text,
    sessionId: event.sessionId,
    ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
  }
}
