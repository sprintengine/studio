// Notifications popover rendered inside the WorkspaceTopBar's
// `account-and-settings` control group. Extracted from WorkspaceTopBar.tsx so
// the shell file keeps its at-rest control-group inventory visible and the
// popover body stays composable. Pure presentation — list and intent
// callbacks in, IPC and store mutations stay in the parent.

import React, { useMemo, useState } from 'react'
import type { AppNotification, DiagnosticLevel } from '../../../types/workspace'
import { GhostButton, LifecycleGlyph, PanelHeader, TruncatedText, type LifecycleState } from '../../ui'

type RuntimeClipboardApi = {
  clipboardWriteText?: (text: string) => Promise<void>
}

// Severity reads by shape, not a colored dot (StatusDot is deprecated). Error
// maps to the `failed` glyph (ring + "×", error tone) and warning to the
// `needs_input` glyph (ring + "!", warn tone) — the same shape-coded vocabulary
// the rest of the app shell uses. Info is the calm default and earns no mark.
const LEVEL_GLYPH: Partial<Record<DiagnosticLevel, LifecycleState>> = {
  error: 'failed',
  warning: 'needs_input',
}

// Severity filters offered in the popover header. Info has no chip — it is the
// calm default that shows when no filter is engaged.
const LEVEL_FILTERS: ReadonlyArray<{ level: DiagnosticLevel; label: string }> = [
  { level: 'error', label: 'Errors' },
  { level: 'warning', label: 'Warnings' },
]

const LEVEL_NOUN: Record<DiagnosticLevel, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
}

const LEVEL_NAME: Record<DiagnosticLevel, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
}

// Recency buckets so the list reads like an inbox instead of one undivided wall
// at Sprint Engine scale. Headings are spacing + a quiet label, never a card.
type DayBucket = 'today' | 'yesterday' | 'earlier'
const DAY_BUCKET_ORDER: DayBucket[] = ['today', 'yesterday', 'earlier']
const DAY_BUCKET_LABEL: Record<DayBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
}

const DAY_MS = 24 * 60 * 60 * 1000

function notificationDayBucket(value: string, now: Date): DayBucket {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'earlier'
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const ts = date.getTime()
  if (ts >= startOfToday) return 'today'
  if (ts >= startOfToday - DAY_MS) return 'yesterday'
  return 'earlier'
}

function formatNotificationTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

async function writeClipboardText(text: string): Promise<void> {
  const api = window.api as typeof window.api & RuntimeClipboardApi
  if (typeof api.clipboardWriteText !== 'function') throw new Error('Clipboard API is unavailable.')
  await api.clipboardWriteText(text)
}

// A fixed-width leading slot keeps every title on one optical baseline whether
// or not the row carries a severity glyph. Reserving the slot is alignment, not
// decoration — info rows stay mark-free.
function NotificationSeverityGlyph({ level }: { level: DiagnosticLevel }) {
  const glyph = LEVEL_GLYPH[level]
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden={glyph ? undefined : true}>
      {glyph ? <LifecycleGlyph state={glyph} live={false} label={LEVEL_NAME[level]} /> : null}
    </span>
  )
}

// A resolved, ready-to-run Open action for one notification. The shell builds
// these (workspace reveal + any module deep-focus); the popover stays pure and
// only renders + triggers them.
export type NotificationRowAction = {
  id: string
  label: string
  run: () => void | Promise<void>
}

