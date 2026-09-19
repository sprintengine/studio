import React, { type JSX } from 'react'
import type { Element } from 'hast'
import ReactMarkdown, { type Components, type ExtraProps, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Checkbox } from '../components/ui/Checkbox'
import { LinkButton } from '../components/ui/LinkButton'
import type { GitLineChange } from './gitDiff'

/**
 * A document renders at `document` scale; a document read inside a dense
 * surface (the skill reader) renders at `compact`, where the heading scale is
 * the surface's own and body copy stays at its body size.
 */
type MarkdownDensity = 'document' | 'compact'

/**
 * What a link that is not a web URL points at. A renderer that owns a local
 * corpus — the files of one skill — resolves relative hrefs against it: a hit
 * opens in place, a miss is stated as a miss rather than rendered as if it
 * would work.
 */
type MarkdownLinkTarget = { kind: 'file'; path: string } | { kind: 'dead'; reason: string }

export type MarkdownLinkResolver = {
  /** null when the href is not this corpus's to own (a scheme, a fragment). */
  resolve: (href: string) => MarkdownLinkTarget | null
  open: (path: string) => void
}

type MarkdownRenderOptions = {
  lineChanges?: GitLineChange[]
  density?: MarkdownDensity
  links?: MarkdownLinkResolver
}

type MarkdownNode = Element | undefined
type MarkdownComponentProps<TagName extends keyof JSX.IntrinsicElements> = React.ComponentPropsWithoutRef<TagName> &
  ExtraProps

// Prose, so it takes the ramp step *below* the 15px it used to hard-code, not
// the one above: `text-title` would put document body text at the same size as
// the titles over it and spend a third font size the "3 per view" ceiling has
// no room for. At `text-heading` the document scale's h6 (`text-sm`) matches it
// in size and separates on weight, which is the hierarchy this scale already
// declares it carries.
const baseTextClass = 'text-heading leading-7 text-[color:var(--text-default)]'
const compactTextClass = 'text-meta leading-[1.65] text-[color:var(--text-default)]'
const SAFE_MARKDOWN_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const LINK_CLASS =
  'text-[color:var(--accent-primary)] underline underline-offset-2 hover:text-[color:var(--accent-primary-hover)]'

/**
 * Per-element classes for each density. Hierarchy is carried by weight, colour
 * and space — no rules under headings — so the two scales differ only in size
 * and rhythm.
 */
type MarkdownScale = {
  h1: string
  h2: string
  h3: string
  h4: string
  h5: string
  h6: string
  p: string
  list: string
  pre: string
  code: string
  blockquote: string
  hr: string
  table: string
}

const MARKDOWN_SCALE: Record<MarkdownDensity, MarkdownScale> = {
  document: {
    h1: 'mt-8 first:mt-0 mb-4 text-3xl font-semibold leading-tight tracking-tight text-[color:var(--text-strong)]',
    h2: 'mt-8 first:mt-0 mb-3 text-2xl font-semibold leading-tight tracking-tight text-[color:var(--text-strong)]',
    h3: 'mt-6 first:mt-0 mb-3 text-xl font-semibold leading-snug tracking-tight text-[color:var(--text-strong)]',
    h4: 'mt-5 first:mt-0 mb-2 text-lg font-semibold leading-snug text-[color:var(--text-strong)]',
    h5: 'mt-5 first:mt-0 mb-2 text-base font-semibold leading-snug text-[color:var(--text-strong)]',
    h6: 'mt-5 first:mt-0 mb-2 text-sm font-semibold leading-snug tracking-tight text-[color:var(--text-strong)]',
    p: `${baseTextClass} mb-4`,
    list: `mb-4 ml-6 space-y-2 ${baseTextClass}`,
    pre: 'my-4 overflow-x-auto rounded-lg border border-[color:var(--border-default)] bg-[color:var(--terminal-bg)] p-4 text-body leading-6 text-[color:var(--terminal-fg)]',
    // A long path wraps instead of pushing the line box wider than the column;
    // `break-words` keeps a short token whole and moves it down instead.
    code: 'rounded-xs border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-[color:var(--tone-warn)] break-words',
    blockquote: 'my-4 border-l-2 border-[color:var(--border-strong)] py-0.5 pl-4 text-[color:var(--text-muted)]',
    hr: 'my-6 border-0 border-t border-[color:var(--border-default)]',
    table: 'w-full border-collapse text-left text-body text-[color:var(--text-default)]',
  },
  compact: {
    h1: 'mt-6 first:mt-0 mb-4 text-title font-semibold leading-tight tracking-[-0.01em] text-[color:var(--text-strong)]',
    h2: 'mt-[30px] first:mt-0 mb-2.5 text-body font-semibold leading-tight text-[color:var(--text-strong)]',
    h3: 'mt-[22px] first:mt-0 mb-2 text-meta font-semibold leading-snug text-[color:var(--text-strong)]',
    h4: 'mt-5 first:mt-0 mb-1.5 text-meta font-semibold leading-snug text-[color:var(--text-default)]',
    h5: 'mt-5 first:mt-0 mb-1.5 text-meta font-medium leading-snug text-[color:var(--text-default)]',
    // The last rung of the compact ladder: 11px is under the 13px floor for
    // `tracking.tight`, so it holds normal tracking and takes its step down
    // from ink, not from a transform.
    h6: 'mt-5 first:mt-0 mb-1.5 text-micro font-semibold leading-snug tracking-normal text-[color:var(--text-muted)]',
    p: `${compactTextClass} mb-3`,
    list: `mb-3 ml-[18px] space-y-1.5 ${compactTextClass}`,
    pre: 'my-4 overflow-x-auto rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3 text-micro leading-[1.7] text-[color:var(--text-default)]',
    // Inline code sits inside running text, so it matches that text's size;
    // inside a fence it takes the fence's, which is already set on the <pre>.
    code: 'rounded-[3px] bg-[color:var(--bg-active)] px-[0.34em] py-[0.1em] text-[0.92em] text-[color:var(--text-default)] break-words [pre_&]:text-[1em]',
    blockquote: 'my-3 border-l border-[color:var(--border-strong)] py-0.5 pl-4 text-[color:var(--text-muted)]',
    hr: 'my-[22px] border-0 border-t border-[color:var(--border-subtle)]',
    table: 'w-full border-collapse text-left text-micro text-[color:var(--text-default)]',
  },
}

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
  lineChanges: GitLineChange[] | undefined,
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

