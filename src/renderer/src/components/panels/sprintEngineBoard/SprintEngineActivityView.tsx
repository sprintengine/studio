import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { DefinitionList, InboxRow, InboxSearchInput, Section, SidePane, StatusDot } from '../../ui'
import type { Tone } from '../../ui'
import { isEditableTarget } from '../../../utils/keyboard'
import { formatRelativeTime, formatTimestamp } from '../../../utils/time'
import type { AppNotification } from '../../../types/workspace'
import { SprintEngineEmptyDetail } from './SprintEngineEmptyDetail'

// Activity tab: the run's supervisor feed (auto-run start/stop + reason,
// all-tasks-done, folder-missing, agent-terminal-closed). It is the home for
// the count that used to sit orphaned on the settings gear — the number now
// opens exactly this list. Two-pane chrome mirrors the Inbox view so the panel
// reads consistently; severity rides the per-row dot (the one status idiom),
// never a tinted badge, so an `info` event like "all tasks done" no longer
// reads as an alert.

function activityTone(level: AppNotification['level']): Tone {
  if (level === 'error') return 'error'
  if (level === 'warning') return 'warn'
  return 'accent'
}

function ActivityDetail({ notification }: { notification: AppNotification }) {
  const detailItems = [
    { term: 'Level', description: notification.level },
    notification.agentId ? { term: 'Agent', description: notification.agentId } : null,
    notification.taskId ? { term: 'Task', description: notification.taskId } : null,
    { term: 'Logged', description: formatTimestamp(notification.timestamp) },
  ].filter((item): item is { term: string; description: string } => item !== null)

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Activity detail">
      <header className="shrink-0 border-b border-[color:var(--border-default)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <StatusDot tone={activityTone(notification.level)} label={`Level: ${notification.level}`} />
          <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-[color:var(--text-strong)]">
            {notification.title}
          </h3>
          <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-muted)]">
            {formatRelativeTime(notification.timestamp)}
          </span>
        </div>
        {notification.workspaceName ? (
          <div className="mt-1 truncate font-mono text-[10px] text-[color:var(--text-disabled)]">
            {notification.workspaceName}
          </div>
        ) : null}
      </header>
      <div className="overflow-y-auto px-3 py-3">
        <p className="text-[12.5px] leading-[1.55] text-[color:var(--text-default)]">
          {notification.message}
        </p>
        {notification.details ? (
          <p className="mt-2 whitespace-pre-wrap text-[12px] leading-[1.5] text-[color:var(--text-muted)]">
            {notification.details}
          </p>
        ) : null}
        <DefinitionList layout="two-column" className="mt-4" items={detailItems} />
      </div>
    </section>
  )
}

export function SprintEngineActivityView({
  activity,
  onMarkRead,
  onMarkAllRead,
  onClear,
}: {
  activity: AppNotification[]
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onClear: () => void
}) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return activity
    return activity.filter((notification) => {
      const haystack = [notification.title, notification.message, notification.agentId, notification.taskId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  }, [activity, search])

  const unreadCount = useMemo(() => activity.filter((n) => !n.read).length, [activity])

  // Drop a selection the search has filtered out so the detail pane never shows
  // a row that isn't in the list.
  useEffect(() => {
    if (selectedId && !visible.some((n) => n.id === selectedId)) {
      setSelectedId(null)
    }
  }, [selectedId, visible])

  const select = useCallback(
    (id: string) => {
      setSelectedId(id)
      onMarkRead(id)
    },
    [onMarkRead],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return
      if (visible.length === 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const currentIndex = selectedId ? visible.findIndex((n) => n.id === selectedId) : -1
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex =
          currentIndex === -1
            ? event.key === 'ArrowDown'
              ? 0
              : visible.length - 1
            : (currentIndex + delta + visible.length) % visible.length
        select(visible[nextIndex].id)
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        select(visible[0].id)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        select(visible[visible.length - 1].id)
        return
      }
      if (event.key === 'Escape' && selectedId) {
        event.preventDefault()
        setSelectedId(null)
      }
    },
    [visible, selectedId, select],
  )

  const selected = selectedId ? visible.find((n) => n.id === selectedId) ?? null : null
  const filteringActive = search.trim().length > 0
  const emptyMessage =
    filteringActive && activity.length > 0
      ? 'No activity matches the current search.'
      : 'No run activity yet. Auto-run starts, stops, and mode changes appear here with the reason for each.'

  return (
    <div className="flex min-h-0 flex-1 min-w-0">
      <SidePane as="section" side="left" width="lg" ariaLabel="Run activity">
        <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
          <InboxSearchInput value={search} onChange={setSearch} ariaLabel="Search run activity" />
          {activity.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onMarkAllRead}
                disabled={unreadCount === 0}
                className="rounded px-2 py-1 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Mark read
              </button>
              <button
                type="button"
                onClick={onClear}
                className="rounded px-2 py-1 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                Clear
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col overflow-auto">
          <div
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="focus:outline-none"
            role="region"
            aria-label="Run activity (use arrow keys)"
          >
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-[12px] leading-5 text-[color:var(--text-muted)]">
                {emptyMessage}
              </div>
            ) : (
              <Section title="Run activity" count={unreadCount > 0 ? unreadCount : undefined} level={3} inset={false}>
                <ul>
                  {visible.map((notification) => (
                    <li key={notification.id}>
                      <InboxRow
                        tone={activityTone(notification.level)}
                        title={notification.title}
                        supporting={notification.message}
                        trailing={formatRelativeTime(notification.timestamp)}
                        selected={selectedId === notification.id}
                        onSelect={() => select(notification.id)}
                        ariaLabel={`${notification.title}${notification.read ? '' : ', unread'}`}
                      />
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        </div>
      </SidePane>

      {selected ? (
        <ActivityDetail notification={selected} />
      ) : (
        <SprintEngineEmptyDetail
          message={
            activity.length > 0
              ? 'Pick an event on the left to see its full message and the reason behind it.'
              : 'The supervisor logs auto-run starts, stops, and mode changes here. Start auto-run from the run overflow to begin.'
          }
        />
      )}
    </div>
  )
}
