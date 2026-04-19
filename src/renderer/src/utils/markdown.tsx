import React from 'react'

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'code'; code: string; language: string }
  | { type: 'hr' }

const INLINE_RE =
  /(`[^`]+`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*]+)\*\*)|(__(.+?)__)|(\*([^*]+)\*)|(_([^_]+)_)/g

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let matchIndex = 0

  for (const match of text.matchAll(INLINE_RE)) {
    const full = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index))
    }

    if (match[1]) {
      nodes.push(
        <code
          key={`${keyPrefix}-code-${matchIndex}`}
          className="px-1.5 py-0.5 rounded bg-[#17191d] border border-[#23262d] text-[#d7c38a]"
        >
          {full.slice(1, -1)}
        </code>
      )
    } else if (match[2]) {
      nodes.push(
        <a
          key={`${keyPrefix}-link-${matchIndex}`}
          href={match[4]}
          target="_blank"
          rel="noreferrer"
          className="text-[#8cb4ff] hover:text-[#a9c8ff] underline underline-offset-2"
        >
          {renderInline(match[3], `${keyPrefix}-link-text-${matchIndex}`)}
        </a>
      )
    } else if (match[5] || match[7]) {
      const strongText = match[6] ?? match[8] ?? ''
      nodes.push(
        <strong key={`${keyPrefix}-strong-${matchIndex}`} className="font-semibold text-zinc-100">
          {renderInline(strongText, `${keyPrefix}-strong-text-${matchIndex}`)}
        </strong>
      )
    } else if (match[9] || match[11]) {
      const emText = match[10] ?? match[12] ?? ''
      nodes.push(
        <em key={`${keyPrefix}-em-${matchIndex}`} className="italic text-zinc-200">
          {renderInline(emText, `${keyPrefix}-em-text-${matchIndex}`)}
        </em>
      )
    }

    lastIndex = index + full.length
    matchIndex += 1
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim()
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ type: 'code', code: codeLines.join('\n'), language })
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      })
      i += 1
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    const paragraphLines: string[] = []
    while (i < lines.length) {
      const current = lines[i].trim()
      if (
        !current ||
        current.startsWith('```') ||
        current.startsWith('>') ||
        /^[-*+]\s+/.test(current) ||
        /^\d+\.\s+/.test(current) ||
        /^(#{1,6})\s+/.test(current) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(current)
      ) {
        break
      }
      paragraphLines.push(current)
      i += 1
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') })
  }

  return blocks
}

export function renderMarkdown(markdown: string): React.ReactNode {
  const blocks = parseMarkdown(markdown)

  return blocks.map((block, index) => {
    if (block.type === 'heading') {
      const tagName = `h${block.level}`
      const sizeClass =
        block.level === 1 ? 'text-3xl' :
        block.level === 2 ? 'text-2xl' :
        block.level === 3 ? 'text-xl' :
        'text-lg'

      return React.createElement(
        tagName,
        {
          key: `heading-${index}`,
          className: `${sizeClass} font-semibold tracking-tight text-zinc-100 mt-6 first:mt-0 mb-3`,
        },
        renderInline(block.text, `heading-${index}`)
      )
    }

    if (block.type === 'paragraph') {
      return (
        <p key={`paragraph-${index}`} className="text-[15px] leading-7 text-zinc-300 mb-4">
          {renderInline(block.text, `paragraph-${index}`)}
        </p>
      )
    }

    if (block.type === 'blockquote') {
      return (
        <blockquote
          key={`quote-${index}`}
          className="border-l-2 border-[#3d4252] pl-4 py-0.5 my-4 text-zinc-400"
        >
          {block.lines.map((line, lineIndex) => (
            <p key={`quote-line-${index}-${lineIndex}`} className="leading-7">
              {renderInline(line, `quote-${index}-${lineIndex}`)}
            </p>
          ))}
        </blockquote>
      )
    }

    if (block.type === 'ul' || block.type === 'ol') {
      const ListTag = block.type === 'ul' ? 'ul' : 'ol'
      const markerClass = block.type === 'ul' ? 'list-disc' : 'list-decimal'
      return (
        <ListTag
          key={`list-${index}`}
          className={`${markerClass} ml-6 mb-4 space-y-2 text-[15px] leading-7 text-zinc-300`}
        >
          {block.items.map((item, itemIndex) => (
            <li key={`list-item-${index}-${itemIndex}`}>
              {renderInline(item, `list-${index}-${itemIndex}`)}
            </li>
          ))}
        </ListTag>
      )
    }

    if (block.type === 'code') {
      return (
        <div key={`code-${index}`} className="my-4 rounded-xl border border-[#23262d] overflow-hidden">
          {block.language && (
            <div className="px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-zinc-500 bg-[#14161a] border-b border-[#23262d]">
              {block.language}
            </div>
          )}
          <pre className="m-0 p-4 overflow-x-auto bg-[#0b0c0e] text-[13px] leading-6 text-zinc-200">
            <code>{block.code}</code>
          </pre>
        </div>
      )
    }

    return <hr key={`hr-${index}`} className="my-6 border-0 border-t border-[#23262d]" />
  })
}
