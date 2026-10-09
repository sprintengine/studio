// What the CLI-update toast says while the update runs: the newest line the
// updater has printed, so "Updating Codex…" is not the only thing on screen
// for the minute an npm install can take, and a stalled or failing update says
// where it stopped.

import { ansiPlainText } from '../../../../../shared/conversation/ansi'

/** A toast line, not a log: anything longer is cut, and the full log is in Settings. */
export const CLI_UPDATE_PROGRESS_MAX_CHARS = 120

// Text after the last line break or carriage return is held until one
// arrives. A program that prints megabytes without either is not printing
// lines, so the hold is bounded rather than trusted.
const MAX_HELD_CHARS = 4096

/**
 * One segment of output (between line breaks and carriage returns) as the
 * toast shows it: escapes gone, runs of whitespace one space, cut to the toast's
 * length. Empty when the segment printed nothing visible.
 */
function segmentText(segment: string, maxChars: number): string {
  const text = ansiPlainText(segment).replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text
}

export type CliOutputLatestLineReader = {
  /** Reads a streamed chunk and returns the newest non-empty line so far. */
  push: (chunk: string) => string
  /** The newest non-empty line so far, without reading anything. */
  latest: () => string
}

/**
 * Follows an updater's streamed output and keeps the newest line worth
 * showing.
 *
 * A carriage return is how a progress bar or spinner redraws its line, so the
 * text after the last one is what the line says now; one that redraws to
 * nothing (a bar clearing itself) leaves the last thing it did say standing,
 * as does a blank line. Chunks may split a line, or an escape inside one,
 * anywhere: the unfinished tail is held and read again with what follows.
 */
export function createCliOutputLatestLineReader(
  maxChars: number = CLI_UPDATE_PROGRESS_MAX_CHARS,
): CliOutputLatestLineReader {
  // The text after the last \r or \n — still being written.
  let held = ''
  // The newest non-empty segment of the line being written, before its last \r.
  let currentLine = ''
  // The newest non-empty line a \n has finished.
  let finishedLine = ''

  const latest = (): string => segmentText(held, maxChars) || currentLine || finishedLine

  const push = (chunk: string): string => {
    held += chunk
    let start = 0
    for (const match of held.matchAll(/[\r\n]/g)) {
      const text = segmentText(held.slice(start, match.index), maxChars)
      if (text) currentLine = text
      if (match[0] === '\n') {
        if (currentLine) finishedLine = currentLine
        currentLine = ''
      }
      start = match.index + 1
    }
    held = held.slice(start)
    if (held.length > MAX_HELD_CHARS) held = held.slice(-MAX_HELD_CHARS)
    return latest()
  }

  return { push, latest }
}

/**
 * A failure's description with the updater's last line after it, so the toast
 * that says the update did not finish also says where it stopped. Left as it
 * is when there is no line, when the line is only the command's own banner
 * (`$ npm install …`, which says what ran rather than what happened), or when
 * the description already quotes it — main's own failure text carries the
 * command's last lines.
 */
export function withLastOutputLine(description: string, lastLine: string): string {
  if (!lastLine || lastLine.startsWith('$ ') || description.includes(lastLine.replace(/…$/, ''))) return description
  const sentence = /[.!?…:]$/.test(description) ? description : `${description}.`
  return `${sentence} Last output: ${lastLine}`
}
