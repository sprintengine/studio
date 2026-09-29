import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationThread } from '../../../../shared/conversation-index'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { conversationSummaryPhase } from '../../../../shared/conversation/phase'
import type { Workspace } from '../../types/workspace'
import { composerDraftStore } from '../panels/agentChat/draftStore'
import { openConversationHistory } from '../../utils/conversationHistoryNavigation'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { isWindowVisible, onWindowVisibilityChange } from '../../utils/windowActivity'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { GhostButton, InlineNotice, Input, RowButton, useConfirmDialog } from '../ui'

const HISTORY_CHANGED = 'conversation-history-changed'
/**
 * Something changed a workspace's saved conversations outside the runtime's
 * own events (a rename, a delete). Naming the workspace refreshes it alone;
 * without one, every listed workspace is asked again.
 */
export function notifyConversationHistoryChanged(workspaceId?: string): void {
  window.dispatchEvent(new CustomEvent(HISTORY_CHANGED, { detail: { workspaceId } }))
}
type HistoryRow = { workspaceId: string; workspaceRoot: string; thread: ConversationThread }
type HistoryKey = { workspaceId: string; workspaceRoot: string }
type WorkspaceHistory = { workspaceRoot: string; rows: HistoryRow[] }

// The stream shows the most recent closed chats; the rest wait behind a fold
// so a profile with years of them does not draw them all on every render.
const HISTORY_PAGE = 20
const HISTORY_STEP = 50
// A turn ending in one chat often ends in its neighbours too (a background
// agent's report, a follow-up turn); one read per workspace covers the burst.
const HISTORY_REFRESH_MS = 500

const NO_HISTORY: ReadonlyMap<string, WorkspaceHistory> = new Map()
// Workspace id to the folder whose read failed.
const NO_FAILURES: ReadonlyMap<string, string> = new Map()
const NO_AGENT_IDS: ReadonlySet<string> = new Set()

/**
 * Which agents a layout has a tab open for. Walked once per layout object
 * (layouts are immutable, so a new object is the only way one changes), not
 * once per history row.
 */
const openAgentIdsByLayout = new WeakMap<object, ReadonlySet<string>>()
function openConversationAgentIds(layoutModel: unknown): ReadonlySet<string> {
  if (!layoutModel || typeof layoutModel !== 'object') return NO_AGENT_IDS
  const cached = openAgentIdsByLayout.get(layoutModel)
  if (cached) return cached
  const ids = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    if (!value || typeof value !== 'object') return
    const node = value as Record<string, unknown>
    const config = node.config as Record<string, unknown> | undefined
    if (node.component === 'agent' && typeof config?.agentId === 'string') ids.add(config.agentId)
    for (const entry of Object.values(node)) if (entry && typeof entry === 'object') walk(entry)
  }
  walk(layoutModel)
  openAgentIdsByLayout.set(layoutModel, ids)
  return ids
}

/**
 * Closed agent tabs remain reachable in the existing All chats stream.
 *
 * Each workspace's saved conversations are read once, when it joins the list,
 * and again only when something says that workspace's changed: a turn ending
 * or a session updating in it, or a rename or delete here. Reading every
 * workspace on each of those (and on every window focus) cost main a disk walk
 * per workspace, hundreds of them on a large profile, for news about one.
 */
