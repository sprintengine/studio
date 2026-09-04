import React, { useEffect, useState } from 'react'

import type { LocalServer } from '../../../../../../shared/browser'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'

// A browser tab with nowhere to go yet. Two groups, headings only — the rows
// are the explanation: the dev servers this workspace's terminals are running
// (live, polled only while this is on screen) and the URLs this workspace
// visited last. A group with nothing in it is absent; with one group left, so
// is its heading (a heading must separate something from something else).

const LOCAL_SERVER_POLL_MS = 4_000

function useLocalServers(workspaceId: string): LocalServer[] | null {
  const [servers, setServers] = useState<LocalServer[] | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const poll = async () => {
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
  }, [workspaceId])
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

const ROW_CLASS = `flex h-control-sm w-full items-center gap-3 rounded-[7px] px-3 text-left hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`

type BrowserEmptyStateProps = {
  workspaceId: string
  recentUrls: readonly string[]
  onOpen: (url: string) => void
}

export function BrowserEmptyState({ workspaceId, recentUrls, onOpen }: BrowserEmptyStateProps) {
  const servers = useLocalServers(workspaceId)
  const hasServers = (servers?.length ?? 0) > 0
  const hasRecent = recentUrls.length > 0
  const showHeadings = hasServers && hasRecent

  if (!hasServers && !hasRecent) {
    // Nothing to offer yet: the address field above is the whole affordance.
    return <div className="h-full bg-[color:var(--bg-app)]" />
  }

  return (
    <div className="h-full overflow-y-auto bg-[color:var(--bg-app)] px-2 py-3">
      {hasServers ? (
        <section aria-label="Local servers" className="mb-2">
          {showHeadings ? (
            <h3 className="px-3 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Local servers</h3>
          ) : null}
          {servers!.map((server) => (
            <button key={server.url} type="button" onClick={() => onOpen(server.url)} className={ROW_CLASS}>
              <span className="font-mono text-meta text-[color:var(--text-strong)]">localhost:{server.port}</span>
              <span className="min-w-0 truncate text-meta text-[color:var(--text-muted)]">
                {server.command}
                {server.terminalId ? ' · Terminal' : ' · Agent'}
              </span>
            </button>
          ))}
        </section>
      ) : null}
      {hasRecent ? (
        <section aria-label="Recent">
          {showHeadings ? (
            <h3 className="px-3 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Recent</h3>
          ) : null}
          {recentUrls.map((url) => (
            <button key={url} type="button" onClick={() => onOpen(url)} className={ROW_CLASS}>
              <span className="min-w-0 truncate font-mono text-meta text-[color:var(--text-default)]">{hostOf(url)}</span>
            </button>
          ))}
        </section>
      ) : null}
    </div>
  )
}
