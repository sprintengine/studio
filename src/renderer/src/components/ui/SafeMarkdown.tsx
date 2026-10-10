import React from 'react'

import { copyToClipboardWithToast } from '../../utils/copyToClipboardWithToast'
import { markdownRootProps, renderMarkdown } from '../../utils/markdown'
import { LinkButton } from './LinkButton'
import { FOCUS_RING_CLASS } from './tokens'

// Agent-written Markdown, drawn the way a chat reply is drawn and never able to
// reach outside its box. The text is untrusted by definition — a model wrote
// it, often from content it fetched — so this is the chat's renderer
// (`utils/markdown.tsx`) in one fixed, safe configuration rather than a second
// parser a module would otherwise write for itself:
//
//   - Raw HTML is never rendered. The renderer runs no HTML pass at all, so a
//     `<script>`, an `<iframe>` or an `onerror=` attribute comes out as the
//     escaped text the agent wrote, never as an element, and nothing here
//     touches `dangerouslySetInnerHTML`.
//   - A link survives only as http(s). `javascript:`, `data:`, `file:` and every
//     other scheme render as their label in plain text. `mailto:` too: a mail
//     link is not something agent text needs to be able to open. So does a
//     `#heading` link, which a chat reply would follow in place: `links`
//     speaks only of web links, and `none` has to mean no control at all.
//   - An image is never fetched: loading one would send a request to a host the
//     text chose before anyone had read it. It renders as a quiet chip naming
//     the picture.
//   - `links` decides what a web link does. `open` is the chat's own path: an
//     anchor with `target="_blank"`, which the app's window hands to the
//     system browser and never navigates the window itself (main's
//     privileged-window guard). `copy` copies the address instead; `none`
//     leaves the label as text.

export type SafeMarkdownLinks = 'open' | 'copy' | 'none'

export type SafeMarkdownProps = {
  /** The Markdown source. GitHub-flavoured: tables, task lists, alerts. */
  text: string
  /** What a web link does. Defaults to `open` (the system browser). */
  links?: SafeMarkdownLinks
  /** One type step down, for Markdown inside a card whose own title is already
   *  the top of the hierarchy. */
  compact?: boolean
  className?: string
}

const LINK_CLASS =
  'text-[color:var(--accent-primary)] underline underline-offset-2 hover:text-[color:var(--accent-primary-hover)]'

/** The address a link may keep: an absolute http(s) URL, or nothing. */
export function safeWebUrl(href: string): string | null {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function renderSafeLink(links: SafeMarkdownLinks, href: string, label: React.ReactNode): React.ReactNode {
  const url = safeWebUrl(href)
  if (!url || links === 'none') return <span>{label}</span>
  if (links === 'copy') {
    return (
      <LinkButton
        ink="accent"
        underline="always"
        size="inherit"
        aria-label={`Copy link: ${url}`}
        onClick={() => void copyToClipboardWithToast(url)}
      >
        {label}
      </LinkButton>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={`${LINK_CLASS} ${FOCUS_RING_CLASS}`}>
      {label}
    </a>
  )
}

function renderImageChip(_src: string, alt: string): React.ReactNode {
  return (
    <span className="inline-block rounded-xs border border-[color:var(--border-subtle)] px-[0.35em] text-[0.9em] text-[color:var(--text-muted)]">
      {alt ? `Image: ${alt}` : 'Image'}
    </span>
  )
}

export function SafeMarkdown({ text, links = 'open', compact = false, className }: SafeMarkdownProps) {
  const density = compact ? 'chat-compact' : 'chat'
  // Stable per `links`, so a re-render with the same policy keeps the
  // renderer's component types — recreating them remounts every block.
  const renderLink = React.useCallback(
    (href: string, label: React.ReactNode) => renderSafeLink(links, href, label),
    [links],
  )
  const root = markdownRootProps({ density })
  return (
    <div {...root} className={className ? `${root.className} ${className}` : root.className}>
      {renderMarkdown(text, { density, bare: true, renderLink, renderImage: renderImageChip, inPageLinks: false })}
    </div>
  )
}
