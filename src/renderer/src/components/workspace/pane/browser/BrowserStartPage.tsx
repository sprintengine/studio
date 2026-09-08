import React, { useEffect, useState } from 'react'

import type { LocalServer } from '../../../../../../shared/browser'
import { EmptyState, RowButton } from '../../../ui'

// A browser tab with nowhere to go yet: the start page. Two groups, headings
// only — the rows are the explanation: the dev servers this workspace's
// terminals are running (live, polled only while this is on screen) and the
// URLs this workspace visited last. A group with nothing in it is absent; with
// one group left, so is its heading (a heading must separate something from
// something else). With nothing at all to list, the kit's empty state says
// what would fill it.

const LOCAL_SERVER_POLL_MS = 4_000

// Polls while — and only while — the surface is the one on screen: the tab
// active, the pane visible, the window not hidden. A retained background tab
// costs nothing.
function useLocalServers(workspaceId: string, active: boolean): LocalServer[] | null {
  const [servers, setServers] = useState<LocalServer[] | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: number | null = null
    const poll = async () => {
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(() => void poll(), LOCAL_SERVER_POLL_MS)
        return
      }
      try {
        const next = await window.api.browserLocalServers(workspaceId)
        if (!cancelled) setServers(next)
      } catch {
        if (!cancelled) setServers([])
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), LOCAL_SERVER_POLL_MS)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active, workspaceId])
  return servers
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}


type BrowserStartPageProps = {
  workspaceId: string
  active: boolean
  recentUrls: readonly string[]
  onOpen: (url: string) => void
}

export function BrowserStartPage({ workspaceId, active, recentUrls, onOpen }: BrowserStartPageProps) {
  const servers = useLocalServers(workspaceId, active)
  const hasServers = (servers?.length ?? 0) > 0
  const hasRecent = recentUrls.length > 0
  const showHeadings = hasServers && hasRecent

  if (!hasServers && !hasRecent) {
    return (
      <div className="h-full bg-[color:var(--bg-app)]">
        <EmptyState
          title="Nothing to open yet"
          body="Enter a URL above, or start a dev server in a terminal and it will be listed here."
        />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-[color:var(--bg-app)] px-2 py-3">
      {hasServers ? (
        <section aria-label="Local servers" className="mb-2">
          {showHeadings ? (
            <h3 className="px-3 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Local servers</h3>
          ) : null}
          {servers!.map((server) => (
            // The kit's row at the navigation rhythm — the shape the local
            // `ROW_CLASS` constant spelled, now the primitive's.
            <RowButton key={server.url} density="nav" onClick={() => onOpen(server.url)}>
              <span className="font-mono text-meta text-[color:var(--text-strong)]">localhost:{server.port}</span>
              <span className="min-w-0 truncate text-meta text-[color:var(--text-muted)]">{server.command}</span>
            </RowButton>
          ))}
        </section>
      ) : null}
      {hasRecent ? (
        <section aria-label="Recent">
          {showHeadings ? (
            <h3 className="px-3 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Recent</h3>
          ) : null}
          {recentUrls.map((url) => (
            <RowButton key={url} density="nav" onClick={() => onOpen(url)}>
              <span className="min-w-0 truncate font-mono text-meta text-[color:var(--text-default)]">{hostOf(url)}</span>
            </RowButton>
          ))}
        </section>
      ) : null}
    </div>
  )
}
