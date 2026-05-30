import React, { useMemo, useRef, useState } from 'react'
import type { GitGraphCommit, GitGraphSnapshot } from '../../../../shared/electron-api'
import { computeGitGraphLayout, type GitGraphLine } from '../../utils/gitGraphLayout'
import { GhostButton, InlineNotice, OverflowMenu, StatusDot, Tooltip, type OverflowMenuItem, type Tone } from '../ui'

export type GitGraphState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: GitGraphSnapshot }
  | { status: 'error'; message: string }

export interface GitCommitActions {
  checkout: (commit: GitGraphCommit) => void
  createBranch: (commit: GitGraphCommit) => void
  createTag: (commit: GitGraphCommit) => void
  copyHash: (commit: GitGraphCommit) => void
  copySubject: (commit: GitGraphCommit) => void
  openOnGitHub: (commit: GitGraphCommit) => void
}

const LANE_WIDTH = 14
const ROW_HEIGHT = 44
const NODE_RADIUS = 3.5
const HEAD_NODE_RADIUS = 4.5
const GUTTER_PADDING = 5
// Beyond this the gutter stops widening and far lanes clamp to the edge; keeps a
// pathological fan-out from pushing commit subjects off-screen.
const MAX_GUTTER_COLUMNS = 8

function laneX(column: number, columns: number): number {
  const clamped = Math.min(column, columns - 1)
  return GUTTER_PADDING + clamped * LANE_WIDTH + LANE_WIDTH / 2
}

function gutterWidth(columns: number): number {
  const visibleColumns = Math.min(Math.max(columns, 1), MAX_GUTTER_COLUMNS)
  return GUTTER_PADDING * 2 + (visibleColumns - 1) * LANE_WIDTH + LANE_WIDTH
}

/** Hashes reachable from `hash` through parent links — the commit plus its history. */
function collectAncestry(commitsByHash: Map<string, GitGraphCommit>, hash: string | null): Set<string> {
  const set = new Set<string>()
  if (!hash) return set
  const stack = [hash]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (set.has(current)) continue
    set.add(current)
    for (const parent of commitsByHash.get(current)?.parents ?? []) stack.push(parent)
  }
  return set
}

function refTone(ref: string, currentBranch: string | null): Tone {
  if (ref === 'HEAD') return 'accent'
  if (ref === currentBranch) return 'accent'
  if (ref.includes('/')) return 'neutral'
  return 'neutral'
}

function visibleRefs(commit: GitGraphCommit): string[] {
  // `%D` decoration ("HEAD -> main") and the exact-ref scan ("main") both reduce
  // to the same label, so dedup after normalising. Keep a bare "HEAD" only when
  // it is the sole ref (detached with no branch pointing here).
  const normalized = commit.refs
    .map((ref) => ref.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
    .filter((ref) => ref.length > 0 && (ref !== 'HEAD' || commit.refs.length === 1))
  return [...new Set(normalized)].slice(0, 4)
}

function GitGraphGutter({
  commitHash,
  column,
  lines,
  columns,
  isHead,
  highlight,
}: {
  commitHash: string
  column: number
  lines: GitGraphLine[]
  columns: number
  isHead: boolean
  highlight: Set<string>
}) {
  const width = gutterWidth(columns)
  const mid = ROW_HEIGHT / 2
  // Neutral lanes first, traced lanes on top so the accent reads cleanly.
  const ordered = [...lines].sort(
    (a, b) => Number(highlight.has(a.hash)) - Number(highlight.has(b.hash))
  )
  const nodeHighlighted = highlight.has(commitHash)

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      className="shrink-0"
      aria-hidden="true"
    >
      {ordered.map((line, index) => {
        const traced = highlight.has(line.hash)
        const stroke = traced ? 'var(--accent-primary)' : 'var(--text-disabled)'
        const fromX = laneX(line.fromColumn, columns)
        const toX = laneX(line.toColumn, columns)
        const d =
          line.kind === 'through'
            ? `M ${fromX} 0 L ${toX} ${ROW_HEIGHT}`
            : line.kind === 'in'
              ? `M ${fromX} 0 L ${toX} ${mid}`
              : `M ${fromX} ${mid} L ${toX} ${ROW_HEIGHT}`
        return (
          <path
            key={`${line.kind}-${line.fromColumn}-${line.toColumn}-${index}`}
            d={d}
            stroke={stroke}
            strokeWidth={traced ? 1.5 : 1.25}
            fill="none"
            strokeLinecap="round"
          />
        )
      })}
      <circle
        cx={laneX(column, columns)}
        cy={mid}
        r={isHead ? HEAD_NODE_RADIUS : NODE_RADIUS}
        fill={isHead || nodeHighlighted ? 'var(--accent-primary)' : 'var(--bg-surface)'}
        stroke={isHead || nodeHighlighted ? 'var(--accent-primary)' : 'var(--text-disabled)'}
        strokeWidth={1.25}
      />
    </svg>
  )
}

