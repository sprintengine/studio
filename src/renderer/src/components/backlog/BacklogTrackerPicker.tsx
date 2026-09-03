import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { NormalizedIssue, RedactedTrackerConnection } from '../../../../shared/electron-api'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import {
  Drawer,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  OutlineButton,
  Select,
  StatusDot,
  type SelectItem,
} from '../ui'
import { presentTrackerError, trackerProviderMonogram } from '../settings/trackerConnectionsForm'
import {
  isIssueInBacklog,
  trackerIssueStateChip,
} from './backlogTrackerPickerModel'

const SEARCH_DEBOUNCE_MS = 300

// The remote-search lifecycle. `error` carries the provider's own reason (an
// unreachable/unauthenticated tracker degrades to a visible reason here, never a
// silent empty list). `loadingMore` overlays a ready state while a cursor page
// is fetched, so the current rows stay put. `loadMoreError` surfaces a failed
// cursor page in the footer (the loaded rows keep their place, and the Load more
// button stays available to retry) instead of the failure being swallowed.
type SearchState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  issues: NormalizedIssue[]
  nextCursor?: string
  error?: string
  loadingMore: boolean
  loadMoreError?: string
}

const INITIAL_SEARCH: SearchState = { phase: 'idle', issues: [], loadingMore: false }

// Browse a tracker and start a sprint from an issue (MC-2359).
//
// This used to be an "Add from tracker" flow: tick issues, materialize them into
// `backlog/` as proxy files, report what was added. That copied another team's
// tickets into a git-tracked directory, so the whole add path is gone — with it
// the checkbox column, the selection state and the result-report footer.
//
// What remains is what the surface was actually for: search a tracker, and start
// a sprint from an issue. All tracker access is IPC; there is no tracker HTTP in
// the renderer.
export function BacklogTrackerPicker({
  open,
  onClose,
  connections,
  initialConnectionId,
  issueLinkIndex,
  onStartSprint,
}: {
  open: boolean
  onClose: () => void
  connections: ReadonlyArray<RedactedTrackerConnection>
  initialConnectionId: string
  issueLinkIndex: ReadonlySet<string>
  /** Start a sprint from this issue, seeded from its fresh description and
   *  comment thread. Absent → the per-row action is not shown. */
  onStartSprint?: (issue: NormalizedIssue) => Promise<{ ok: true } | { ok: false; error: string }>
}): JSX.Element {
  const now = useRelativeNow()
  const [connectionId, setConnectionId] = useState(initialConnectionId)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>(INITIAL_SEARCH)
  // Issues a sprint was started from this session — locked immediately so a
  // double-click cannot start two runs on one ticket.
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set())
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
            ? // A cursor page failed: keep the loaded rows and the Load more button
              // (which retries), but say so in the footer instead of swallowing it.
              { ...prev, loadingMore: false, loadMoreError: `Couldn’t load more issues. ${presentTrackerError(result.error).hint}` }
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
    setAdded(new Set())
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
        setStartNotice({
          tone: 'muted',
          text: `Sprint starting for ${issue.nativeKey}, from its current description and comments. Nothing was written to your repository.`,
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

  // Switching connection clears the per-issue state: it is keyed by externalId,
  // which belongs to the connection it came from.
  const selectConnection = useCallback((nextConnectionId: string) => {
    setConnectionId(nextConnectionId)
    setAdded(new Set())
    setSprintState(new Map())
    setStartNotice(null)
  }, [])

  const connectionItems: SelectItem[] = useMemo(
    () => connections.map((entry) => ({ value: entry.id, label: entry.label })),
    [connections],
  )

  // The start result takes precedence over the ambient prompt, so a "sprint
  // starting" / start-failure message is never masked.
  const reportText = startNotice
    ? startNotice.text
    : search.loadMoreError
      ? search.loadMoreError
      : 'Start a sprint from an issue — the tracker stays its home.'
  const reportIsError = startNotice ? startNotice.tone === 'error' : Boolean(search.loadMoreError)

  return (
    <Drawer open={open} onClose={onClose} title="Start from a tracker" ariaLabel="Start a sprint from a tracker issue" width={520}>
      {/* Tools: which connection to search, and the query. */}
      {/* No hairlines inside the drawer: padding separates the search head and
          the footer from the results between them. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        {connections.length > 1 ? (
          <Select
            ariaLabel="Tracker connection"
            items={connectionItems}
            value={connectionId}
            onChange={selectConnection}
            triggerMinWidthClassName="min-w-[160px]"
          />
        ) : connection ? (
          <span className="inline-flex items-center gap-2 text-meta text-[color:var(--text-default)]">
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
          <p className="px-3 py-6 text-meta text-[color:var(--text-subtle)]">Searching {connection?.label ?? 'tracker'}…</p>
        ) : search.phase === 'error' ? (
          <div className="px-3 py-3">
            <InlineNotice
              tone="error"
              action={
                <GhostButton size="xs" onClick={() => void runSearch(connectionId, query.trim())}>
                  Try again
                </GhostButton>
              }
            >
              Couldn’t reach {connection?.label ?? 'this tracker'}: {search.error}
            </InlineNotice>
          </div>
        ) : search.phase === 'ready' && search.issues.length === 0 ? (
          <p className="px-3 py-6 text-meta text-[color:var(--text-subtle)]">
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
                  locked={isLocked(issue)}
                  lockedLabel={lockedLabel}
                  now={now}
                  sprint={sprint}
                  canStartSprint={Boolean(onStartSprint)}
                  onStartSprint={() => void startSprint(issue)}
                />
              )
            })}
            {search.nextCursor ? (
              <li className="px-3 py-2">
                <OutlineButton
                  size="md"
                  onClick={() => void runSearch(connectionId, query.trim(), search.nextCursor)}
                  disabled={search.loadingMore}
                >
                  {search.loadingMore ? 'Loading…' : 'Load more'}
                </OutlineButton>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {/* Footer: the status line. There is no add action any more — starting a
          sprint is a per-row action, and nothing is copied into the backlog. */}
      <div className="flex shrink-0 items-center gap-3 bg-[color:var(--bg-surface-raised)] px-3 py-2">
        {/* A failed start / page is a failure with a glyph and a role, never amber
            ink alone; the ambient report stays a quiet status line. */}
        {reportIsError ? (
          <InlineNotice tone="error" className="min-w-0 flex-1">
            {reportText}
          </InlineNotice>
        ) : (
          <span role="status" aria-live="polite" className="min-w-0 flex-1 text-meta leading-[1.4] text-[color:var(--text-muted)]">
            {reportText}
          </span>
        )}
      </div>
    </Drawer>
  )
}

function Monogram({ provider }: { provider: RedactedTrackerConnection['provider'] }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-xs border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] font-mono text-micro font-semibold text-[color:var(--text-muted)]"
    >
      {trackerProviderMonogram(provider)}
    </span>
  )
}

