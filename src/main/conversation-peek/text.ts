import { basename, isAbsolute, resolve } from 'node:path'

import { INJECTED_FRAGMENT_PATTERNS } from '../../shared/workspace-title'

/**
 * Turn what a person actually typed into the sentence a hover card can quote.
 *
 * The card quotes ONE message in full and one line of every message after it,
 * so the text it is handed has to already be the sentence — not the sentence
 * plus the 400-line file they pasted under it, not the sentence plus the four
 * repo paths they dropped onto the terminal. Collapsing happens BEFORE the
 * character cap for exactly that reason: capping first would spend the whole
 * budget on a fenced block and truncate away the request itself, and the card
 * would then honestly report "+3,900 more" about text nobody typed.
 *
 * The path-shaped tokens are not merely deleted, they are PROMOTED: a dropped
 * file is a thing the person attached, so it leaves the quoted sentence and
 * arrives as a chip you can click. That is the whole difference between this
 * module and `stripInjectedFragments`, whose consumer (the derived title) has
 * nowhere to put them and so throws them away. Both read the same patterns
 * (`INJECTED_FRAGMENT_PATTERNS`) so the two routes cannot disagree about what
 * counts as a path.
 *
 * Pure: no I/O, no Electron, no DOM. Every input is untrusted — the text comes
 * from a CLI's own transcript file, written by another process.
 */

/**
 * Where a collapsed path token came from, kept so the caller can resolve a
 * relative one against the cwd the transcript row recorded rather than against
 * whatever directory the app happens to be running in.
 */
export type PeekPathToken = {
  /** Exactly as it appeared, minus a leading `@`. */
  raw: string
  /** Basename, which is what the chip shows. */
  label: string
}

export type CollapsedPeekText = {
  /** The sentence, whitespace-normalised, uncapped. */
  text: string
  /** Path-shaped tokens lifted out of it, in the order they appeared, deduped. */
  paths: PeekPathToken[]
  /**
   * Characters dropped before collapsing even started, because the input was
   * past {@link MAX_COLLAPSE_INPUT_CHARS}. The caller adds these to the
   * message's `truncatedChars`, so a card that says "+40,000 more" is counting
   * everything it did not show rather than only the tail the cap ate.
   */
  overflowChars: number
}

/**
 * Placeholders Claude Code substitutes for a pasted image inside the person's
 * own text (`[Image #26] What happened? You removed the backdrops.`) and the
 * companion line it writes for a dropped screenshot. Both name an image that
 * already arrives as its own content block, so leaving them in would make the
 * card quote its own attachment strip back at the reader.
 */
