// A message segment that is one fenced code block, read without the markdown
// parser.
//
// A reply that streams a long file is a single segment for as long as its
// fence is open, and parsing that segment again on every token costs time in
// proportion to everything already streamed: a 400-line block spent most of
// each frame in the parser by its end. The inside of a fence is plain text,
// so its value can be read straight off the lines. The parser still reads the
// opener (language, meta, entities and escapes in the info string) from a
// placeholder block that has the same opener and one line of content, and the
// real text replaces that line in the tree it builds. Everything downstream
// renders the same tree it would have rendered from a full parse.

const OPENER = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/u
const CLOSER = /^ {0,3}(`+|~+)[ \t]*$/u
const BLANK = /^[ \t]*$/u
// A carriage return changes what a line is, the parser replaces NUL, and a
// byte order mark is dropped; none is worth reading here.
const UNREADABLE = /[\r\0﻿]/u
const PLACEHOLDER_LINE = 'x'

export type FencedCode = {
  /** The same opener and fence, around one placeholder line. */
  placeholder: string
  /** The code node's value, as the parser would have read it. */
  value: string
}

export function singleFencedCode(source: string): FencedCode | null {
  if (UNREADABLE.test(source)) return null
  const openerEnd = source.indexOf('\n')
  // An opener still streaming may yet turn out to be something else.
  if (openerEnd < 0) return null
  const opener = OPENER.exec(source.slice(0, openerEnd))
  if (!opener) return null
  const [openerLine, indent, fence, info] = opener
  if (fence[0] === '`' && info.includes('`')) return null
  const lines = source.slice(openerEnd + 1).split('\n')
  // A final line ending ends the last line; it does not start another.
  const unterminated = !source.endsWith('\n')
  if (!unterminated) lines.pop()
  const content: string[] = []
  let index = 0
  let closed = false
  for (; index < lines.length; index++) {
    const line = lines[index]
    const closer = CLOSER.exec(line)
    if (closer && closer[1][0] === fence[0] && closer[1].length >= fence.length) {
      closed = true
      index++
      break
    }
    content.push(line)
  }
  // Only blank lines may follow the closer, or the segment is more than one block.
  if (closed) for (; index < lines.length; index++) if (!BLANK.test(lines[index])) return null
  const width = indent.length
  const value: string[] = []
  for (const line of content) {
    if (width === 0) {
      value.push(line)
      continue
    }
    // An opener indented N columns takes up to N spaces off each line. A tab
    // inside those columns is only partly taken, which is the parser's to do.
    let strip = 0
    while (strip < width && line[strip] === ' ') strip++
    if (strip < width && line[strip] === '\t') return null
    value.push(line.slice(strip))
  }
  // A line still streaming that is empty once the opener's indent is taken
  // off is not a line yet.
  if (!closed && unterminated && value.at(-1) === '') value.pop()
  return {
    placeholder: `${openerLine}\n${indent}${PLACEHOLDER_LINE}\n${indent}${fence}\n`,
    value: value.join('\n'),
  }
}

type CodeNode = { type: string; value?: string; children?: CodeNode[] }

/** Remark plugin: the placeholder block's code takes the segment's real text. */
export function remarkFencedCodeValue(value: string) {
  return () => (tree: CodeNode) => {
    const code = tree.children?.[0]
    if (code?.type === 'code') code.value = value
  }
}