const KEBAB_GLYPH = (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <circle cx="7" cy="3" r="1.2" fill="currentColor" />
    <circle cx="7" cy="7" r="1.2" fill="currentColor" />
    <circle cx="7" cy="11" r="1.2" fill="currentColor" />
  </svg>
)

function buildCommitMenuItems(commit: GitGraphCommit, actions: GitCommitActions): OverflowMenuItem[] {
  const items: OverflowMenuItem[] = [
    { id: 'checkout', label: 'Checkout this commit', onSelect: () => actions.checkout(commit) },
    { id: 'branch', label: 'New branch from here…', onSelect: () => actions.createBranch(commit) },
    { id: 'tag', label: 'New tag from here…', onSelect: () => actions.createTag(commit) },
    { kind: 'separator', id: 'sep' },
    { id: 'copy-hash', label: 'Copy hash', onSelect: () => actions.copyHash(commit) },
    { id: 'copy-subject', label: 'Copy subject', onSelect: () => actions.copySubject(commit) },
  ]
  if (commit.commitWebUrl) {
    items.push({ id: 'github', label: 'Open on GitHub', onSelect: () => actions.openOnGitHub(commit) })
  }
  return items
}

function GitGraphCommitRow({
  commit,
  column,
  lines,
  columns,
  isHead,
  currentBranch,
  highlight,
  active,
  actions,
  onHover,
  onSelect,
}: {
  commit: GitGraphCommit
  column: number
  lines: GitGraphLine[]
  columns: number
  isHead: boolean
  currentBranch: string | null
  highlight: Set<string>
  active: boolean
  actions: GitCommitActions
  onHover: (hash: string | null) => void
  onSelect: (hash: string) => void
}) {
  const refs = visibleRefs(commit)
  const openMenuRef = useRef<(() => void) | null>(null)

  return (
    <div
      className={`group flex items-stretch transition-colors ${
        active ? 'bg-[color:var(--bg-hover)]' : 'hover:bg-[color:var(--bg-hover)]'
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      <button
        type="button"
        aria-pressed={active}
        aria-label={`Commit ${commit.shortHash}: ${commit.subject}`}
        onMouseEnter={() => onHover(commit.hash)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(commit.hash)}
        onBlur={() => onHover(null)}
        onClick={() => onSelect(commit.hash)}
        onContextMenu={(event) => {
          event.preventDefault()
          openMenuRef.current?.()
        }}
        className="flex min-w-0 flex-1 items-stretch gap-2 text-left text-[12px] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-default)]"
      >
        <GitGraphGutter
          commitHash={commit.hash}
          column={column}
          lines={lines}
          columns={columns}
          isHead={isHead}
          highlight={highlight}
        />
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-2">
            {refs.length > 0 ? (
              <span className="flex shrink-0 items-center gap-1.5">
                {refs.map((ref) => (
                  <GitRefLabel key={ref} label={ref} tone={refTone(ref, currentBranch)} />
                ))}
              </span>
            ) : null}
            <span
              className="min-w-0 truncate text-[color:var(--text-default)] group-hover:text-[color:var(--text-strong)]"
              title={commit.subject}
            >
              {commit.subject}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] tabular-nums text-[color:var(--text-disabled)]">
            <span className="font-mono text-[color:var(--text-muted)]">{commit.shortHash}</span>
            <span aria-hidden="true">·</span>
            <span>{commit.date}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{commit.author}</span>
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center pr-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <OverflowMenu
          ariaLabel={`Commit ${commit.shortHash} actions`}
          items={buildCommitMenuItems(commit, actions)}
          align="end"
          trigger={(open) => {
            openMenuRef.current = open
            return KEBAB_GLYPH
          }}
        />
      </span>
    </div>
  )
}

function GitRefLabel({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className="inline-flex max-w-[150px] items-center gap-1 text-[11px] font-medium text-[color:var(--text-default)]"
      title={label}
    >
      <StatusDot tone={tone} />
      <span className="truncate font-mono">{label}</span>
    </span>
  )
}

export function GitGraphView({
  state,
  currentBranch,
  detachedReturnBranch,
  actions,
  onReturnToBranch,
  onLoadMore,
  loadingMore,
}: {
  state: GitGraphState
  currentBranch: string | null
  detachedReturnBranch: string | null
  actions: GitCommitActions
  onReturnToBranch: (branch: string) => void
  onLoadMore: () => void
  loadingMore: boolean
}) {
  const [hoveredHash, setHoveredHash] = useState<string | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)

  const snapshot = state.status === 'ready' ? state.snapshot : null
  const layout = useMemo(
    () => computeGitGraphLayout(snapshot?.commits ?? []),
    [snapshot]
  )
  const commitsByHash = useMemo(() => {
    const map = new Map<string, GitGraphCommit>()
    snapshot?.commits.forEach((commit) => map.set(commit.hash, commit))
    return map
  }, [snapshot])
  const activeHash = hoveredHash ?? selectedHash
  const highlight = useMemo(
    () => collectAncestry(commitsByHash, activeHash),
    [commitsByHash, activeHash]
  )

  if (state.status === 'loading') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[11px] text-[color:var(--text-disabled)]">
        Loading commit graph…
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[11px] text-[color:var(--text-muted)]">
        {state.message}
      </div>
    )
  }

  if (!snapshot || snapshot.commits.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[11px] text-[color:var(--text-disabled)]">
        No commits yet
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {snapshot.detached ? (
        <div className="shrink-0 px-3 pt-3">
          <InlineNotice
            tone="warn"
            action={
              detachedReturnBranch ? (
                <GhostButton onClick={() => onReturnToBranch(detachedReturnBranch)}>
                  Return to {detachedReturnBranch}
                </GhostButton>
              ) : undefined
            }
          >
            <span className="font-medium">Detached HEAD</span>
            {' — '}
            <span>this checkout points at a commit, not a branch. New commits here are easy to lose.</span>
          </InlineNotice>
        </div>
      ) : null}

      <div className="flex h-6 shrink-0 items-center justify-between gap-2 px-3 pt-3">
        <div className="text-[12px] font-semibold text-[color:var(--text-strong)]">Graph</div>
        <div className="tabular-nums text-[11px] text-[color:var(--text-muted)]">
          {snapshot.totalCount} total · showing {snapshot.commits.length}
        </div>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pb-3">
        {layout.rows.map((row) => {
          const commit = commitsByHash.get(row.hash)
          if (!commit) return null
          return (
            <GitGraphCommitRow
              key={row.hash}
              commit={commit}
              column={row.column}
              lines={row.lines}
              columns={layout.columns}
              isHead={snapshot.headHash === row.hash}
              currentBranch={currentBranch}
              highlight={highlight}
              active={selectedHash === row.hash}
              actions={actions}
              onHover={setHoveredHash}
              onSelect={(hash) => setSelectedHash((prev) => (prev === hash ? null : hash))}
            />
          )
        })}

        {snapshot.hasMore ? (
          <div className="px-3 pt-3">
            <Tooltip content="Load older commits across all branches">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="h-7 w-full rounded-md border border-[color:var(--border-subtle)] text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:opacity-40"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </section>
  )
}
