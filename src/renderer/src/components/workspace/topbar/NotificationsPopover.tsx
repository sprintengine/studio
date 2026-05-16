// Notifications popover rendered inside the WorkspaceTopBar's
// `account-and-settings` control group. Extracted from WorkspaceTopBar.tsx so
// the shell file keeps its at-rest control-group inventory visible and the
// popover body stays composable. Pure presentation — list and intent
// callbacks in, IPC and store mutations stay in the parent.

import React from 'react'
import type { AppNotification } from '../../../types/workspace'
import { StatusDot } from '../../ui'

function formatNotificationTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
  const copyNotification = (notification: AppNotification) => {
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

    void navigator.clipboard.writeText(details).catch(() => {})
    onMarkRead(notification.id)
  }

  return (
    <div className="w-[440px] overflow-hidden">
      <div className="flex h-10 items-center justify-between border-b border-[color:var(--border-default)] px-3">
        <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">Notifications</span>
        <div className="flex items-center gap-1">
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

      {notifications.length === 0 ? (
        <div className="px-3 py-4 text-[13px] text-[color:var(--text-disabled)]">No notifications</div>
      ) : (
        <div className="max-h-[440px] overflow-y-auto p-1">
          {notifications.map((notification) => (
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
                <StatusDot
                  tone={
                    notification.level === 'error'
                      ? 'error'
                      : notification.level === 'warning'
                        ? 'warn'
                        : 'accent'
                  }
                  className="mt-1"
                />
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
                      onClick={() => copyNotification(notification)}
                      className="rounded border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                    >
                      Copy
                    </button>
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