function changedBlockClass(node: MarkdownNode, lineChanges: GitLineChange[] | undefined): string | null {
  const kind = changeKindForRange(node, lineChanges)
  return kind ? `markdown-change-block markdown-change-${kind}` : null
}

export function renderMarkdown(markdown: string, options: MarkdownRenderOptions = {}): React.ReactNode {
  const { lineChanges, links } = options
  const scale = MARKDOWN_SCALE[options.density ?? 'document']

  const components: Components = {
    h1: ({ node, children, className }: MarkdownComponentProps<'h1'>) => (
      <h1 className={joinClasses(className, scale.h1, changedBlockClass(node, lineChanges))}>{children}</h1>
    ),
    h2: ({ node, children, className }: MarkdownComponentProps<'h2'>) => (
      <h2 className={joinClasses(className, scale.h2, changedBlockClass(node, lineChanges))}>{children}</h2>
    ),
    h3: ({ node, children, className }: MarkdownComponentProps<'h3'>) => (
      <h3 className={joinClasses(className, scale.h3, changedBlockClass(node, lineChanges))}>{children}</h3>
    ),
    h4: ({ node, children, className }: MarkdownComponentProps<'h4'>) => (
      <h4 className={joinClasses(className, scale.h4, changedBlockClass(node, lineChanges))}>{children}</h4>
    ),
    h5: ({ node, children, className }: MarkdownComponentProps<'h5'>) => (
      <h5 className={joinClasses(className, scale.h5, changedBlockClass(node, lineChanges))}>{children}</h5>
    ),
    h6: ({ node, children, className }: MarkdownComponentProps<'h6'>) => (
      <h6 className={joinClasses(className, scale.h6, changedBlockClass(node, lineChanges))}>{children}</h6>
    ),
    p: ({ node, children, className }: MarkdownComponentProps<'p'>) => (
      <p className={joinClasses(className, scale.p, changedBlockClass(node, lineChanges))}>{children}</p>
    ),
    a: ({ children, href, className }: MarkdownComponentProps<'a'>) => {
      const target = links && typeof href === 'string' ? links.resolve(href) : null

      if (target?.kind === 'file') {
        const path = target.path
        return (
          // The kit's inline link: a control set inside prose, taking the
          // surrounding text's size and weight, with a standing underline so it
          // reads as a link beside the `<a>` rows above. It opens a file rather
          // than navigating, which is why it is a button and not an anchor.
          <LinkButton
            ink="accent"
            underline="always"
            size="inherit"
            onClick={() => links?.open(path)}
            className={className}
          >
            {children}
          </LinkButton>
        )
      }

      // Not an error — the file is simply not here. Muted and dotted, never the
      // danger colour, and it says why rather than looking clickable. The
      // reason is spoken as well as hovered: a dead link is not focusable, so a
      // tooltip alone would leave it reading as ordinary prose.
      if (target?.kind === 'dead') {
        return (
          <span
            title={target.reason}
            className={joinClasses(
              className,
              'cursor-help text-[color:var(--text-muted)] underline decoration-dotted underline-offset-2',
            )}
          >
            {children}
            <span className="sr-only">{` — ${target.reason}`}</span>
          </span>
        )
      }

      if (!isSafeMarkdownUrl(href)) {
        return <span className={joinClasses(className, 'text-[color:var(--text-default)]')}>{children}</span>
      }

      return (
        <a href={href} target="_blank" rel="noreferrer" className={joinClasses(className, LINK_CLASS)}>
          {children}
        </a>
      )
    },
    strong: ({ children, className }: MarkdownComponentProps<'strong'>) => (
      <strong className={joinClasses(className, 'font-semibold text-[color:var(--text-strong)]')}>{children}</strong>
    ),
    em: ({ children, className }: MarkdownComponentProps<'em'>) => (
      <em className={joinClasses(className, 'italic text-[color:var(--text-default)]')}>{children}</em>
    ),
    code: ({ children, className }: MarkdownComponentProps<'code'>) => (
      <code className={joinClasses(className, scale.code)}>{children}</code>
    ),
    pre: ({ node, children, className }: MarkdownComponentProps<'pre'>) => (
      <pre className={joinClasses(className, scale.pre, changedBlockClass(node, lineChanges))}>{children}</pre>
    ),
    blockquote: ({ node, children, className }: MarkdownComponentProps<'blockquote'>) => (
      <blockquote className={joinClasses(className, scale.blockquote, changedBlockClass(node, lineChanges))}>
        {children}
      </blockquote>
    ),
    ul: ({ node, children, className }: MarkdownComponentProps<'ul'>) => (
      <ul className={joinClasses(className, scale.list, 'list-disc', changedBlockClass(node, lineChanges))}>
        {children}
      </ul>
    ),
    ol: ({ node, children, className, start, reversed, type }: MarkdownComponentProps<'ol'>) => (
      <ol
        start={start}
        reversed={reversed}
        type={type}
        className={joinClasses(className, scale.list, 'list-decimal', changedBlockClass(node, lineChanges))}
      >
        {children}
      </ol>
    ),
    li: ({ node, children, className, value }: MarkdownComponentProps<'li'>) => (
      <li value={value} className={joinClasses(className, changedBlockClass(node, lineChanges))}>
        {children}
      </li>
    ),
    // A GFM task-list marker: the state comes from the document, so it is the
    // kit checkbox in MARKER mode — no label wrapper (the list item's own text
    // is the label), no handler, and `aria-readonly` rather than `disabled`,
    // which would read as "unavailable" for a box that is neither.
    input: ({ className, checked, type }: MarkdownComponentProps<'input'>) =>
      type === 'checkbox' ? (
        <Checkbox readOnly checked={checked === true} className={joinClasses(className, 'mr-2')} />
      ) : null,
    img: ({ alt, className }: MarkdownComponentProps<'img'>) => (
      <span className={joinClasses(className, 'text-[color:var(--text-muted)]')}>
        {alt ? `[Image: ${alt}]` : '[Image]'}
      </span>
    ),
    table: ({ node, children, className }: MarkdownComponentProps<'table'>) => (
      <div className={joinClasses('my-4 overflow-x-auto', changedBlockClass(node, lineChanges))}>
        <table className={joinClasses(className, scale.table)}>{children}</table>
      </div>
    ),
    th: ({ children, className, align }: MarkdownComponentProps<'th'>) => (
      <th
        align={align}
        className={joinClasses(
          className,
          'border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] px-3 py-2 font-semibold text-[color:var(--text-strong)]',
        )}
      >
        {children}
      </th>
    ),
    td: ({ children, className, align }: MarkdownComponentProps<'td'>) => (
      <td
        align={align}
        className={joinClasses(className, 'border border-[color:var(--border-default)] px-3 py-2 align-top')}
      >
        {children}
      </td>
    ),
    hr: ({ node, className }: MarkdownComponentProps<'hr'>) => (
      <hr className={joinClasses(className, scale.hr, changedBlockClass(node, lineChanges))} />
    ),
  }

  // A resolver's own hrefs survive the protocol guard so the `a` component can
  // see them; everything else still has to be http, https or mailto to keep
  // its href at all.
  const urlTransform: UrlTransform = links
    ? (url, key, node) => (links.resolve(url) ? url : safeMarkdownUrlTransform(url, key, node))
    : safeMarkdownUrlTransform

  return (
    <div className="markdown-rendered">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
