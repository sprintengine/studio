import { useCallback, useEffect, useRef, useState } from 'react'

import { InlineNotice, Section, Tooltip } from '../ui'
import type { BacklogItem, BacklogResolvedLink } from '../../utils/backlog'
import {
  backlogLinkControlModel,
  openBacklogLink,
  syncBacklogItemLinks,
} from '../../utils/backlogLinks'
import type { BacklogLinkProvider } from '../../modules/renderer-host'

// Provider-backed Backlog link surface for the detail pane, kept out of the
// already-large Backlog panel so the link resolution/opening state machine and
// the link renderer live behind one clear concept boundary. The section resolves
// the item's links through enabled providers on selection and on every rescan,
// persists changed live + derived item status through the Backlog service, and
// renders the links the caller has not already promoted to a primary action.

// Resolve the item's provider-backed links and persist any changed live status.
// `unknown` resolutions render but never persist, so a transient unreadable run
// cannot clobber a stored status, and resolve failures degrade to read-only
// stored links rather than an empty list. Re-runs whenever the item identity
// changes (manual refresh rebuilds the item), so scan/refresh both re-resolve.
function useResolvedBacklogItemLinks(input: {
  item: BacklogItem
  workspaceId: string
  workspaceRoot: string
  providers: ReadonlyArray<BacklogLinkProvider>
}): {
  resolvedLinks: BacklogResolvedLink[] | null
  linkError: string | null
  openLink: (link: BacklogResolvedLink) => Promise<void>
} {
  const { item, workspaceId, workspaceRoot, providers } = input
  const [resolvedLinks, setResolvedLinks] = useState<BacklogResolvedLink[] | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const tokenRef = useRef(0)

  useEffect(() => {
    const token = ++tokenRef.current
    setLinkError(null)
    if (item.links.length === 0) {
      setResolvedLinks([])
      return
    }
    // Drop the previous item's resolved links immediately so the section falls
    // back to this item's stored links until the async resolve lands.
    setResolvedLinks(null)
    void (async () => {
      try {
        const { links, persistError } = await syncBacklogItemLinks({
          workspaceId,
          workspaceRoot,
          item,
          providers,
          persistLink: (args) => window.api.addOrUpdateBacklogLink(args),
        })
        if (token !== tokenRef.current) return
        setResolvedLinks(links)
        if (persistError) setLinkError(persistError)
      } catch (error) {
        if (token !== tokenRef.current) return
        setResolvedLinks(item.links.map((link) => ({ ...link, status: link.status ?? 'unknown', canOpen: false })))
        setLinkError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [item, workspaceId, workspaceRoot, providers])

  const openLink = useCallback(
    async (link: BacklogResolvedLink) => {
      setLinkError(null)
      try {
        const opened = await openBacklogLink({ workspaceId, workspaceRoot, item, link, providers })
        if (!opened) {
          setLinkError(`Couldn’t open ${link.label}. The linked target is unavailable.`)
        }
      } catch (error) {
        setLinkError(error instanceof Error ? error.message : String(error))
      }
    },
    [item, workspaceId, workspaceRoot, providers],
  )

  return { resolvedLinks, linkError, openLink }
}

export function BacklogLinksSection({
  item,
  workspaceId,
  workspaceRoot,
  providers,
  excludeLinkId,
}: {
  item: BacklogItem
  workspaceId: string
  workspaceRoot: string
  providers: ReadonlyArray<BacklogLinkProvider>
  // A link the caller has already promoted to a primary action (e.g. the
  // primary Open Sprint Engine run), so it is not duplicated as a secondary
  // control here. Null keeps every link visible.
  excludeLinkId: string | null
}): JSX.Element | null {
  const { resolvedLinks, linkError, openLink } = useResolvedBacklogItemLinks({
    item,
    workspaceId,
    workspaceRoot,
    providers,
  })

  const secondaryLinks = (
    resolvedLinks
    ?? item.links.map((link) => ({ ...link, status: link.status ?? 'unknown', canOpen: false }))
  ).filter((link) => link.id !== excludeLinkId)

  if (secondaryLinks.length === 0 && !linkError) return null

  return (
    <Section title="Links" level={4} inset className="shrink-0 border-b border-[color:var(--border-subtle)] pb-2">
      {linkError ? (
        <div className="px-3 pb-1.5">
          <InlineNotice tone="warn">{linkError}</InlineNotice>
        </div>
      ) : null}
      {secondaryLinks.length > 0 ? (
        <ul className="flex flex-col gap-0.5 px-3">
          {secondaryLinks.map((link) => (
            <BacklogLinkControl key={link.id} link={link} onOpen={openLink} />
          ))}
        </ul>
      ) : null}
    </Section>
  )
}

// One Backlog link row. An enabled provider that can open the target renders a
// real, keyboard-focusable button; an unknown or unavailable link renders as a
// focusable, non-actionable note whose reason is reachable by hover and by
// keyboard. Either way a visible status word carries the state without relying
// on color, and the Tooltip primitive carries the longer target/reason detail.
function BacklogLinkControl({
  link,
  onOpen,
}: {
  link: BacklogResolvedLink
  onOpen: (link: BacklogResolvedLink) => void
}): JSX.Element {
  const model = backlogLinkControlModel(link)
  return (
    <li className="flex min-w-0 items-center gap-2">
      {model.canOpen ? (
        <Tooltip content={model.detail} placement="top" wrapperClassName="inline-flex min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onOpen(link)}
            className="interactive inline-flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            <span className="min-w-0 truncate">{model.label}</span>
            <OpenLinkGlyph />
          </button>
        </Tooltip>
      ) : (
        <Tooltip content={model.detail} placement="top" wrapperClassName="inline-flex min-w-0 flex-1">
          <span
            tabIndex={0}
            role="note"
            aria-label={`${model.label}: ${model.statusText}. ${model.detail}`}
            className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[12px] text-[color:var(--text-disabled)] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
          >
            {model.label}
          </span>
        </Tooltip>
      )}
      <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">{model.statusText}</span>
    </li>
  )
}

function OpenLinkGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-subtle)]" aria-hidden="true">
      <path d="M6 4h6v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.5 4.5L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
