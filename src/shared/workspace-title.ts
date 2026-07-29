/**
 * Derive a workspace title from the first prompt a user actually sent.
 *
 * A new chat opens as "Chat 44" and stays that way, so a sidebar of forty of
 * them says nothing about what any of them was for. This module turns the first
 * real prompt into a few words that do.
 *
 * The summariser is a LOCAL HEURISTIC by deliberate choice, not a model call:
 * it has to work for every CLI, offline, with no provider configured and no
 * per-chat API spend. The cost is quality — a rambling dictated prompt titles
 * worse than a model would. That trade is contained here: the capture pipeline,
 * the once-only freeze, and the tab hover all treat this as an opaque
 * `string | null`, so swapping in a model-backed summariser later replaces this
 * function and touches nothing else.
 *
 * Pure: no I/O, no Electron, no DOM. Imported by both main and renderer.
 */

/**
 * Hard cap on a derived title. Sized to the sidebar row, which truncates around
 * here anyway — a longer title buys no information, only an ellipsis.
 */
export const MAX_WORKSPACE_TITLE_LENGTH = 42

/** Word cap applied before the character cap. Titles read as labels, not lines. */
const MAX_TITLE_WORDS = 6

/**
 * Below this many characters the result is noise rather than a title (a bare
 * "yes", a stray token left after stripping), so it is rejected and the caller
 * waits for the next prompt.
 */
const MIN_TITLE_LENGTH = 3

/**
 * Openers that carry no topic. Stripped from the FRONT of the prompt, repeatedly
 * (dictated prompts stack them: "so right now basically I want you to ...").
 *
 * Ordered longest-first within the matcher below so "i want you to" wins over
 * "i" — a shorter alternative matching first would strip one word and strand the
 * rest of the filler in the title.
 */
const LEADING_FILLER = [
  'i was wondering if you could',
  'i was wondering whether you could',
  "i'd like you to",
  'id like you to',
  'i would like you to',
  'i want you to',
  'i need you to',
  'i want to',
  'i need to',
  'we need to',
  'we should',
  'you should',
  'can you please',
  'could you please',
  'would you please',
  'can you',
  'could you',
  'would you',
  'please can you',
  'help me',
  'lets',
  "let's",
  'right now',
  'at the moment',
  'currently',
  'basically',
  'actually',
  'essentially',
  'please',
  'hey there',
  'hey',
  'hi there',
  'hi',
  'hello',
  'ok so',
  'okay so',
  'ok',
  'okay',
  'so',
  'well',
  'um',
  'uh',
  'just',
]

// The trailing group also matches end-of-input, so a prompt that is NOTHING but
// filler ("please", "ok so") strips to empty and is rejected — rather than
// surviving as a title because it had no separator after it.
const LEADING_FILLER_PATTERN = new RegExp(
  `^(?:${LEADING_FILLER.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|')})(?:[\\s,:;-]+|$)`,
  'i',
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Strip the fragments the APP pastes into a terminal, so a title is never
 * derived from Multicode's own injection instead of the person's request.
 *
 * A drop onto a terminal writes a skill invocation, an @-mention, a file path,
 * or a commit hash via bracketed paste (see `src/renderer/src/utils/terminalDrop.ts`);
 * the user then hits Enter, and the hook reports the combined text as their
 * prompt. Removing these leaves whatever the person typed alongside — and when
 * they typed nothing, leaves an empty string, which `deriveWorkspaceTitle`
 * rejects so the next prompt gets the chance instead.
 *
 * Note this does NOT need to handle knowledge-graph or design-system context:
 * that reaches the agent through CLAUDE.md and system context, never through the
 * `UserPromptSubmit` prompt field, so it cannot reach this function at all.
 */
export function stripInjectedFragments(prompt: string): string {
  return prompt
    // Fenced code and pasted blocks: never a title, and their contents would
    // otherwise supply plausible-looking words.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    // A slash-command invocation, wherever it sits — a dropped skill pastes one
    // at the front, but a user can type one mid-sentence.
    .replace(/(?:^|\s)\/[a-z0-9][a-z0-9._-]*/gi, ' ')
    // @-mentions of files and agents.
    .replace(/(?:^|\s)@[^\s]+/g, ' ')
    // URLs.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    // Path-shaped tokens: anything containing a slash with no spaces. Catches
    // absolute paths, repo-relative paths, and dropped directories alike.
    .replace(/(?:^|\s)~?\.{0,2}\/\S+/g, ' ')
    .replace(/(?:^|\s)[\w.-]+\/[\w./-]+/g, ' ')
    // A bare commit hash pasted by a commit drop.
    .replace(/(?:^|\s)[0-9a-f]{7,64}(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A few words naming what `prompt` is about, or `null` when the prompt carries
 * no usable topic — an empty prompt, one that was nothing but an app-injected
 * skill invocation or file drop, or one that reduces to fewer than
 * {@link MIN_TITLE_LENGTH} characters after filler is removed.
 *
 * `null` means "not a title", NOT "no title ever": the caller leaves the
 * workspace on its default name and tries again on the next prompt.
 */
export function deriveWorkspaceTitle(prompt: string): string | null {
  if (typeof prompt !== 'string') return null

  const stripped = stripInjectedFragments(prompt)
  if (!stripped) return null

  // First sentence only. A prompt's opening sentence is the request; what
  // follows is qualification, and folding it in makes the title longer without
  // making it more distinguishing.
  const firstSentence = stripped.split(/(?<=[.!?])\s+|\n+/)[0]?.trim() ?? ''
  if (!firstSentence) return null

  // Filler strips repeatedly: dictated prompts stack two or three openers before
  // reaching the topic.
  let core = firstSentence
  for (let pass = 0; pass < 4; pass += 1) {
    const next = core.replace(LEADING_FILLER_PATTERN, '')
    if (next === core) break
    core = next
  }
  core = core.trim()
  if (!core) return null

  const words = core.split(/\s+/).filter(Boolean).slice(0, MAX_TITLE_WORDS)
  if (words.length === 0) return null

  let title = words.join(' ')
  if (title.length > MAX_WORKSPACE_TITLE_LENGTH) {
    // Break on a word boundary rather than mid-word; fall back to a hard cut
    // when the very first word is longer than the cap.
    const cut = title.slice(0, MAX_WORKSPACE_TITLE_LENGTH)
    const lastSpace = cut.lastIndexOf(' ')
    title = lastSpace > MIN_TITLE_LENGTH ? cut.slice(0, lastSpace) : cut
  }

  // Trailing punctuation left by the word/character caps, and the commas that
  // survive a clause break.
  title = title.replace(/[\s,;:.\-–—]+$/, '').trim()

  // A title needs a letter in it: a residue of digits and symbols is not a name.
  if (title.length < MIN_TITLE_LENGTH || !/[a-z]/i.test(title)) return null

  // Sentence case only — the first character is lifted, and the rest is left
  // exactly as typed so identifiers survive ("git stash", "OAuth", "useEffect").
  // Title-casing every word would corrupt them.
  return title.charAt(0).toUpperCase() + title.slice(1)
}