export function NotificationsPopover({
  notifications,
  onMarkRead,
  onMarkAllRead,
  onClear,
  onOpenLogs,
  resolveActions,
}: {
  notifications: AppNotification[]
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onClear: () => void
  onOpenLogs: () => void
  /** Resolve a notification's Open action(s); empty when none is possible. */
  resolveActions?: (notification: AppNotification) => NotificationRowAction[]
}) {
  const [copyErrorId, setCopyErrorId] = useState<string | null>(null)
  // View-only severity filter. Empty = show everything; otherwise show only the
  // engaged levels (OR), so "Errors" and "Warnings" can be on together. Resets
  // implicitly when the popover unmounts on close.
  const [activeLevels, setActiveLevels] = useState<DiagnosticLevel[]>([])

  const toggleLevel = (level: DiagnosticLevel) =>
    setActiveLevels((prev) => (prev.includes(level) ? prev.filter((value) => value !== level) : [...prev, level]))

  const visibleNotifications =
    activeLevels.length === 0
      ? notifications
      : notifications.filter((notification) => activeLevels.includes(notification.level))

  // Bucket by recency after filtering, preserving the incoming (newest-first)
  // order within each group.
  const groups = useMemo(() => {
    const now = new Date()
    const byBucket: Record<DayBucket, AppNotification[]> = { today: [], yesterday: [], earlier: [] }
    for (const notification of visibleNotifications) {
      byBucket[notificationDayBucket(notification.timestamp, now)].push(notification)
    }
    return DAY_BUCKET_ORDER.map((bucket) => ({ bucket, items: byBucket[bucket] })).filter(
      (group) => group.items.length > 0
    )
  }, [visibleNotifications])

  const emptyMessage =
    notifications.length === 0
      ? 'No notifications'
      : `No ${activeLevels.map((level) => LEVEL_NOUN[level]).join(' or ')} notifications`

  const copyNotification = async (notification: AppNotification) => {
    const details = [
      `[${notification.level.toUpperCase()}] ${notification.title}`,
      notification.message,
      notification.details,
      notification.workspaceName ? `Workspace: ${notification.workspaceName}` : null,
      notification.agentId ? `Agent: ${notification.agentId}` : null,
      notification.sessionId ? `Session: ${notification.sessionId}` : null,
      notification.logPath ? `Log: ${notification.logPath}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    try {
      await writeClipboardText(details)
      setCopyErrorId(null)
    } catch {
      setCopyErrorId(notification.id)
      return
    }
    onMarkRead(notification.id)
  }

  const openLogsForNotification = (notification: AppNotification) => {
    onMarkRead(notification.id)
    onOpenLogs()
  }

  return (
    <div className="w-[480px] overflow-hidden">
      {/* The panel identity row (2112). It was an `h-10` band with its own type
          step, sitting beside AttentionQueuePopover — the popover directly next
          to it in the same control group — which already named itself through
          the primitive. Every control here is secondary to the name, so the
          whole cluster rides `overflow`; `primaryAction` is one action. */}
      <PanelHeader
        title="Notifications"
        count={visibleNotifications.length > 0 ? visibleNotifications.length : undefined}
        overflow={
          <>
            {notifications.length > 0 ? (
              <>
                {LEVEL_FILTERS.map(({ level, label }) => {
                  const active = activeLevels.includes(level)
                  const glyph = LEVEL_GLYPH[level]
                  return (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={active}
                      aria-label={active ? `Showing only ${LEVEL_NOUN[level]} notifications` : `Show only ${LEVEL_NOUN[level]} notifications`}
                      onClick={() => toggleLevel(level)}
                      className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-micro font-semibold transition-colors ${
                        active
                          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                      }`}
                    >
                      {glyph ? <LifecycleGlyph state={glyph} live={false} /> : null}
                      {label}
                    </button>
                  )
                })}
                <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[color:var(--border-default)]" />
              </>
            ) : null}
            <GhostButton size="xs" onClick={onOpenLogs}>
              Logs
            </GhostButton>
            {notifications.length > 0 ? (
              <>
                <GhostButton size="xs" onClick={onMarkAllRead}>
                  Mark read
                </GhostButton>
                <GhostButton size="xs" onClick={onClear}>
                  Clear
                </GhostButton>
              </>
            ) : null}
          </>
        }
      />

      {visibleNotifications.length === 0 ? (
        <div className="px-3 py-4 text-body text-[color:var(--text-disabled)]">{emptyMessage}</div>
      ) : (
        <div className="max-h-[440px] overflow-y-auto p-1">
          {groups.map((group) => (
            // A recency bucket, named for assistive tech. The surface is a
            // `dialog` popover, not a menu: a notification carries its own
            // Copy / Open logs buttons, so it was never activatable as one row
            // and `role="menuitem"` on it announced a control that does not
            // exist (ripple review, 2026-08-05).
            <div key={group.bucket} role="group" aria-label={DAY_BUCKET_LABEL[group.bucket]}>
              <div
                aria-hidden="true"
                className="px-2.5 pb-1 pt-2 text-micro font-medium text-[color:var(--text-muted)]"
              >
                {DAY_BUCKET_LABEL[group.bucket]}
              </div>
              {group.items.map((notification) => {
                const rowActions = resolveActions?.(notification) ?? []
                return (
                <div
                  key={notification.id}
                  className={`rounded px-2.5 py-2.5 ${
                    notification.read
                      ? 'text-[color:var(--text-muted)]'
                      : 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-default)]'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <NotificationSeverityGlyph level={notification.level} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <TruncatedText as="div" text={notification.title} className="text-body font-semibold text-[color:var(--text-strong)]" />
                        <div className="shrink-0 tabular-nums text-micro text-[color:var(--text-disabled)]">
                          {formatNotificationTime(notification.timestamp)}
                        </div>
                      </div>
                      <div className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">
                        {notification.message}
                      </div>
                      {notification.workspaceName || notification.agentId || notification.sessionId ? (
                        <TruncatedText
                          as="div"
                          text={[notification.workspaceName, notification.agentId, notification.sessionId]
                            .filter(Boolean)
                            .join(' / ')}
                          className="mt-1 font-mono text-micro text-[color:var(--text-disabled)]"
                        />
                      ) : null}
                      <div className="mt-2 flex items-center gap-1.5">
                        {rowActions.map((action) => (
                          <button
                            key={action.id}
                            type="button"
                            onClick={() => {
                              onMarkRead(notification.id)
                              void action.run()
                            }}
                            className="rounded border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-micro font-semibold text-[color:var(--text-default)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                          >
                            {action.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => void copyNotification(notification)}
                          className="rounded border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-micro font-semibold text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                        >
                          Copy
                        </button>
                        {copyErrorId === notification.id ? (
                          <span
                            role="status"
                            aria-live="polite"
                            className="text-micro font-semibold text-[color:var(--tone-error)]"
                          >
                            Could not copy
                          </span>
                        ) : null}
                        {notification.logPath ? (
                          <button
                            type="button"
                            onClick={() => openLogsForNotification(notification)}
                            className="rounded border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-micro font-semibold text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                          >
                            Open logs
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