// One issue row. The row is the kit `Checkbox` with the issue as its label (one
// tab stop on the native input, Space toggles, native form semantics — no more
// hand-drawn box); an already-tracked issue is dimmed and disabled, reading its
// locked label in place of the updated-ago meta so a locked row never looks like
// an empty state. A hover/focus-revealed "Start sprint" action sits alongside the
// row (a sibling, never nested) for the one-step flow (mockup §2); once its
// sprint is running the row locks and shows a running indicator in the action's
// place.
function IssueRow({
  issue,
  locked,
  lockedLabel,
  now,
  sprint,
  canStartSprint,
  onStartSprint,
}: {
  issue: NormalizedIssue
  locked: boolean
  lockedLabel: string
  now: number
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
        {/* No checkbox: there is nothing to select for, now that issues are not
            copied into the backlog. The row is a plain read of the issue, and
            its one action sits in the trail. A locked row dims to the row canon. */}
        <div
          className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 transition-colors ${
            locked ? 'opacity-50' : 'hover:bg-[color:var(--bg-hover)]'
          }`}
        >
          {(
            <>
              <span className="w-[76px] shrink-0 truncate font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
                {issue.nativeKey}
              </span>
              <span className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-default)]">{issue.title}</span>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-micro text-[color:var(--text-muted)]">
                <StatusDot tone={chip.tone} />
                {chip.label}
              </span>
              <span className="w-[112px] shrink-0 text-right text-micro text-[color:var(--text-muted)]">
                {locked ? lockedLabel : updatedAgo ? `updated ${updatedAgo}` : ''}
              </span>
            </>
          )}
        </div>
        {sprint === 'running' ? (
          <span className="flex shrink-0 items-center gap-1.5 self-center pl-2 pr-3 text-micro text-[color:var(--text-muted)]">
            <StatusDot tone="accent" pulse />
            Sprint running
          </span>
        ) : showStartAction || sprint === 'starting' ? (
          <GhostButton
            size="xs"
            onClick={onStartSprint}
            disabled={sprint === 'starting'}
            aria-label={`Start a sprint from ${issue.nativeKey}`}
            className={`shrink-0 self-center transition-opacity focus-visible:opacity-100 ${
              sprint === 'starting'
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
            }`}
          >
            {sprint === 'starting' ? 'Starting…' : 'Start sprint'}
          </GhostButton>
        ) : null}
      </div>
    </li>
  )
}
