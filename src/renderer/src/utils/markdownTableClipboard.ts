import type { Element } from 'hast'

/**
 * A rendered markdown table written back out for the clipboard, from the syntax
 * tree the renderer drew it from rather than from the page. The page holds the
 * table's chrome as well as its cells, and a selection of it arrives as runs of
 * cells with no columns; the tree holds exactly the table the author wrote.
 *
 * Four shapes, one per place a table gets pasted: Markdown for a document, an
 * issue or the composer; HTML beside it for a rich editor; CSV for a file or a
 * tool; TSV for a spreadsheet, which splits a pasted line on tabs and would
 * leave CSV in one column.
 */

type HastChild = Element['children'][number]
type Align = 'left' | 'center' | 'right' | null

type TableGrid = {
  header: Element[]
  body: Element[][]
  align: Align[]
}

const SAFE_LINK = /^(?:https?:|mailto:)/iu

function isCell(node: HastChild): node is Element {
  return node.type === 'element' && (node.tagName === 'th' || node.tagName === 'td')
}

function grid(table: Element): TableGrid | null {
  const rows: Element[] = []
  const collect = (node: Element) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue
      if (child.tagName === 'tr') rows.push(child)
      else collect(child)
    }
  }
  collect(table)
  const [header, ...body] = rows.map((row) => row.children.filter(isCell))
  if (!header?.length) return null
  const align = header.map((cell): Align => {
    const value = cell.properties.align
    return value === 'left' || value === 'center' || value === 'right' ? value : null
  })
  return { header, body, align }
}

// A GFM row always has the header's width: a short row is padded, a long one
// loses its extra cells, which is what a markdown renderer does with them too.
function fit<T>(row: T[], width: number, empty: T): T[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? empty)
}

// A cell's content written back as markdown: a cell's code, emphasis and links
// should survive a paste into another document, and a `|` inside one must not
// split it — inside a code span too, where GFM still reads it as a column edge.
function inlineMarkdown(node: HastChild): string {
  if (node.type === 'text') return node.value.replace(/\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ')
  if (node.type !== 'element') return ''
  const inner = node.children.map(inlineMarkdown).join('')
  switch (node.tagName) {
    case 'code':
      return `\`${inner}\``
    case 'strong':
      return `**${inner}**`
    case 'em':
      return `*${inner}*`
    case 'del':
      return `~~${inner}~~`
    case 'br':
      return ' '
    case 'a':
      return typeof node.properties.href === 'string' ? `[${inner}](${node.properties.href})` : inner
    case 'img':
      return `![${String(node.properties.alt ?? '')}](${String(node.properties.src ?? '')})`
    case 'input':
      return node.properties.checked ? '[x] ' : '[ ] '
    default:
      return inner
  }
}

// What a reader sees in the cell, for the formats that carry no formatting.
function plainText(node: HastChild): string {
  if (node.type === 'text') return node.value
  if (node.type !== 'element') return ''
  if (node.tagName === 'br') return ' '
  if (node.tagName === 'img') return String(node.properties.alt ?? '')
  if (node.tagName === 'input') return node.properties.checked ? '[x] ' : '[ ] '
  return node.children.map(plainText).join('')
}

function cellText(cell: Element | null): string {
  return cell ? cell.children.map(plainText).join('').replace(/\s+/gu, ' ').trim() : ''
}

const ALIGN_RULE: Record<Exclude<Align, null> | 'none', string> = {
  left: ':---',
  center: ':---:',
  right: '---:',
  none: '---',
}

export function tableMarkdown(table: Element): string {
  const parsed = grid(table)
  if (!parsed) return ''
  const width = parsed.header.length
  const line = (row: string[]) => `| ${row.join(' | ')} |`
  const text = (row: Element[]) =>
    fit<Element | null>(row, width, null).map((cell) => (cell ? cell.children.map(inlineMarkdown).join('').trim() : ''))
  const rule = parsed.align.map((align) => ALIGN_RULE[align ?? 'none'])
  return [line(text(parsed.header)), line(rule), ...parsed.body.map((row) => line(text(row)))].join('\n')
}

// A spreadsheet reads a cell that opens with = + - or @ (or a tab or carriage
// return before one) as a formula, so a table an agent wrote could run one on
// paste. Such a cell goes out behind a `'`, the spreadsheet's own mark for
// "this is text". A plain signed number is left alone: it is data, it has no
// formula in it, and marked it would stop summing.
const FORMULA_START = /^[=+\-@\t\r]/u
const SIGNED_NUMBER = /^[+-]?\d+(?:[.,]\d+)*%?$/u

function inertCell(value: string): string {
  return FORMULA_START.test(value) && !SIGNED_NUMBER.test(value) ? `'${value}` : value
}

// RFC 4180 quoting: a field holding a quote, a comma or a line break is wrapped
// in quotes, and a quote inside it is doubled. Everything else goes as it is.
function csvField(value: string): string {
  const cell = inertCell(value)
  return /[",\r\n]/u.test(cell) ? `"${cell.replace(/"/gu, '""')}"` : cell
}

function delimited(table: Element, field: (value: string) => string, separator: string): string {
  const parsed = grid(table)
  if (!parsed) return ''
  const width = parsed.header.length
  return [parsed.header, ...parsed.body]
    .map((row) =>
      fit<Element | null>(row, width, null)
        .map((cell) => field(cellText(cell)))
        .join(separator),
    )
    .join('\n')
}

export function tableCsv(table: Element): string {
  return delimited(table, csvField, ',')
}

// A spreadsheet splits a pasted line on tabs and rows on newlines, and has no
// quoting it agrees on; a cell's own tabs become spaces so it stays one cell.
// (Its line breaks are already spaces: a cell's text is collapsed to one line.)
export function tableTsv(table: Element): string {
  return delimited(table, (value) => inertCell(value.replace(/\t/gu, ' ')), '\t')
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

const INLINE_TAGS = new Set(['strong', 'em', 'code', 'del'])

// The cell as markup a rich editor keeps: emphasis, code and links, and nothing
// else. It is built from the tree, never copied from the page, so no class,
// handler or chrome of the app's travels with it; a link keeps its href only
// when it is one the renderer would have made clickable.
function inlineHtml(node: HastChild): string {
  if (node.type === 'text') return escapeHtml(node.value)
  if (node.type !== 'element') return ''
  const inner = node.children.map(inlineHtml).join('')
  if (INLINE_TAGS.has(node.tagName)) return `<${node.tagName}>${inner}</${node.tagName}>`
  if (node.tagName === 'br') return '<br>'
  if (node.tagName === 'a') {
    const href = node.properties.href
    // design-tokens-allow: clipboard markup for another app's editor, never rendered here, so it has no focus to ring
    return typeof href === 'string' && SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner
  }
  if (node.tagName === 'img') return escapeHtml(String(node.properties.alt ?? ''))
  if (node.tagName === 'input') return node.properties.checked ? '[x] ' : '[ ] '
  return inner
}

export function tableHtml(table: Element): string {
  const parsed = grid(table)
  if (!parsed) return ''
  const width = parsed.header.length
  const cells = (row: Element[], tag: 'th' | 'td') =>
    fit<Element | null>(row, width, null)
      .map((cell, index) => {
        const align = parsed.align[index]
        const style = align ? ` style="text-align:${align}"` : ''
        return `<${tag}${style}>${cell ? cell.children.map(inlineHtml).join('').trim() : ''}</${tag}>`
      })
      .join('')
  const body = parsed.body.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')
  return `<table><thead><tr>${cells(parsed.header, 'th')}</tr></thead><tbody>${body}</tbody></table>`
}
