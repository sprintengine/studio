// Pure citation extraction for the guide's chat replies. The guide is asked to
// ground answers with `path:Lline` line references and `[[note]]` knowledge
// citations; this scans a reply for those and resolves each line reference to a
// real changed-file path so the chat can render it as a jump link. No React, no
// DOM — the chat surface renders what this returns; the test drives it directly.

// A resolved line citation: `path` is the real changed-file path (so a jump
// lands on the right file card), `label` is what to show (`path:L63` /
// `path:L63–66`), and the lines drive the reveal.
export interface LineCitation {
  path: string
  startLine: number
  endLine: number
  label: string
}

export interface GuideCitations {
  lines: LineCitation[]
  knowledge: string[]
}

// `path:L12`, `path:L12-18`, `path:L12–18` (en dash), or the same with a space
// before the L. The path run stops at the colon/space + L marker.
const LINE_CITATION = /([\w./@+-]+?)[\s:]L(\d+)(?:\s*[-–]\s*L?(\d+))?/g
// `[[note-name]]` and the guide-prompt's `knowledge: note-name` form. The prose
// form is undelimited, so its class excludes `.` — a trailing sentence period is
// not part of the note slug (kebab-case, optional folder).
const WIKI_KNOWLEDGE = /\[\[([\w./-]+)\]\]/g
const PROSE_KNOWLEDGE = /knowledge:\s*([\w/-]+)/gi

// Resolve a cited path against the real changed files: exact match wins, else a
// unique basename match (the guide often drops the folder), else null — an
// unresolvable reference is not linked rather than pointing somewhere wrong.
function resolvePath(cited: string, changedPaths: readonly string[]): string | null {
  if (changedPaths.includes(cited)) return cited
  const citedBase = cited.split('/').pop()
  const byBase = changedPaths.filter((path) => path.split('/').pop() === citedBase)
  if (byBase.length === 1) return byBase[0]
  const bySuffix = changedPaths.filter((path) => path.endsWith(`/${cited}`))
  return bySuffix.length === 1 ? bySuffix[0] : null
}

export function extractGuideCitations(text: string, changedPaths: readonly string[]): GuideCitations {
  const lines: LineCitation[] = []
  const seenLine = new Set<string>()

  for (const match of text.matchAll(LINE_CITATION)) {
    const resolved = resolvePath(match[1], changedPaths)
    if (!resolved) continue
    const startLine = Number(match[2])
    const endLine = match[3] ? Number(match[3]) : startLine
    if (!Number.isInteger(startLine) || startLine < 1) continue
    const lo = Math.min(startLine, endLine)
    const hi = Math.max(startLine, endLine)
    const label = lo === hi ? `${resolved}:L${lo}` : `${resolved}:L${lo}–${hi}`
    const key = `${resolved}:${lo}-${hi}`
    if (seenLine.has(key)) continue
    seenLine.add(key)
    lines.push({ path: resolved, startLine: lo, endLine: hi, label })
  }

  const knowledge: string[] = []
  const seenNote = new Set<string>()
  const collectNote = (note: string): void => {
    if (seenNote.has(note)) return
    seenNote.add(note)
    knowledge.push(note)
  }
  for (const match of text.matchAll(WIKI_KNOWLEDGE)) collectNote(match[1])
  for (const match of text.matchAll(PROSE_KNOWLEDGE)) collectNote(match[1])

  return { lines, knowledge }
}
