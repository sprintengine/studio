import React from 'react'
import type { Element } from 'hast'
import ReactMarkdown, { type Components, type ExtraProps, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GitLineChange } from './gitDiff'

type MarkdownRenderOptions = {
  lineChanges?: GitLineChange[]
}

type MarkdownNode = Element | undefined
type MarkdownComponentProps<TagName extends keyof JSX.IntrinsicElements> =
  React.ComponentPropsWithoutRef<TagName> & ExtraProps

const baseTextClass = 'text-[15px] leading-7 text-[#d7d7dc]'
const SAFE_MARKDOWN_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

const safeMarkdownUrlTransform: UrlTransform = (url) => {
  return isSafeMarkdownUrl(url) ? url : ''
}

function isSafeMarkdownUrl(url: string | undefined): url is string {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return SAFE_MARKDOWN_URL_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

function lineRange(node: MarkdownNode): { startLine: number; endLine: number } | null {
  const startLine = node?.position?.start?.line
  const endLine = node?.position?.end?.line
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return null
  return { startLine, endLine }
}

function changeKindForRange(
  node: MarkdownNode,
  lineChanges: GitLineChange[] | undefined
): GitLineChange['kind'] | null {
  if (!lineChanges?.length) return null
  const range = lineRange(node)
  if (!range) return null

  let matched: GitLineChange['kind'] | null = null

  for (const change of lineChanges) {
    const overlaps = change.startLine <= range.endLine && change.endLine >= range.startLine
    if (!overlaps) continue
    if (change.kind === 'deleted') return 'deleted'
    if (change.kind === 'modified') matched = 'modified'
    if (!matched) matched = change.kind
  }

  return matched
}

function changedBlockClass(
  node: MarkdownNode,
  lineChanges: GitLineChange[] | undefined
): string | null {
  const kind = changeKindForRange(node, lineChanges)
  return kind ? `markdown-change-block markdown-change-${kind}` : null
}

export function renderMarkdown(markdown: string, options: MarkdownRenderOptions = {}): React.ReactNode {
  const { lineChanges } = options

  const components: Components = {
    h1: ({ node, children, className }: MarkdownComponentProps<'h1'>) => (
      <h1
        className={joinClasses(
          className,
          'mt-7 first:mt-0 mb-4 text-3xl font-semibold leading-tight tracking-tight text-[#ececee]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </h1>
    ),
    h2: ({ node, children, className }: MarkdownComponentProps<'h2'>) => (
      <h2
        className={joinClasses(
          className,
          'mt-7 first:mt-0 mb-3 text-2xl font-semibold leading-tight tracking-tight text-[#ececee]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </h2>
    ),
    h3: ({ node, children, className }: MarkdownComponentProps<'h3'>) => (
      <h3
        className={joinClasses(
          className,
          'mt-6 first:mt-0 mb-3 text-xl font-semibold leading-snug tracking-tight text-[#ececee]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </h3>
    ),
    h4: ({ node, children, className }: MarkdownComponentProps<'h4'>) => (
      <h4
        className={joinClasses(
          className,
          'mt-5 first:mt-0 mb-2 text-lg font-semibold leading-snug text-[#ececee]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </h4>
    ),
    h5: ({ node, children, className }: MarkdownComponentProps<'h5'>) => (
      <h5
        className={joinClasses(
          className,
          'mt-5 first:mt-0 mb-2 text-base font-semibold leading-snug text-[#ececee]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </h5>
    ),
    h6: ({ node, children, className }: MarkdownComponentProps<'h6'>) => (
      <h6
        className={joinClasses(
          className,
          'mt-5 first:mt-0 mb-2 text-sm font-semibold uppercase leading-snug tracking-[0.08em] text-[#b9b9c2]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </h6>
    ),
    p: ({ node, children, className }: MarkdownComponentProps<'p'>) => (
      <p
        className={joinClasses(className, baseTextClass, 'mb-4', changedBlockClass(node, lineChanges))}
      >
        {children}
      </p>
    ),
    a: ({ children, href, className }: MarkdownComponentProps<'a'>) => {
      if (!isSafeMarkdownUrl(href)) {
        return <span className={joinClasses(className, 'text-[#d7d7dc]')}>{children}</span>
      }

      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={joinClasses(className, 'text-[#7f99ff] underline underline-offset-2 hover:text-[#c5d2ff]')}
        >
          {children}
        </a>
      )
    },
    strong: ({ children, className }: MarkdownComponentProps<'strong'>) => (
      <strong className={joinClasses(className, 'font-semibold text-[#ececee]')}>
        {children}
      </strong>
    ),
    em: ({ children, className }: MarkdownComponentProps<'em'>) => (
      <em className={joinClasses(className, 'italic text-[#d7d7dc]')}>
        {children}
      </em>
    ),
    code: ({ children, className }: MarkdownComponentProps<'code'>) => (
      <code
        className={joinClasses(
          className,
          'rounded border border-[#24252b] bg-[#111216] px-1.5 py-0.5 text-[#ffd58a]'
        )}
      >
        {children}
      </code>
    ),
    pre: ({ node, children, className }: MarkdownComponentProps<'pre'>) => (
      <pre
        className={joinClasses(
          className,
          'my-4 overflow-x-auto rounded-lg border border-[#24252b] bg-[#08090b] p-4 text-[13px] leading-6 text-[#d7d7dc]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </pre>
    ),
    blockquote: ({ node, children, className }: MarkdownComponentProps<'blockquote'>) => (
      <blockquote
        className={joinClasses(
          className,
          'my-4 border-l-2 border-[#303139] py-0.5 pl-4 text-[#9a9aa2]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </blockquote>
    ),
    ul: ({ node, children, className }: MarkdownComponentProps<'ul'>) => (
      <ul
        className={joinClasses(
          className,
          'mb-4 ml-6 list-disc space-y-2 text-[15px] leading-7 text-[#d7d7dc]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ node, children, className, start, reversed, type }: MarkdownComponentProps<'ol'>) => (
      <ol
        start={start}
        reversed={reversed}
        type={type}
        className={joinClasses(
          className,
          'mb-4 ml-6 list-decimal space-y-2 text-[15px] leading-7 text-[#d7d7dc]',
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </ol>
    ),
    li: ({ node, children, className, value }: MarkdownComponentProps<'li'>) => (
      <li
        value={value}
        className={joinClasses(
          className,
          changedBlockClass(node, lineChanges)
        )}
      >
        {children}
      </li>
    ),
    input: ({ className, checked, type }: MarkdownComponentProps<'input'>) => (
      <input
        checked={checked}
        type={type}
        className={joinClasses(className, 'mr-2 translate-y-[1px] accent-[#35d07f]')}
        disabled
      />
    ),
    img: ({ alt, className }: MarkdownComponentProps<'img'>) => (
      <span className={joinClasses(className, 'text-[#9a9aa2]')}>
        {alt ? `[Image: ${alt}]` : '[Image]'}
      </span>
    ),
    table: ({ node, children, className }: MarkdownComponentProps<'table'>) => (
      <div className={joinClasses('my-4 overflow-x-auto', changedBlockClass(node, lineChanges))}>
        <table
          className={joinClasses(className, 'w-full border-collapse text-left text-[13px] text-[#d7d7dc]')}
        >
          {children}
        </table>
      </div>
    ),
    th: ({ children, className, align }: MarkdownComponentProps<'th'>) => (
      <th
        align={align}
        className={joinClasses(className, 'border border-[#303139] bg-[#111216] px-3 py-2 font-semibold text-[#ececee]')}
      >
        {children}
      </th>
    ),
    td: ({ children, className, align }: MarkdownComponentProps<'td'>) => (
      <td align={align} className={joinClasses(className, 'border border-[#24252b] px-3 py-2 align-top')}>
        {children}
      </td>
    ),
    hr: ({ node, className }: MarkdownComponentProps<'hr'>) => (
      <hr
        className={joinClasses(className, 'my-6 border-0 border-t border-[#24252b]', changedBlockClass(node, lineChanges))}
      />
    ),
  }

  return (
    <div className="markdown-rendered">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeMarkdownUrlTransform}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