export const ConversationHistoryRows = React.memo(function ConversationHistoryRows({
  workspaces,
  sessions,
}: {
  workspaces: readonly Workspace[]
  sessions: readonly ConversationSessionSummary[]
}) {
  const [histories, setHistories] = useState<ReadonlyMap<string, WorkspaceHistory>>(NO_HISTORY)
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(NO_FAILURES)
  const [limit, setLimit] = useState(HISTORY_PAGE)
  // Keyed on which workspaces and folders, never on their names or anything
  // else a workspace write moves: a rename or an auto-title reads nothing.
  const keySignature = useMemo(
    () =>
      workspaces
        .filter((workspace) => workspace.folderPath)
        .map((workspace) => `${workspace.id}\u0000${workspace.folderPath}`)
        .join('\u0001'),
    [workspaces],
  )
  const keys = useMemo<HistoryKey[]>(
    () =>
      keySignature
        ? keySignature.split('\u0001').map((entry) => {
            const [workspaceId, workspaceRoot] = entry.split('\u0000') as [string, string]
            return { workspaceId, workspaceRoot }
          })
        : [],
    [keySignature],
  )
  const keyRoots = useMemo(() => new Map(keys.map((key) => [key.workspaceId, key.workspaceRoot])), [keys])
  const keysRef = useRef(keyRoots)
  keysRef.current = keyRoots
  // The latest request per workspace; an older answer that lands after it is dropped.
  const requestsRef = useRef(new Map<string, number>())
  const nextRequestRef = useRef(0)

  const loadWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (typeof window.api.conversationThreads !== 'function') return
    const workspaceRoot = keysRef.current.get(workspaceId)
    if (workspaceRoot === undefined) return
    const request = ++nextRequestRef.current
    requestsRef.current.set(workspaceId, request)
    let rows: HistoryRow[] | null = null
    try {
      const result = await window.api.conversationThreads({ workspaceId, workspaceRoot })
      if (!result.ok) throw new Error(result.message)
      rows = result.threads.map((thread) => ({ workspaceId, workspaceRoot, thread }))
    } catch {
      rows = null
    }
    if (requestsRef.current.get(workspaceId) !== request) return
    requestsRef.current.delete(workspaceId)
    if (keysRef.current.get(workspaceId) !== workspaceRoot) return
    setHistories((previous) => {
      const next = new Map(previous)
      if (rows) next.set(workspaceId, { workspaceRoot, rows })
      else next.delete(workspaceId)
      return next
    })
    setFailed((previous) => {
      if (rows ? !previous.has(workspaceId) : previous.get(workspaceId) === workspaceRoot) return previous
      const next = new Map(previous)
      if (rows) next.delete(workspaceId)
      else next.set(workspaceId, workspaceRoot)
      return next
    })
  }, [])

  // Read each workspace that joined (or moved folder); forget each that left.
  // A folder whose read failed is not asked again here (only when an event
  // names it, or on Retry), so a folder that is gone costs one read.
  useEffect(() => {
    for (const [workspaceId, workspaceRoot] of keyRoots) {
      if (histories.get(workspaceId)?.workspaceRoot === workspaceRoot) continue
      if (failed.get(workspaceId) === workspaceRoot || requestsRef.current.has(workspaceId)) continue
      void loadWorkspace(workspaceId)
    }
    const stale = (entries: Iterable<[string, string]>) => [...entries].some(([id, root]) => keyRoots.get(id) !== root)
    if (stale([...histories].map(([id, history]) => [id, history.workspaceRoot]))) {
      setHistories((previous) => {
        const next = new Map(previous)
        for (const [id, history] of previous) if (keyRoots.get(id) !== history.workspaceRoot) next.delete(id)
        return next
      })
    }
    if (stale(failed)) {
      setFailed((previous) => new Map([...previous].filter(([id, root]) => keyRoots.get(id) === root)))
    }
  }, [keyRoots, histories, failed, loadWorkspace])

  // Refresh the one workspace an event names, coalesced, and not while the
  // window is hidden: what it missed is read once when it is shown.
  useEffect(() => {
    const dirty = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      timer = null
      if (!isWindowVisible()) return
      const ids = [...dirty]
      dirty.clear()
      for (const id of ids) void loadWorkspace(id)
    }
    const mark = (workspaceId: string): void => {
      if (!keysRef.current.has(workspaceId)) return
      dirty.add(workspaceId)
      if (timer === null && isWindowVisible()) timer = setTimeout(flush, HISTORY_REFRESH_MS)
    }
    const onHistoryChanged = (event: Event): void => {
      const workspaceId = (event as CustomEvent<{ workspaceId?: string } | undefined>).detail?.workspaceId
      if (workspaceId) mark(workspaceId)
      else for (const id of keysRef.current.keys()) mark(id)
    }
    window.addEventListener(HISTORY_CHANGED, onHistoryChanged)
    const dispose = window.api.onConversationEvent?.((event) => {
      if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'session_updated') {
        mark(event.workspaceId)
      }
    })
    const unbindVisibility = onWindowVisibilityChange((visible) => {
      if (visible && dirty.size > 0 && timer === null) flush()
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      dispose?.()
      unbindVisibility()
      window.removeEventListener(HISTORY_CHANGED, onHistoryChanged)
    }
  }, [loadWorkspace])

  const retryFailed = useCallback(() => {
    const ids = [...failed.keys()]
    setFailed(NO_FAILURES)
    for (const id of ids) void loadWorkspace(id)
  }, [failed, loadWorkspace])

  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace] as const)),
    [workspaces],
  )
  const sessionByAgent = useMemo(
    () => new Map(sessions.map((session) => [`${session.workspaceId}\u0000${session.agentId}`, session] as const)),
    [sessions],
  )
  const visible = useMemo(() => {
    const rows: HistoryRow[] = []
    for (const [workspaceId, history] of histories) {
      const workspace = workspaceById.get(workspaceId)
      if (!workspace) continue
      const open = openConversationAgentIds(workspace.layoutModel)
      for (const row of history.rows) if (!open.has(row.thread.agentId)) rows.push(row)
    }
    return rows.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)
  }, [histories, workspaceById])

  // A workspace whose history could not be read is left out quietly: one
  // unreachable folder is not worth a banner over every other chat. Only
  // when nothing could be read at all is there something to say.
  const allFailed = keys.length > 0 && failed.size > 0 && histories.size === 0 && failed.size >= keys.length
  const remaining = visible.length - limit
  return (
    <>
      {allFailed ? (
        <InlineNotice
          tone="error"
          title="Conversation history could not load"
          detail="Saved conversations could not be read."
          action={
            <GhostButton size="inline" onClick={retryFailed}>
              Retry
            </GhostButton>
          }
        />
      ) : null}
      {visible.slice(0, limit).map((row) => (
        <HistoryRowView
          key={`${row.workspaceId}:${row.thread.agentId}`}
          row={row}
          workspaceName={workspaceById.get(row.workspaceId)?.name ?? ''}
          session={sessionByAgent.get(`${row.workspaceId}\u0000${row.thread.agentId}`)}
          onChanged={loadWorkspace}
        />
      ))}
      {remaining > 0 ? (
        <div className="px-2 py-1">
          <GhostButton
            size="inline"
            tone="subtle"
            align="start"
            onClick={() => setLimit((current) => current + HISTORY_STEP)}
          >
            Show {Math.min(HISTORY_STEP, remaining)} more
          </GhostButton>
        </div>
      ) : null}
    </>
  )
})

/** How long ago a saved conversation last moved, on the shared clock. */
function HistoryUpdatedAgo({ at }: { at: number }) {
  const now = useRelativeNow()
  return <>{formatRelativeMsAgo(at, now)}</>
}

const HistoryRowView = React.memo(function HistoryRowView({
  row,
  workspaceName,
  session,
  onChanged,
}: {
  row: HistoryRow
  workspaceName: string
  session?: ConversationSessionSummary
  onChanged: (workspaceId: string) => Promise<void>
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
      notifyConversationHistoryChanged(row.workspaceId)
      await onChanged(row.workspaceId)
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
      notifyConversationHistoryChanged(row.workspaceId)
      await onChanged(row.workspaceId)
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
            {workspaceName} · {row.thread.model}
          </span>
          <span className="block text-meta text-[color:var(--sem-color-text-muted)]">
            {phase.replaceAll('_', ' ')} · <HistoryUpdatedAgo at={row.thread.updatedAt} />
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
                void onChanged(row.workspaceId)
              }}
            >
              Refresh
            </GhostButton>
          }
        />
      ) : null}
    </div>
  )
})
