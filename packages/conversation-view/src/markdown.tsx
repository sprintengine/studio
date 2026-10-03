import React from 'react'

// A conversation's prose, drawn as React elements and never as HTML: a reply
// is agent-written, so nothing in it is parsed as markup. The subset is what
// replies are made of (paragraphs, headings, lists, fenced code, inline code,
// emphasis and links); anything else reads as the text it is. A link opens
// through `onLink`, so the page around the view decides where it goes.

type Inline = React.ReactNode

const SAFE_LINK = /^(https?:|mailto:)/iu

function inline(text: string, onLink: (href: string) => void, key: string): Inline[] {
  const out: Inline[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/gu
  let last = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    const id = `${key}-${index++}`
    if (token.startsWith('`')) out.push(<code key={id}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) out.push(<strong key={id}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('*')) out.push(<em key={id}>{token.slice(1, -1)}</em>)
    else {
      const label = token.slice(1, token.indexOf(']('))
      const href = token.slice(token.indexOf('](') + 2, -1)
      out.push(
        SAFE_LINK.test(href) ? (
          <a
            key={id}
            href={href}
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault()
              onLink(href)
            }}
          >
            {label}
          </a>
        ) : (
          label
        ),
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text, onLink }: { text: string; onLink: (href: string) => void }): React.JSX.Element {
  const blocks: React.ReactNode[] = []
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flushParagraph = () => {
    if (paragraph.length)
      blocks.push(<p key={`p${blocks.length}`}>{inline(paragraph.join(' '), onLink, `p${blocks.length}`)}</p>)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((item, index) => (
      <li key={index}>{inline(item, onLink, `l${blocks.length}-${index}`)}</li>
    ))
    blocks.push(list.ordered ? <ol key={`o${blocks.length}`}>{items}</ol> : <ul key={`u${blocks.length}`}>{items}</ul>)
    list = null
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.startsWith('```')) {
      flushParagraph()
      flushList()
      const code: string[] = []
      for (index++; index < lines.length && !lines[index].startsWith('```'); index++) code.push(lines[index])
      blocks.push(
        <pre key={`c${blocks.length}`}>
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/u.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/u.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push(
        <p key={`h${blocks.length}`} className="se-heading">
          <strong>{inline(heading[2], onLink, `h${blocks.length}`)}</strong>
        </p>,
      )
    } else if (bullet || numbered) {
      flushParagraph()
      const ordered = Boolean(numbered)
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1])
    } else if (!line.trim()) {
      flushParagraph()
      flushList()
    } else {
      flushList()
      paragraph.push(line.trim())
    }
  }
  flushParagraph()
  flushList()
  return <div className="se-prose">{blocks}</div>
}
