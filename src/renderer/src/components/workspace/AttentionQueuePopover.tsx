import { useMemo } from 'react'

import { WorkspaceTypeIcon } from '../AppIcons'
import { InboxRow, LIFECYCLE_LABEL, LifecycleGlyph, PanelHeader, Popover, Tooltip, TruncatedText } from '../ui'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import type { AttentionQueueBadge } from '../../utils/attentionQueue'
import type { SessionItem } from './WorkspaceActions'

// The title-bar Attention Queue: the global "which agents are waiting on me"
// surface across ALL workspaces. The trigger lives on the app title strip; the
// popover lists the needs-input / failed agents
// (data + ordering from utils/attentionQueue), grouped by workspace and
// attention-first. It only surfaces and routes — opening a row activates that
// workspace and focuses the agent so the user answers/relaunches at the terminal.
// Rows hosted in another window render disabled, mirroring the Sprints rail.

export type AttentionQueueSurface = {
  items: SessionItem[]
  badge: AttentionQueueBadge
  open: boolean
  onOpenChange: (open: boolean) => void
  // Workspaces routed to THIS window. openSession silently no-ops for a workspace
  // hosted elsewhere, so those rows render disabled instead of swallowing a click.
  windowWorkspaceIds: ReadonlySet<string>
  activeWorkspaceId: string | null
  onOpenItem: (item: SessionItem) => void | Promise<void>
}

// Per-tone badge fill. attentionQueueBadge already collapses "nothing waiting"
// to a null tone, so this only ever maps the two live attention tones.
const BADGE_TONE_VAR: Record<'warn' | 'error', string> = {
  warn: 'var(--tone-warn)',
  error: 'var(--tone-error)',
}

function triggerAriaLabel(count: number): string {
  if (count === 0) return 'Attention queue — all caught up'
  return `Attention queue — ${count} ${count === 1 ? 'agent' : 'agents'} waiting`
}

// Honest status + recency carried in text so the glyph shape can stay the status
// idiom and the row never reads "failed" by colour alone. Ticks with `now`.
function attentionStatusMeta(item: SessionItem, now: number): string {
  if (item.status === 'failed') {
    return `Exit ${item.exitCode ?? 1} · ${formatRelativeMsAgo(item.activitySince, now)}`
  }
  const rel = formatRelativeMs(item.activitySince, now)
  return rel ? `Needs input · waiting ${rel}` : 'Needs input'
}

// Group the already-attention-sorted items by their bucket in first-encounter
// order. Because `items` arrives globally attention-first (needs-input before
// failed, recent first), the most-urgent agent's workspace leads, and each group
// keeps that ordering internally — so grouping never reshuffles the priority.
// Detached buckets (sessions no workspace row claims) trail every workspace,
// matching the sessions popover; their rows keep the same internal order, so
// nothing is hidden — only placed last.
export function groupBySessionGroup(
  items: SessionItem[],
): Array<{ group: SessionItem['group']; items: SessionItem[] }> {
  const groups: Array<{ group: SessionItem['group']; items: SessionItem[] }> = []
  for (const item of items) {
    const group = groups.find((candidate) => candidate.group.id === item.group.id)
    if (group) group.items.push(item)
    else groups.push({ group: item.group, items: [item] })
  }
  return groups.sort((a, b) => Number(a.group.kind === 'detached') - Number(b.group.kind === 'detached'))
}

function AttentionQueueIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      {/* Inbox tray: a lid funnel over a tray with the canonical centre notch. */}
      <path
        d="M2.75 9.25 4.4 4.1a1 1 0 0 1 .95-.7h5.3a1 1 0 0 1 .95.7l1.65 5.15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.75 9.25h2.6l.7 1.3a1 1 0 0 0 .88.52h1.84a1 1 0 0 0 .88-.52l.7-1.3h2.6v2.4a1.1 1.1 0 0 1-1.1 1.1H3.85a1.1 1.1 0 0 1-1.1-1.1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function AttentionQueuePopover({
  items,
  badge,
  open,
  onOpenChange,
  windowWorkspaceIds,
  activeWorkspaceId,
  onOpenItem,
}: AttentionQueueSurface) {
  // Re-render every 30s so the relative status meta ("waiting 4m") stays fresh
  // while the popover is open. Gated on `open` so the always-mounted trigger
  // doesn't run an idle tick while the popover is closed.
  const now = useRelativeNow(30_000, open)
  const groups = useMemo(() => groupBySessionGroup(items), [items])

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Attention queue"
      popupRole="dialog"
      placement="bottom-end"
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <Tooltip content="Attention queue" placement="bottom">
          <button
            ref={ref}
            type="button"
            onClick={togglePopover}
            aria-pressed={open}
            aria-label={triggerAriaLabel(badge.count)}
            className={`app-no-drag interactive relative inline-flex h-7 w-7 items-center justify-center bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
              open
                ? 'text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]'
            }`}
            {...triggerProps}
          >
            <AttentionQueueIcon className="icon-sm" />
            {badge.tone ? (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[color:var(--bg-surface)] px-1 text-micro font-bold leading-none tabular-nums text-[color:var(--bg-app)]"
                style={{ backgroundColor: BADGE_TONE_VAR[badge.tone] }}
              >
                {badge.count > 99 ? '99+' : badge.count}
              </span>
            ) : null}
          </button>
        </Tooltip>
      )}
    >
      <div className="w-[340px] overflow-hidden rounded-[7px]">
        <PanelHeader
          title="Awaiting you"
          subtitle="All workspaces"
          count={badge.count > 0 ? badge.count : undefined}
        />
        {groups.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <div className="text-[13px] font-semibold text-[color:var(--text-strong)]">
              All caught up
            </div>
            <p className="mt-1 text-[12px] text-[color:var(--text-muted)]">
              No agents are waiting on you right now.
            </p>
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto py-1">
            {groups.map((group) => (
              <div key={group.group.id} className="py-0.5">
                <div className="flex items-center gap-2 px-3 pb-1 pt-1.5 text-[11px] font-semibold text-[color:var(--text-subtle)]">
                  {group.group.kind === 'workspace' ? (
                    <WorkspaceTypeIcon mode={group.group.workspace.mode} className="h-3.5 w-3.5 shrink-0" />
                  ) : null}
                  <TruncatedText as="span" text={group.group.label} className="min-w-0" />
                </div>
                {group.items.map((item) => {
                  // A detached session belongs to no workspace, so no window can
                  // route to it: the row stays visible and states its status, but
                  // opening it is not something this surface can do. Stopping it
                  // lives in the sessions popover, which acts on the process.
                  const detached = item.group.kind === 'detached'
                  const inWindow = !detached && windowWorkspaceIds.has(item.group.id)
                  const state = item.status === 'failed' ? 'failed' : 'needs_input'
                  const statusMeta = attentionStatusMeta(item, now)
                  const supporting = detached || inWindow ? statusMeta : 'Open in another window'
                  return (
                    <InboxRow
                      key={item.sessionId}
                      leading={<LifecycleGlyph state={state} label={LIFECYCLE_LABEL[state]} />}
                      title={item.label}
                      supporting={supporting}
                      selected={inWindow && item.group.id === activeWorkspaceId}
                      disabled={!inWindow}
                      ariaLabel={
                        detached
                          ? `${item.label} — ${statusMeta}, not open in a workspace`
                          : inWindow
                            ? `${item.label} — ${statusMeta}`
                            : `${item.label} — ${LIFECYCLE_LABEL[state]}, open in another window`
                      }
                      onSelect={() => {
                        onOpenChange(false)
                        void onOpenItem(item)
                      }}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </Popover>
  )
}
