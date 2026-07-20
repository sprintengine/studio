import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { NormalizedIssue, RedactedTrackerConnection } from '../../../../shared/electron-api'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import {
  Drawer,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  PrimaryButton,
  Select,
  StatusDot,
  type SelectItem,
} from '../ui'
import { trackerProviderMonogram } from '../settings/trackerConnectionsForm'
import {
  isIssueInBacklog,
  materializeReport,
  trackerIssueStateChip,
} from './backlogTrackerPickerModel'

const SEARCH_DEBOUNCE_MS = 300

// The remote-search lifecycle. `error` carries the provider's own reason (an
// unreachable/unauthenticated tracker degrades to a visible reason here, never a
// silent empty list). `loadingMore` overlays a ready state while a cursor page
// is fetched, so the current rows stay put.
type SearchState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  issues: NormalizedIssue[]
  nextCursor?: string
  error?: string
  loadingMore: boolean
}

type MaterializeState = { phase: 'idle' | 'working' | 'done' | 'error'; report?: string }

const INITIAL_SEARCH: SearchState = { phase: 'idle', issues: [], loadingMore: false }

// The "Add from tracker" flow (mockup §2). Mirrors the interaction SHAPE of
// BacklogItemSearchPicker — a search field over a checkbox result list — but is
// backed by a REMOTE tracker source (window.api.trackerSearch) instead of the
// local backlog, and adds the multi-select → materialize → result-report footer
// the local picker has no need for. All tracker access is IPC; there is no
// tracker HTTP in the renderer.
export function BacklogTrackerPicker({
  open,
  onClose,
  workspaceRoot,
  connections,
  initialConnectionId,
  issueLinkIndex,
  onMaterialized,
  onStartSprint,
}: {
  open: boolean
  onClose: () => void
  workspaceRoot: string
  connections: ReadonlyArray<RedactedTrackerConnection>
  initialConnectionId: string
  issueLinkIndex: ReadonlySet<string>
  /** Re-scan the backlog so freshly materialized proxy items appear. */
  onMaterialized: () => void | Promise<void>
  /** One-step "Start sprint" (mockup §2): materialize this one issue and start a
   *  plan-sourced sprint from its fresh description + comments. Absent → the
   *  per-row action is not shown (the drawer stays a pure add surface). */
  onStartSprint?: (issue: NormalizedIssue) => Promise<{ ok: true } | { ok: false; error: string }>
}): JSX.Element {
  const now = useRelativeNow()
  const [connectionId, setConnectionId] = useState(initialConnectionId)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>(INITIAL_SEARCH)
  // Selected issues (by externalId) not yet added; and issues added this session
  // (dimmed + locked immediately, before the panel re-scan lands).
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set())
  const [materialize, setMaterialize] = useState<MaterializeState>({ phase: 'idle' })
  // Per-row one-step start (by externalId): 'starting' while the sprint is being
  // created, 'running' once it is. A started row locks (like an added one) and
  // shows a running indicator in place of its Start action. `startNotice`
  // overrides the footer report with the start result (success or failure).
  const [sprintState, setSprintState] = useState<ReadonlyMap<string, 'starting' | 'running'>>(() => new Map())
  const [startNotice, setStartNotice] = useState<{ tone: 'muted' | 'error'; text: string } | null>(null)

  const connection = useMemo(
    () => connections.find((entry) => entry.id === connectionId) ?? null,
    [connections, connectionId],
  )

  // Monotonic token so a slow response for a superseded query/connection never
  // overwrites the newest results. A cursor page checks it too, then appends.
  const requestRef = useRef(0)

  const runSearch = useCallback(
    async (targetConnectionId: string, targetQuery: string, cursor?: string) => {
      const token = ++requestRef.current
      if (cursor) setSearch((prev) => ({ ...prev, loadingMore: true }))
      else setSearch({ phase: 'loading', issues: [], loadingMore: false })
      const result = await window.api.trackerSearch({
        connectionId: targetConnectionId,
        query: targetQuery,
        cursor,
      })
      if (token !== requestRef.current) return
      if (!result.ok) {
        setSearch((prev) =>
          cursor
            ? { ...prev, loadingMore: false }
            : { phase: 'error', issues: [], loadingMore: false, error: result.error.message },
        )
        return
      }
      setSearch((prev) => ({
        phase: 'ready',
        issues: cursor ? [...prev.issues, ...result.issues] : result.issues,
        nextCursor: result.nextCursor,
        loadingMore: false,
      }))
    },
    [],
  )

  // Opening (or switching to a different connection from the toolbar) resets the
  // picker and searches with an empty query — both providers return the most
  // recently updated issues for that, so the list is browsable immediately.
  useEffect(() => {
    if (!open) return
    setConnectionId(initialConnectionId)
    setQuery('')
    setSelected(new Set())
    setAdded(new Set())
    setMaterialize({ phase: 'idle' })
    setSprintState(new Map())
    setStartNotice(null)
  }, [open, initialConnectionId])

  // Debounced search on query / connection change while open. Empty query is a
  // valid "most recent" browse, so it searches too.
  useEffect(() => {
    if (!open || !connectionId) return
    const handle = window.setTimeout(() => void runSearch(connectionId, query.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [open, connectionId, query, runSearch])

  const isLocked = useCallback(
    (issue: NormalizedIssue) =>
      added.has(issue.externalId) || isIssueInBacklog(issueLinkIndex, issue.provider, issue.externalId),
    [added, issueLinkIndex],
  )

  const toggle = useCallback(
    (externalId: string) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(externalId)) next.delete(externalId)
        else next.add(externalId)
        return next
      })
      setMaterialize({ phase: 'idle' })
      setStartNotice(null)
    },
    [],
  )

  const selectedCount = selected.size

  const addToBacklog = useCallback(async () => {
    if (!connection || selectedCount === 0) return
    const externalIds = [...selected]
    setStartNotice(null)
    setMaterialize({ phase: 'working' })
    const result = await window.api.trackerMaterialize({ workspaceRoot, connectionId: connection.id, externalIds })
    if (!result.ok) {
      setMaterialize({ phase: 'error', report: result.error.message })
      return
    }
    // Resolve failed externalIds to their native keys for a human-readable report.
    const nativeKeyById = new Map(search.issues.map((issue) => [issue.externalId, issue.nativeKey]))
    const failedIds = new Set(result.failed.map((entry) => entry.externalId))
    setAdded((prev) => {
      const next = new Set(prev)
      for (const externalId of externalIds) if (!failedIds.has(externalId)) next.add(externalId)
      return next
    })
    setSelected(new Set())
    setMaterialize({
      phase: 'done',
      report: materializeReport({
        added: result.added,
        refreshed: result.refreshed,
        failed: result.failed.map((entry) => ({
          key: nativeKeyById.get(entry.externalId) ?? entry.externalId,
          reason: entry.reason,
        })),
      }),
    })
    await onMaterialized()
  }, [connection, selected, selectedCount, workspaceRoot, search.issues, onMaterialized])

  // One-step "Start sprint" for a single row (mockup §2): materialize just this
  // issue and start a sprint from its fresh description + comments. The row locks
  // and shows a running indicator; a failure surfaces in the footer report and
  // leaves the row selectable so it can be retried or added normally.
  const startSprint = useCallback(
    async (issue: NormalizedIssue) => {
      if (!onStartSprint || sprintState.get(issue.externalId)) return
      setSprintState((prev) => new Map(prev).set(issue.externalId, 'starting'))
      setStartNotice(null)
      const result = await onStartSprint(issue)
      if (result.ok) {
        setSprintState((prev) => new Map(prev).set(issue.externalId, 'running'))
        setAdded((prev) => new Set(prev).add(issue.externalId))
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(issue.externalId)
          return next
        })
        setStartNotice({
          tone: 'muted',
          text: `${issue.nativeKey} added to the backlog — its sprint is starting from the fresh issue description and comments.`,
        })
      } else {
        setSprintState((prev) => {
          const next = new Map(prev)
          next.delete(issue.externalId)
          return next
        })
        setStartNotice({ tone: 'error', text: `Couldn’t start a sprint for ${issue.nativeKey}: ${result.error}` })
      }
    },
    [onStartSprint, sprintState],
  )

  // Switching connection clears the selection: the ticked externalIds belong to
  // the previous connection, so carrying them into a materialize on the new one
  // would add the wrong issues.
  const selectConnection = useCallback((nextConnectionId: string) => {
    setConnectionId(nextConnectionId)
    setSelected(new Set())
    setAdded(new Set())
    setMaterialize({ phase: 'idle' })
    setSprintState(new Map())
    setStartNotice(null)
  }, [])

  const connectionItems: SelectItem[] = useMemo(
    () => connections.map((entry) => ({ value: entry.id, label: entry.label })),
    [connections],
  )

  // The one-step start result takes precedence over the add-report while it is
  // showing, so a "sprint starting" / start-failure message is never masked by
  // the ambient "Tick issues…" prompt.
  const reportText = startNotice
    ? startNotice.text
    : materialize.phase === 'idle'
      ? selectedCount > 0
        ? `${selectedCount} ${selectedCount === 1 ? 'issue' : 'issues'} selected.`
        : 'Tick issues to add them to the backlog.'
      : materialize.report
  const reportIsError = startNotice ? startNotice.tone === 'error' : materialize.phase === 'error'

  return (
    <Drawer open={open} onClose={onClose} title="Add from a tracker" ariaLabel="Add issues from a tracker" width={520}>
      {/* Tools: which connection to search, and the query. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
        {connections.length > 1 ? (
          <Select
            ariaLabel="Tracker connection"
            items={connectionItems}
            value={connectionId}
            onChange={selectConnection}
            triggerMinWidthClassName="min-w-[160px]"
          />
        ) : connection ? (
          <span className="inline-flex items-center gap-2 text-[12px] text-[color:var(--text-default)]">
            <Monogram provider={connection.provider} />
            {connection.label}
          </span>
        ) : null}
        <div className="min-w-[180px] flex-1">
          <InboxSearchInput
            value={query}
            onChange={setQuery}
            ariaLabel={`Search ${connection?.label ?? 'tracker'} issues`}
            placeholder="Search issues…"
            clearAriaLabel="Clear tracker search"
            autoFocus
          />
        </div>
      </div>

      {/* Results. */}
      <div className="min-h-0 flex-1 overflow-auto">
        {search.phase === 'loading' ? (
          <p className="px-3 py-6 text-[12px] text-[color:var(--text-subtle)]">Searching {connection?.label ?? 'tracker'}…</p>
        ) : search.phase === 'error' ? (
          <div className="px-3 py-3">
            <InlineNotice
              tone="error"
              action={
                <button
                  type="button"
                  onClick={() => void runSearch(connectionId, query.trim())}
                  className="interactive text-[12px] font-semibold text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
                >
                  Try again
                </button>
              }
            >
              Couldn’t reach {connection?.label ?? 'this tracker'}: {search.error}
            </InlineNotice>
          </div>
        ) : search.phase === 'ready' && search.issues.length === 0 ? (
          <p className="px-3 py-6 text-[12px] text-[color:var(--text-subtle)]">
            {query.trim() ? 'No issues match your search.' : 'No open issues found.'}
          </p>
        ) : (
          <ul className="py-1" role="list">
            {search.issues.map((issue) => {
              const sprint = sprintState.get(issue.externalId)
              const lockedLabel = sprint === 'running'
                ? 'sprint started'
                : added.has(issue.externalId)
                  ? 'in your backlog'
                  : 'already in your backlog'
              return (
                <IssueRow
                  key={`${issue.provider}:${issue.externalId}`}
                  issue={issue}
                  checked={selected.has(issue.externalId)}
                  locked={isLocked(issue)}
                  lockedLabel={lockedLabel}
                  now={now}
                  onToggle={() => toggle(issue.externalId)}
                  sprint={sprint}
                  canStartSprint={Boolean(onStartSprint)}
                  onStartSprint={() => void startSprint(issue)}
                />
              )
            })}
            {search.nextCursor ? (
              <li className="px-3 py-2">
                <GhostButton
                  size="md"
                  onClick={() => void runSearch(connectionId, query.trim(), search.nextCursor)}
                  disabled={search.loadingMore}
                  className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                >
                  {search.loadingMore ? 'Loading…' : 'Load more'}
                </GhostButton>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {/* Footer: result report + the add action. */}
      <div className="flex shrink-0 items-center gap-3 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
        <span
          role="status"
          aria-live="polite"
          className={`min-w-0 flex-1 text-[12px] leading-[1.4] ${
            reportIsError ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-muted)]'
          }`}
        >
          {reportText}
        </span>
        <PrimaryButton
          size="md"
          onClick={() => void addToBacklog()}
          disabled={selectedCount === 0 || materialize.phase === 'working'}
        >
          {materialize.phase === 'working'
            ? 'Adding…'
            : selectedCount > 0
              ? `Add ${selectedCount} to backlog`
              : 'Add to backlog'}
        </PrimaryButton>
      </div>
    </Drawer>
  )
}

function Monogram({ provider }: { provider: RedactedTrackerConnection['provider'] }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] font-mono text-[9px] font-semibold text-[color:var(--text-muted)]"
    >
      {trackerProviderMonogram(provider)}
    </span>
  )
}

// One issue row. The row is a role=checkbox button (one tab stop, Space/Enter
// toggles, aria-checked announced); an already-tracked issue is dimmed and
// disabled, reading its locked label in place of the updated-ago meta so a locked
// row never looks like an empty state. A hover/focus-revealed "Start sprint"
// action sits alongside the row button (a sibling, never nested) for the one-step
// flow (mockup §2); once its sprint is running the row locks and shows a running
// indicator in the action's place.
function IssueRow({
  issue,
  checked,
  locked,
  lockedLabel,
  now,
  onToggle,
  sprint,
  canStartSprint,
  onStartSprint,
}: {
  issue: NormalizedIssue
  checked: boolean
  locked: boolean
  lockedLabel: string
  now: number
  onToggle: () => void
  sprint: 'starting' | 'running' | undefined
  canStartSprint: boolean
  onStartSprint: () => void
}): JSX.Element {
  const chip = trackerIssueStateChip(issue)
  const updatedAgo = formatRelativeMsAgo(issue.updatedAt ? Date.parse(issue.updatedAt) : undefined, now)
  // The start action shows only on a row that can still be started: one this
  // session hasn't already locked (added or started) and that isn't already in
  // the backlog. A started row shows the running indicator instead.
  const showStartAction = canStartSprint && !locked
  return (
    <li>
      <div className="group relative flex items-stretch">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-disabled={locked || undefined}
          disabled={locked}
          onClick={locked ? undefined : onToggle}
          className={`flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-colors ${
            locked ? 'cursor-default opacity-55' : 'hover:bg-[color:var(--bg-hover)]'
          }`}
        >
          <span
            aria-hidden="true"
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
              checked
                ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
                : 'border-[color:var(--border-strong)] bg-[color:var(--bg-surface)]'
            }`}
          >
            {checked ? (
              <svg viewBox="0 0 16 16" fill="none" className="h-2.5 w-2.5">
                <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </span>
          <span className="w-[76px] shrink-0 truncate font-mono text-[11px] tabular-nums text-[color:var(--text-subtle)]">
            {issue.nativeKey}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--text-default)]">{issue.title}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
            <StatusDot tone={chip.tone} />
            {chip.label}
          </span>
          <span className="w-[112px] shrink-0 text-right text-[11px] text-[color:var(--text-disabled)]">
            {locked ? lockedLabel : updatedAgo ? `updated ${updatedAgo}` : ''}
          </span>
        </button>
        {sprint === 'running' ? (
          <span className="flex shrink-0 items-center gap-1.5 self-center pl-2 pr-3 text-[11px] text-[color:var(--text-muted)]">
            <StatusDot tone="accent" pulse />
            Sprint running
          </span>
        ) : showStartAction || sprint === 'starting' ? (
          <button
            type="button"
            onClick={onStartSprint}
            disabled={sprint === 'starting'}
            aria-label={`Start a sprint from ${issue.nativeKey}`}
            className={`interactive shrink-0 self-center rounded px-2 py-1 text-[11px] font-medium text-[color:var(--text-muted)] transition-opacity transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
              sprint === 'starting'
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
            }`}
          >
            {sprint === 'starting' ? 'Starting…' : 'Start sprint'}
          </button>
        ) : null}
      </div>
    </li>
  )
}
