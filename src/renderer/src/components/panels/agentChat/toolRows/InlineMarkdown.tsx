import React from 'react'

// Markdown for a short string that sits inside a control: a question's option
// label and its description, a to-do item. The agent writes these the way it
// writes everything, so `**bold**` and `code` turn up in them, and shown raw
// the asterisks and backticks are noise. But a radio's label cannot hold a
// heading, a list or a second control, so this renders the inline marks only —
// strong, emphasis, strike and code — and takes a link as its label text.
// Block syntax at the start of a line is dropped and the lines run together.

const BLOCK_PREFIX = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,3}[.)]\s+)/u
const FENCE = /^\s{0,3}(?:```|~~~)/u

// Code first so nothing inside a code span is read as a mark; emphasis only at
// a word boundary, so snake_case_names and 2*3*4 stay as written.
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*|__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)|~~(?=\S)([\s\S]+?)(?<=\S)~~|(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_]+?)(?<=\S)_(?![\w_])|!?\[([^\]]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/gu

const CODE_CLASS =
  'rounded-xs bg-[color:var(--bg-active)] px-[0.34em] py-[0.1em] font-mono text-[0.92em] text-[color:var(--text-default)]'

function flattenBlocks(text: string): string {
  return text
    .split('\n')
    .filter((line) => !FENCE.test(line))
    .map((line) => line.replace(BLOCK_PREFIX, '').trim())
    .filter(Boolean)
    .join(' ')
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const key = `${keyPrefix}${index++}`
    const [, , code, strong, strongAlt, strike, em, emAlt, linkLabel] = match
    if (code !== undefined)
      nodes.push(
        <code key={key} className={CODE_CLASS}>
          {code.trim() || code}
        </code>,
      )
    else if (strong !== undefined || strongAlt !== undefined)
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderInline(strong ?? strongAlt!, `${key}.`)}
        </strong>,
      )
    else if (strike !== undefined) nodes.push(<s key={key}>{renderInline(strike, `${key}.`)}</s>)
    else if (em !== undefined || emAlt !== undefined)
      nodes.push(<em key={key}>{renderInline(em ?? emAlt!, `${key}.`)}</em>)
    else if (linkLabel !== undefined) nodes.push(...renderInline(linkLabel, `${key}.`))
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** Inline marks only; safe inside a button, a radio or a list item. */
export function InlineMarkdown({ text }: { text: string }): React.JSX.Element {
  return <>{renderInline(flattenBlocks(text), 'm')}</>
}

/** The words without their marks, for an accessible name or a tooltip. */
export function plainInlineText(text: string): string {
  return flattenBlocks(text).replace(
    INLINE,
    (whole: string, _ticks, code?: string, ...marked: (string | undefined)[]) =>
      code !== undefined
        ? code.trim() || code
        : plainInlineText(marked.slice(0, 6).find((part) => part !== undefined) ?? whole),
  )
}
