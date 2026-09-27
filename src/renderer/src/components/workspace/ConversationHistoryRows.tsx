import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationThread } from '../../../../shared/conversation-index'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { conversationSummaryPhase } from '../../../../shared/conversation/phase'
import type { Workspace } from '../../types/workspace'
import { composerDraftStore } from '../panels/agentChat/draftStore'
import { layoutHasConversation, openConversationHistory } from '../../utils/conversationHistoryNavigation'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { GhostButton, InlineNotice, Input, RowButton, useConfirmDialog } from '../ui'

const HISTORY_CHANGED = 'conversation-history-changed'
export function notifyConversationHistoryChanged(): void {
  window.dispatchEvent(new Event(HISTORY_CHANGED))
}
type HistoryRow = { workspaceId: string; workspaceRoot: string; workspaceName: string; thread: ConversationThread }

/** Closed agent tabs remain reachable in the existing All chats stream. */
export function ConversationHistoryRows({
  workspaces,
  sessions,
}: {
  workspaces: Workspace[]
  sessions: ConversationSessionSummary[]
}) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const workspaceKeys = JSON.stringify(
    workspaces
      .filter((workspace) => workspace.folderPath)
      .map((workspace) => ({
        workspaceId: workspace.id,
        workspaceRoot: workspace.folderPath!,
        workspaceName: workspace.name,
      })),
  )
  const keys = useMemo(() => JSON.parse(workspaceKeys) as Omit<HistoryRow, 'thread'>[], [workspaceKeys])
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (typeof window.api.conversationThreads !== 'function') return
    const current = ++generation.current
    const next: HistoryRow[] = []
    const unavailable: string[] = []
    await Promise.all(
      keys.map(async (key) => {
        try {
          const result = await window.api.conversationThreads(key)
          if (!result.ok) throw new Error(result.message)
          next.push(...result.threads.map((thread) => ({ ...key, thread })))
        } catch {
          unavailable.push(key.workspaceName)
        }
      }),
    )
    if (current === generation.current) {
      setRows(next.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt))
      setError(unavailable.length ? `History unavailable for ${unavailable.join(', ')}.` : null)
    }
  }, [keys])
  useEffect(() => {
    void refresh()
    const update = () => {
      void refresh()
    }
    window.addEventListener(HISTORY_CHANGED, update)
    window.addEventListener('focus', update)
    const dispose = window.api.onConversationEvent?.((event) => {
      if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'session_updated') update()
    })
    return () => {
      generation.current++
      dispose?.()
      window.removeEventListener(HISTORY_CHANGED, update)
      window.removeEventListener('focus', update)
    }
  }, [refresh])
  const visible = rows.filter(
    (row) =>
      !layoutHasConversation(
        workspaces.find((workspace) => workspace.id === row.workspaceId)?.layoutModel,
        row.thread.agentId,
      ),
  )
  return (
    <>
      {error ? (
        <InlineNotice
          tone="error"
          title="Conversation history could not load"
          detail={error}
          action={
            <GhostButton size="inline" onClick={() => void refresh()}>
              Retry
            </GhostButton>
          }
        />
      ) : null}
      {visible.map((row) => (
        <HistoryRowView
          key={`${row.workspaceId}:${row.thread.agentId}`}
          row={row}
          session={sessions.find(
            (session) => session.workspaceId === row.workspaceId && session.agentId === row.thread.agentId,
          )}
          onChanged={refresh}
        />
      ))}
    </>
  )
}

function HistoryRowView({
  row,
  session,
  onChanged,
}: {
  row: HistoryRow
  session?: ConversationSessionSummary
  onChanged: () => Promise<void>
}) {
  const dialog = useConfirmDialog()
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(row.thread.title),
    [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cancel = useRef(false)
  const key = { workspaceRoot: row.workspaceRoot, workspaceId: row.workspaceId, agentId: row.thread.agentId }
  const phase = session ? conversationSummaryPhase(session) : 'completed'
  const save = async () => {
    if (cancel.current) {
      cancel.current = false
      return
    }
    const next = title.trim()
    setEditing(false)
    if (!next || next === row.thread.title) {
      setTitle(row.thread.title)
      return
    }
    setBusy(true)
    try {
      const result = await window.api.conversationRename({ ...key, title: next })
      if (!result.ok) throw new Error(result.message)
      notifyConversationHistoryChanged()
      await onChanged()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Rename failed.')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (
      !(await dialog.confirm({
        title: 'Delete conversation?',
        body: 'The saved transcript and recorded tool details will be permanently removed. Workspace files will not change.',
        confirmLabel: 'Delete conversation',
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    try {
      const result = await window.api.conversationDelete(key)
      if (!result.ok) throw new Error(result.message)
      // The unsent draft belonged to the deleted conversation; left behind it
      // would sit in storage for good, taking room from live drafts.
      const drafts = composerDraftStore()
      drafts.getState().remove(key.workspaceId, key.agentId)
      drafts.flushDrafts()
      notifyConversationHistoryChanged()
      await onChanged()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Delete failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="group/history-row px-2 py-1">
      {editing ? (
        <Input
          variant="inline"
          aria-label="Conversation title"
          autoFocus
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              cancel.current = true
              setTitle(row.thread.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <RowButton density="flush" onClick={() => openConversationHistory(row.workspaceId, row.thread)}>
          <span className="block truncate text-body">{row.thread.title}</span>
          <span className="block truncate text-meta text-[color:var(--sem-color-text-muted)]">
            {row.workspaceName} · {row.thread.model}
          </span>
          <span className="block text-meta text-[color:var(--sem-color-text-muted)]">
            {phase.replaceAll('_', ' ')} · {formatRelativeMsAgo(row.thread.updatedAt, Date.now())}
          </span>
        </RowButton>
      )}
      <div className="flex gap-2 opacity-0 group-hover/history-row:opacity-100 group-focus-within/history-row:opacity-100">
        <GhostButton
          size="inline"
          disabled={busy}
          onClick={() => {
            cancel.current = false
            setError(null)
            setTitle(row.thread.title)
            setEditing(true)
          }}
        >
          Rename
        </GhostButton>
        <GhostButton
          size="inline"
          disabled={
            busy ||
            Boolean(session && ['starting', 'running', 'waiting_for_approval', 'waiting_for_input'].includes(phase))
          }
          onClick={() => void remove()}
        >
          Delete
        </GhostButton>
      </div>
      {error ? (
        <InlineNotice
          tone="error"
          title={error}
          action={
            <GhostButton
              size="inline"
              onClick={() => {
                setError(null)
                void onChanged()
              }}
            >
              Refresh
            </GhostButton>
          }
        />
      ) : null}
    </div>
  )
}
