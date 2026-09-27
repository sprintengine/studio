export type ComposerTrigger = {
  kind: 'slash' | 'skill' | 'mention'
  query: string
  range: { start: number; end: number }
}

/** Token boundaries prevent mail addresses and mid-word punctuation opening a picker. */
export function detectComposerTrigger(text: string, caret: number): ComposerTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null
  const prefix = text.slice(0, caret)
  const match = /(?:^|\s)([/@$])([^\s]*)$/u.exec(prefix)
  if (!match) return null
  const marker = match[1],
    query = match[2]
  if (/[/@$]/u.test(query[0] ?? '')) return null
  const start = caret - query.length - 1
  const suffix = text.slice(caret).search(/\s/u)
  return {
    kind: marker === '/' ? 'slash' : marker === '$' ? 'skill' : 'mention',
    query,
    range: { start, end: suffix < 0 ? text.length : caret + suffix },
  }
}
