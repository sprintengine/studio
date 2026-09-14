import React, { useEffect, useState } from 'react'

import type { LocalServer } from '../../../../../../shared/browser'
import { showToast } from '../../../../store/toastStore'
import { EmptyState, IconButton, RowButton } from '../../../ui'
import { useTailnetShares } from './useTailnetShares'

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

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A globe for "publish on the tailnet", a struck globe for "stop", a pair of
// sheets for "copy link".
const SHARE = 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM1.5 8h13M8 1.5c1.7 1.8 2.6 4.1 2.6 6.5S9.7 12.7 8 14.5C6.3 12.7 5.4 10.4 5.4 8S6.3 3.3 8 1.5Z'
const UNSHARE = 'M13.5 2.5l-11 11M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM1.5 8h13'
const COPY = 'M5.5 5.5V3.5h7v7h-2M3.5 5.5h7v7h-7v-7Z'

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
  // Shares are polled on the same cadence and under the same "only while
  // someone is looking" rule as the servers they annotate.
  const shares = useTailnetShares(active, LOCAL_SERVER_POLL_MS)
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
          {servers!.map((server) => {
            const sharedUrl = shares.urlFor(server.port)
            const busy = shares.busyPort === server.port
            return (
              // The row is the `<button>`, so its actions cannot nest inside it
              // (invalid HTML; breaks Safari and JAWS). The host wraps both and
              // positions the actions over the row's reserved trailing padding,
              // per the list-row spec's action-host rule.
              <div key={server.url} className="group/server relative">
                {/* The kit's row at the navigation rhythm — the shape the local
                    `ROW_CLASS` constant spelled, now the primitive's. */}
                <RowButton density="nav" className="pr-16" onClick={() => onOpen(server.url)}>
                  <span className="font-mono text-meta text-[color:var(--text-strong)]">localhost:{server.port}</span>
                  <span className="min-w-0 truncate text-meta text-[color:var(--text-muted)]">{server.command}</span>
                  {sharedUrl ? (
                    // Shared state is words, not colour alone: the row says so.
                    <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">On tailnet</span>
                  ) : null}
                </RowButton>
                <div
                  className={[
                    'absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5',
                    // Revealed on reach, but always in the tab order: an action
                    // that only exists on hover is unreachable by keyboard.
                    'opacity-0 transition-opacity group-hover/server:opacity-100 group-focus-within/server:opacity-100',
                    'focus-within:opacity-100',
                    sharedUrl ? 'opacity-100' : '',
                  ].join(' ')}
                >
                  {sharedUrl ? (
                    <IconButton
                      size="3xs"
                      aria-label={`Copy the tailnet link for localhost:${server.port}`}
                      onClick={() => {
                        void navigator.clipboard.writeText(sharedUrl)
                        showToast({ tone: 'good', title: 'Tailnet link copied' })
                      }}
                    >
                      <Glyph d={COPY} />
                    </IconButton>
                  ) : null}
                  <IconButton
                    size="3xs"
                    disabled={busy}
                    aria-label={
                      sharedUrl
                        ? `Stop sharing localhost:${server.port} on the tailnet`
                        : `Share localhost:${server.port} on the tailnet`
                    }
                    onClick={() => {
                      void (async () => {
                        if (sharedUrl) {
                          const result = await shares.unshare(server.port)
                          showToast(
                            result.ok
                              ? { tone: 'good', title: `localhost:${server.port} is off the tailnet` }
                              : { tone: 'error', title: 'Could not stop sharing', description: result.message }
                          )
                          return
                        }
                        const result = await shares.share(server.port)
                        showToast(
                          result.ok && result.url
                            ? { tone: 'good', title: 'Shared on your tailnet', description: result.url }
                            : { tone: 'error', title: 'Could not share this server', description: result.message }
                        )
                      })()
                    }}
                  >
                    <Glyph d={sharedUrl ? UNSHARE : SHARE} />
                  </IconButton>
                </div>
              </div>
            )
          })}
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
