export type ComposerTrigger = {
  /** `slash` opens the command menu, `skill` Studio's skill picker, `mention` the file picker. */
  kind: 'slash' | 'skill' | 'mention'
  query: string
  range: { start: number; end: number }
}

/**
 * Token boundaries prevent mail addresses and mid-word punctuation opening a picker.
 *
 * `/` is stricter than the other two. A CLI expands a command only when it
 * opens the message, so the command menu opens only where `/` is the first
 * non-blank character of the whole draft — never mid-sentence or on a later
 * line, where "and/or" or a pasted `src/foo` path would otherwise keep popping
 * it and a picked command would be sent as prose. A `/` whose query
 * holds another `/` is a path (`/Users/dev/app`), not a command. The caret
 * must still be inside the token: arguments follow a space, and a space closes
 * the menu so they are typed as plain text.
 */
export function detectComposerTrigger(text: string, caret: number): ComposerTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null
  const prefix = text.slice(0, caret)
  const match = /(?:^|\s)([/@$])([^\s]*)$/u.exec(prefix)
  if (!match) return null
  const marker = match[1],
    query = match[2]
  if (/[/@$]/u.test(query[0] ?? '')) return null
  const start = caret - query.length - 1
  if (marker === '/') {
    if (query.includes('/')) return null
    if (prefix.slice(0, start).trim()) return null
  }
  const suffix = text.slice(caret).search(/\s/u)
  return {
    kind: marker === '/' ? 'slash' : marker === '$' ? 'skill' : 'mention',
    query,
    range: { start, end: suffix < 0 ? text.length : caret + suffix },
  }
}
