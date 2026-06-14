// Notifications popover rendered inside the WorkspaceTopBar's
// `account-and-settings` control group. Extracted from WorkspaceTopBar.tsx so
// the shell file keeps its at-rest control-group inventory visible and the
// popover body stays composable. Pure presentation — list and intent
// callbacks in, IPC and store mutations stay in the parent.

import React, { useState } from 'react'
import type { AppNotification, DiagnosticLevel } from '../../../types/workspace'
import { StatusDot } from '../../ui'
import type { Tone } from '../../ui/tokens'

type RuntimeClipboardApi = {
  clipboardWriteText?: (text: string) => Promise<void>
}

// Severity filters offered in the popover header. Info has no chip — it is the
// calm default that shows when no filter is engaged. Tones match the per-row
// status dot so the chip and the rows it reveals read as one vocabulary.
const LEVEL_FILTERS: ReadonlyArray<{ level: DiagnosticLevel; label: string; tone: Tone }> = [
  { level: 'error', label: 'Errors', tone: 'error' },
  { level: 'warning', label: 'Warnings', tone: 'warn' },
]

const LEVEL_NOUN: Record<DiagnosticLevel, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
}

function statusToneForLevel(level: DiagnosticLevel): Tone {
  return level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'accent'
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

export function NotificationsPopover({
  notifications,
  onMarkRead,
  onMarkAllRead,
  onClear,
  onOpenLogs,
}: {
  notifications: AppNotification[]
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onClear: () => void
  onOpenLogs: () => void
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

  return (
    <div className="w-[480px] overflow-hidden">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-[color:var(--border-default)] px-3">
        <span className="shrink-0 text-[12px] font-semibold text-[color:var(--text-strong)]">Notifications</span>
        <div className="flex shrink-0 items-center gap-1">
          {notifications.length > 0 ? (
            <>
              {LEVEL_FILTERS.map(({ level, label, tone }) => {
                const active = activeLevels.includes(level)
                return (
                  <button
                    key={level}
                    type="button"
                    aria-pressed={active}
                    aria-label={active ? `Showing only ${LEVEL_NOUN[level]} notifications` : `Show only ${LEVEL_NOUN[level]} notifications`}
                    onClick={() => toggleLevel(level)}
                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold transition-colors ${
                      active
                        ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                        : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                    }`}
                  >
                    <StatusDot tone={tone} />
                    {label}
                  </button>
                )
              })}
              <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[color:var(--border-default)]" />
            </>
          ) : null}
          <button
            type="button"
            onClick={onOpenLogs}
            className="rounded px-2 py-1 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Logs
          </button>
          {notifications.length > 0 ? (
            <>
              <button
                type="button"
                onClick={onMarkAllRead}
                className="rounded px-2 py-1 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                Mark read
              </button>
              <button
                type="button"
                onClick={onClear}
                className="rounded px-2 py-1 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                Clear
              </button>
            </>
          ) : null}
        </div>
      </div>

      {visibleNotifications.length === 0 ? (
        <div className="px-3 py-4 text-[13px] text-[color:var(--text-disabled)]">{emptyMessage}</div>
      ) : (
        <div className="max-h-[440px] overflow-y-auto p-1">
          {visibleNotifications.map((notification) => (
            <div
              key={notification.id}
              role="menuitem"
              className={`rounded px-2.5 py-2.5 ${
                notification.read
                  ? 'text-[color:var(--text-muted)]'
                  : 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-default)]'
              }`}
              onMouseEnter={() => {
                if (!notification.read) onMarkRead(notification.id)
              }}
            >
              <div className="flex items-start gap-2">
                <StatusDot tone={statusToneForLevel(notification.level)} className="mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
                      {notification.title}
                    </div>
                    <div className="shrink-0 text-[11px] text-[color:var(--text-disabled)]">
                      {formatNotificationTime(notification.timestamp)}
                    </div>
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
                    {notification.message}
                  </div>
                  {notification.workspaceName || notification.agentId || notification.sessionId ? (
                    <div className="mt-1 truncate font-mono text-[10px] text-[color:var(--text-disabled)]">
                      {[notification.workspaceName, notification.agentId, notification.sessionId]
                        .filter(Boolean)
                        .join(' / ')}
                    </div>
                  ) : null}
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void copyNotification(notification)}
                      className="rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                    >
                      Copy
                    </button>
                    {copyErrorId === notification.id ? (
                      <span
                        role="status"
                        aria-live="polite"
                        className="text-[11px] font-semibold text-[color:var(--tone-error)]"
                      >
                        Could not copy
                      </span>
                    ) : null}
                    {notification.logPath ? (
                      <button
                        type="button"
                        onClick={onOpenLogs}
                        className="rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                      >
                        Open logs
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