const IMAGE_PLACEHOLDER_PATTERN = /\[Image(?:\s*#\d+|:[^\]\n]{0,200})\]/g

/**
 * Wrappers the CLI puts around something that is not a person speaking:
 * a slash-command invocation, a background task report, the transcript-only
 * echo of a `!` bash line. A row whose text STARTS with one of these is not a
 * message (see `isTranscriptCommandInvocation`); one that merely contains it
 * has the fragment removed.
 */
const INJECTED_TAG_PATTERN =
  /<\/?(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|task-id|tool-use-id|output-file|status|summary)>/gi

/**
 * A line that is only a path is a drop, not a sentence. Recognised separately
 * from the inline patterns because a bare `design-system/` on its own line has
 * no leading whitespace for `explicitPath`/`barePath` to anchor on.
 */
const WHOLE_LINE_PATH_PATTERN = /^\s*(@?~?\.{0,2}\/?[\w.@+-]+(?:\/[\w.@+-]*)+)\s*$/

/** Longest token still treated as a path. Past this it is a paste, not a filename. */
const MAX_PATH_TOKEN_LENGTH = 512

/**
 * Path tokens lifted per message. Well above the attachment cap the card
 * renders, so the caller — not this module — decides where the "+2" starts.
 */
const MAX_PATH_TOKENS = 32

/**
 * Longest text collapsed in full. Two orders of magnitude above the longest
 * message anyone types, and there so a person who pasted five megabytes into a
 * prompt cannot make a hover run several regexes over all of it. Past this the
 * head is collapsed and the rest is counted, which is the same answer the cap
 * would have reached anyway — only without the work.
 */
export const MAX_COLLAPSE_INPUT_CHARS = 128 * 1024

/**
 * True when this text is the CLI's own record of a command being invoked rather
 * than a person's message: `<command-name>/compact</command-name>`, or the bare
 * `/compact` older Claude Code wrote. A slash command WITH an argument is kept —
 * "/backlog work MC-2455" is a request, and the peek exists to show requests.
 */
export function isTranscriptCommandInvocation(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('<')) {
    // Anything opening with one of the CLI's own wrappers is machinery. An
    // unrecognised tag is left alone: a person may well open a message with
    // `<div>`, and guessing would silently eat it.
    INJECTED_TAG_PATTERN.lastIndex = 0
    return INJECTED_TAG_PATTERN.test(trimmed.slice(0, 64))
  }
  return /^\/[a-z0-9][a-z0-9._-]*$/i.test(trimmed)
}

/**
 * The sentence inside `input`, with fenced blocks, injected wrappers and image
 * placeholders removed and path-shaped tokens promoted out into `paths`.
 */
export function collapsePeekText(input: string): CollapsedPeekText {
  const overflowChars = Math.max(0, input.length - MAX_COLLAPSE_INPUT_CHARS)
  const raw = overflowChars > 0 ? input.slice(0, MAX_COLLAPSE_INPUT_CHARS) : input
  const paths: PeekPathToken[] = []
  const seen = new Set<string>()
  /**
   * Promote `token` to an attachment, or leave `fallback` in place when it is
   * not actually a path. The decision is made on the CLEANED token, so
   * "src/main/app.ts," is recognised and its comma is not what disqualifies it.
   *
   * A promoted token leaves its LABEL behind in the sentence, not a hole. This
   * is the marquee element of the surface — the card quotes the first message in
   * full — and deleting the token mid-clause corrupts what the person wrote:
   * "attached at `design-system/`; read `USAGE.md` + `foundations/tokens.css`"
   * became "attached at ; read USAGE.md + +", which reads as though the app
   * damaged the message. The basename says the same thing in less room, and the
   * chip underneath still carries the action.
   *
   * `mode: 'drop'` is for a token that is a whole line on its own — a dropped
   * file, not a word in a sentence. There is no clause to keep readable there,
   * and a stray basename on its own line is noise the chip already covers.
   */
  const take = (token: string, fallback: string, mode: 'label' | 'drop' = 'label'): string => {
    const cleaned = normalisePathToken(token)
    if (!cleaned || !looksLikePath(cleaned)) return fallback
    const label = basename(cleaned.replace(/\/+$/, '')) || cleaned
    if (!seen.has(cleaned) && paths.length < MAX_PATH_TOKENS) {
      seen.add(cleaned)
      paths.push({ raw: cleaned, label })
    }
    return mode === 'drop' ? ' ' : ` ${label} `
  }

  const patterns = INJECTED_FRAGMENT_PATTERNS
  const withoutBulk = raw
    // Order matters: fences first, so a path INSIDE a pasted diff never becomes
    // a chip the person never attached.
    .replace(patterns.fencedBlock, ' ')
    .replace(INJECTED_TAG_PATTERN, ' ')
    .replace(IMAGE_PLACEHOLDER_PATTERN, ' ')

  const lines = withoutBulk.split('\n').map((line) => {
    const wholeLine = WHOLE_LINE_PATH_PATTERN.exec(line)
    if (wholeLine?.[1]) return take(wholeLine[1], line, 'drop')
    return line
      // Inline code is where a dropped path most often lands ("read `USAGE.md`"),
      // so its contents are inspected rather than deleted wholesale: a path is
      // promoted, and anything else keeps its place in the sentence unquoted.
      .replace(patterns.inlineCode, (match) => {
        const inner = match.slice(1, -1).trim()
        return take(inner, ` ${inner} `)
      })
      .replace(patterns.mention, (match) => take(match.trim().slice(1), match))
      .replace(patterns.explicitPath, (match) => take(match.trim(), match))
      .replace(patterns.barePath, (match) => take(match.trim(), match))
  })

  const text = lines
    .join('\n')
    // Runs of blank lines collapse to one: a card is a few lines tall, and the
    // vertical space a pasted layout leaves behind is space the sentence needs.
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n[ \t]*(?:\n[ \t]*)+/g, '\n\n')
    // Every substitution above pads with a space, which strands the punctuation
    // that followed the token ("design-system ;"). Reunite it — the whole point
    // of substituting a label was that the sentence still reads.
    .replace(/[ \t]+([,.;:!?)\]}])/g, '$1')
    .replace(/([([{]) +/g, '$1')
    .trim()

  return { text, paths, overflowChars }
}

/**
 * `text` cut to `maxChars`, plus how much was cut. The ellipsis is deliberately
 * NOT added here: the renderer draws the "…" and the remainder count together,
 * and a main-side ellipsis would either double up or lie about the count by one.
 */
export function capPeekText(text: string, maxChars: number): { text: string; truncatedChars: number } {
  if (text.length <= maxChars) return { text, truncatedChars: 0 }
  // Break on a word boundary when one is close, so the quote does not end
  // mid-identifier; fall back to the hard cut when the tail is one long token.
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  const kept = (lastSpace > maxChars - 24 ? cut.slice(0, lastSpace) : cut).trimEnd()
  return { text: kept, truncatedChars: text.length - kept.length }
}

/**
 * The absolute path a chip should open, or null when the token cannot be turned
 * into one. `cwd` is the working directory the transcript row recorded, so a
 * repo-relative drop resolves against the session that made it and not against
 * the app's own process directory.
 *
 * `~` is expanded only when `home` is known; the result is never checked for
 * existence here, because a peek must not stat a file per hover — the open
 * action finds out, and reports it there.
 */
export function resolvePeekPath(token: string, cwd: string | null, home: string | null): string | null {
  if (!token || token.includes('\0')) return null
  let candidate = token.replace(/\/+$/, '')
  if (!candidate) return null
  if (candidate === '~' || candidate.startsWith('~/')) {
    if (!home) return null
    candidate = candidate === '~' ? home : resolve(home, candidate.slice(2))
  }
  if (isAbsolute(candidate)) return candidate
  if (!cwd || !isAbsolute(cwd)) return null
  return resolve(cwd, candidate)
}

/**
 * Whether a token pulled out of inline code or an @-mention is path-shaped
 * enough to become a chip. Stricter than the strip patterns on purpose: a
 * title that eats "and/or" loses two words, whereas a card that shows "or" as
 * a file the person attached is telling the reader something untrue.
 */
function looksLikePath(token: string): boolean {
  if (!token || token.length > MAX_PATH_TOKEN_LENGTH || /\s/.test(token)) return false
  if (isUrlFragment(token)) return false
  if (/^[~.]{0,2}\//.test(token)) return true
  if (!token.includes('/')) return false
  // A bare token needs a file-ish tail or a trailing slash to count: "src/main"
  // is ambiguous prose, "src/main/app.ts" and "design-system/" are not.
  return /\.[A-Za-z0-9]{1,12}$/.test(token) || token.endsWith('/')
}

function isUrlFragment(token: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(token.trim())
}

function normalisePathToken(token: string): string | null {
  const cleaned = token.trim().replace(/^@/, '').replace(/[),.;:'"]+$/, '')
  if (!cleaned || cleaned.length > MAX_PATH_TOKEN_LENGTH || cleaned.includes('\0')) return null
  return cleaned
}
