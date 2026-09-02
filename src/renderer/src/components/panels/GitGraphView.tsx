import React, { useMemo, useRef, useState } from 'react'
import type { GitGraphCommit, GitGraphSnapshot, GitResetMode } from '../../../../shared/electron-api'
import { computeGitGraphLayout, type GitGraphLine } from '../../utils/gitGraphLayout'
import { EmptyState, GhostButton, InlineNotice, MenuItem, OutlineButton, OverflowMenu, Skeleton, Tooltip, TruncatedText, type OverflowMenuItem } from '../ui'
import { setCommitDropData } from '../../utils/terminalDrop'

export type GitGraphState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: GitGraphSnapshot }
  | { status: 'error'; message: string }

export type GitMergeTarget = {
  ref: string
  label: string
  kind: 'branch' | 'remote' | 'commit'
  commit: GitGraphCommit
}

export interface GitCommitActions {
  merge: (target: GitMergeTarget) => void
  rebaseOnto: (target: GitMergeTarget) => void
  cherryPick: (commit: GitGraphCommit) => void
  revertCommit: (commit: GitGraphCommit) => void
  resetToCommit: (commit: GitGraphCommit, mode: GitResetMode) => void
  deleteBranch: (branchName: string) => void
  renameBranch: (branchName: string) => void
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
const HEAD_RING_RADIUS = 7
const GUTTER_PADDING = 5
// Size of the --git-lane-* palette in index.css; layout colour indices are
// unbounded and wrap onto it.
const LANE_PALETTE_SIZE = 8
// Opacity for branch lines outside the traced ancestry while a trace is active.
const UNTRACED_LANE_OPACITY = 0.3

function laneColor(colorIndex: number): string {
  return `var(--git-lane-${colorIndex % LANE_PALETTE_SIZE})`
}
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

interface VisibleRef {
  label: string
  isTag: boolean
}

function visibleRefs(commit: GitGraphCommit): VisibleRef[] {
  // `%D` decoration ("HEAD -> main") and the exact-ref scan ("main") both reduce
  // to the same label, so dedup after normalising. Keep a bare "HEAD" only when
  // it is the sole ref (detached with no branch pointing here).
  const seen = new Map<string, VisibleRef>()
  for (const raw of commit.refs) {
    const isTag = raw.startsWith('tag: ')
    const label = raw.replace(/^HEAD -> /, '').replace(/^tag: /, '')
    if (label.length === 0) continue
    if (label === 'HEAD' && commit.refs.length > 1) continue
    if (!seen.has(label)) seen.set(label, { label, isTag })
  }
  return [...seen.values()].slice(0, 4)
}

type GitSnapshotRef = GitGraphSnapshot['refs'][number]

function isMergeableBranchRef(ref: GitSnapshotRef, currentBranch: string | null, headHash: string | null): boolean {
  if (!currentBranch) return false
  if (ref.hash === headHash) return false
  if (ref.name === 'HEAD' || ref.name.endsWith('/HEAD')) return false
  if (ref.type !== 'head' && ref.type !== 'remote') return false
  return ref.name !== currentBranch
}

function mergeTargetsForCommit({
  commit,
  refs,
  currentBranch,
  headHash,
}: {
  commit: GitGraphCommit
  refs: GitSnapshotRef[]
  currentBranch: string | null
  headHash: string | null
}): GitMergeTarget[] {
  if (!currentBranch) return []

  const branchTargets = refs
    .filter((ref) => isMergeableBranchRef(ref, currentBranch, headHash))
    .map((ref): GitMergeTarget => ({
      ref: ref.name,
      label: ref.name,
      kind: ref.type === 'remote' ? 'remote' : 'branch',
      commit,
    }))

  if (branchTargets.length > 0) return branchTargets.slice(0, 4)
  if (commit.hash === headHash) return []

  return [{
    ref: commit.hash,
    label: commit.shortHash,
    kind: 'commit',
    commit,
  }]
}

function GitGraphGutter({
  commitHash,
  column,
  colorIndex,
  lines,
  columns,
  isHead,
  highlight,
}: {
  commitHash: string
  column: number
  colorIndex: number
  lines: GitGraphLine[]
  columns: number
  isHead: boolean
  highlight: Set<string>
}) {
  const width = gutterWidth(columns)
  const mid = ROW_HEIGHT / 2
  const traceActive = highlight.size > 0
  // Dimmed lanes first, traced lanes on top so the trace reads cleanly.
  const ordered = [...lines].sort(
    (a, b) => Number(highlight.has(a.hash)) - Number(highlight.has(b.hash))
  )
  const nodeDimmed = traceActive && !highlight.has(commitHash)
  const nodeColor = laneColor(colorIndex)

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
            stroke={laneColor(line.colorIndex)}
            strokeWidth={traced ? 1.5 : 1.25}
            opacity={traceActive && !traced ? UNTRACED_LANE_OPACITY : 1}
            fill="none"
            strokeLinecap="round"
          />
        )
      })}
      {isHead ? (
        <circle
          cx={laneX(column, columns)}
          cy={mid}
          r={HEAD_RING_RADIUS}
          fill="none"
          stroke={nodeColor}
          strokeWidth={1}
          opacity={nodeDimmed ? UNTRACED_LANE_OPACITY : 1}
        />
      ) : null}
      <circle
        cx={laneX(column, columns)}
        cy={mid}
        r={isHead ? HEAD_NODE_RADIUS : NODE_RADIUS}
        fill={nodeColor}
        opacity={nodeDimmed ? UNTRACED_LANE_OPACITY : 1}
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

const RESET_MODES: { mode: GitResetMode; label: string; hint: string }[] = [
  { mode: 'soft', label: 'Soft', hint: 'keep changes staged' },
  { mode: 'mixed', label: 'Mixed', hint: 'keep changes unstaged' },
  { mode: 'hard', label: 'Hard', hint: 'discard changes' },
]

function buildCommitMenuItems(
  commit: GitGraphCommit,
  actions: GitCommitActions,
  mergeTargets: GitMergeTarget[],
  localBranches: string[],
  currentBranch: string | null,
  isHead: boolean,
  isOnCurrentBranch: boolean
): OverflowMenuItem[] {
  const items: OverflowMenuItem[] = []

  if (currentBranch && mergeTargets.length > 0) {
    for (const target of mergeTargets) {
      items.push({
        id: `merge-${target.ref}`,
        label: target.kind === 'commit'
          ? `Merge commit into ${currentBranch}`
          : `Merge ${target.label} into ${currentBranch}`,
        onSelect: () => actions.merge(target),
      })
    }
    for (const target of mergeTargets) {
      items.push({
        id: `rebase-${target.ref}`,
        label: target.kind === 'commit'
          ? `Rebase ${currentBranch} onto this commit`
          : `Rebase ${currentBranch} onto ${target.label}`,
        onSelect: () => actions.rebaseOnto(target),
      })
    }
    items.push({ kind: 'separator', id: 'integrate-sep' })
  }

  // Cherry-picking a commit already reachable from HEAD yields an empty pick
  // that parks CHERRY_PICK_HEAD — don't offer a dead end; conversely, reverting
  // only makes sense for commits that ARE in the current history.
  if (currentBranch && !isHead && !isOnCurrentBranch) {
    items.push({
      id: 'cherry-pick',
      label: `Cherry-pick into ${currentBranch}`,
      onSelect: () => actions.cherryPick(commit),
    })
  }
  if (currentBranch && isOnCurrentBranch) {
    items.push({ id: 'revert', label: 'Revert this commit…', onSelect: () => actions.revertCommit(commit) })
  }
  if (currentBranch && !isHead) {
    items.push({
      kind: 'flyout',
      id: 'reset',
      label: `Reset ${currentBranch} to here`,
      ariaLabel: `Reset ${currentBranch} to ${commit.shortHash}`,
      render: (close) => (
        <>
          {RESET_MODES.map(({ mode, label, hint }) => (
            <MenuItem
              key={mode}
              variant={mode === 'hard' ? 'danger' : undefined}
              onClick={() => {
                actions.resetToCommit(commit, mode)
                close()
              }}
            >
              {label} — {hint}
            </MenuItem>
          ))}
        </>
      ),
    })
  }
  if (items.length > 0 && items[items.length - 1].kind !== 'separator') {
    items.push({ kind: 'separator', id: 'history-sep' })
  }

  items.push(
    { id: 'checkout', label: 'Checkout this commit', onSelect: () => actions.checkout(commit) },
    { id: 'branch', label: 'New branch from here…', onSelect: () => actions.createBranch(commit) },
    { id: 'tag', label: 'New tag from here…', onSelect: () => actions.createTag(commit) },
    { kind: 'separator', id: 'sep' },
    { id: 'copy-hash', label: 'Copy hash', onSelect: () => actions.copyHash(commit) },
    { id: 'copy-subject', label: 'Copy subject', onSelect: () => actions.copySubject(commit) },
  )
  if (commit.commitWebUrl) {
    items.push({ id: 'github', label: 'Open on GitHub', onSelect: () => actions.openOnGitHub(commit) })
  }

  if (localBranches.length > 0) {
    items.push({ kind: 'separator', id: 'branch-sep' })
    for (const branch of localBranches) {
      items.push({
        id: `rename-${branch}`,
        label: `Rename ${branch}…`,
        onSelect: () => actions.renameBranch(branch),
      })
      if (branch !== currentBranch) {
        items.push({
          id: `delete-${branch}`,
          label: `Delete ${branch}…`,
          destructive: true,
          onSelect: () => actions.deleteBranch(branch),
        })
      }
    }
  }

  return items
}

function GitGraphCommitRow({
  commit,
  column,
  colorIndex,
  lines,
  columns,
  isHead,
  currentBranch,
  mergeTargets,
  localBranches,
  isOnCurrentBranch,
  highlight,
  selected,
  actions,
  onHover,
  onSelect,
}: {
  commit: GitGraphCommit
  column: number
  colorIndex: number
  lines: GitGraphLine[]
  columns: number
  isHead: boolean
  currentBranch: string | null
  mergeTargets: GitMergeTarget[]
  localBranches: string[]
  isOnCurrentBranch: boolean
  highlight: Set<string>
  /** The picked commit — the one the detail pane below is showing. Named for
   *  what it is: it takes the selection fill, not the hover one. */
  selected: boolean
  actions: GitCommitActions
  onHover: (hash: string | null) => void
  onSelect: (hash: string) => void
}) {
  const refs = visibleRefs(commit)
  const openMenuRef = useRef<(() => void) | null>(null)

  return (
    <div
      draggable
      onDragStart={(event) => setCommitDropData(event.dataTransfer, commit.hash)}
      // Selection is the neutral selection fill plus the subject's ink lift, and
      // hover is skipped on the picked row — `--bg-hover` sits below
      // `--bg-selected`, so letting it win would dim the row the pointer is over
      // and make "picked" and "pointed at" the same picture
      // (design-system/patterns/selection.html).
      className={`group flex items-stretch transition-colors ${
        selected ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]'
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Commit ${commit.shortHash}: ${commit.subject}${
          refs.length > 0 ? ` (${refs.map((ref) => ref.label).join(', ')})` : ''
        }`}
        onMouseEnter={() => onHover(commit.hash)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(commit.hash)}
        onBlur={() => onHover(null)}
        onClick={() => onSelect(commit.hash)}
        onContextMenu={(event) => {
          event.preventDefault()
          openMenuRef.current?.()
        }}
        className="flex min-w-0 flex-1 items-stretch gap-2 text-left text-meta focus-visible:focus-ring"
      >
        <GitGraphGutter
          commitHash={commit.hash}
          column={column}
          colorIndex={colorIndex}
          lines={lines}
          columns={columns}
          isHead={isHead}
          highlight={highlight}
        />
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-2">
            {refs.length > 0 ? (
              <span className="flex shrink-0 items-center gap-1">
                {refs.map((ref) => (
                  <GitRefPill
                    key={ref.label}
                    label={ref.label}
                    isTag={ref.isTag}
                    isCurrent={ref.label === currentBranch}
                    colorIndex={colorIndex}
                  />
                ))}
              </span>
            ) : null}
            <TruncatedText
              as="span"
              text={commit.subject}
              className={`min-w-0 ${
                selected
                  ? 'text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-default)] group-hover:text-[color:var(--text-strong)]'
              }`}
            />
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-micro tabular-nums text-[color:var(--text-muted)]">
            <span className="shrink-0 font-mono text-[color:var(--text-muted)]">{commit.shortHash}</span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="shrink-0 whitespace-nowrap">{commit.date}</span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <TruncatedText as="span" text={commit.author} className="min-w-0" />
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center pr-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <OverflowMenu
          ariaLabel={`Commit ${commit.shortHash} actions`}
          items={buildCommitMenuItems(commit, actions, mergeTargets, localBranches, currentBranch, isHead, isOnCurrentBranch)}
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

function GitRefPill({
  label,
  isTag,
  isCurrent,
  colorIndex,
}: {
  label: string
  isTag: boolean
  isCurrent: boolean
  colorIndex: number
}) {
  // Branch refs wear their branch line's lane colour; tags stay neutral so the
  // hue vocabulary remains "one colour per branch line".
  const surface = isTag
    ? 'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]'
    : `git-ref-pill-${colorIndex % LANE_PALETTE_SIZE}`
  return (
    <span
      className={`inline-flex h-[17px] max-w-[150px] items-center rounded-xs border px-1.5 text-micro ${
        isCurrent ? 'font-semibold' : 'font-medium'
      } ${surface}`}
    >
      {/* The full ref name is a tooltip only when the pill actually clips it —
          never a native `title` on a span nobody can reach by keyboard. */}
      <TruncatedText as="span" text={label} className="font-mono" />
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
  onRetry,
}: {
  state: GitGraphState
  currentBranch: string | null
  detachedReturnBranch: string | null
  actions: GitCommitActions
  onReturnToBranch: (branch: string) => void
  onLoadMore: () => void
  loadingMore: boolean
  /** Reloads the graph after a failed read; the error notice offers it. */
  onRetry?: () => void
}) {
  const [hoveredHash, setHoveredHash] = useState<string | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)

  const snapshot = state.status === 'ready' ? state.snapshot : null
  const layout = useMemo(
    () => computeGitGraphLayout(snapshot?.commits ?? [], { headHash: snapshot?.headHash ?? null }),
    [snapshot]
  )
  const commitsByHash = useMemo(() => {
    const map = new Map<string, GitGraphCommit>()
    snapshot?.commits.forEach((commit) => map.set(commit.hash, commit))
    return map
  }, [snapshot])
  const refsByHash = useMemo(() => {
    const map = new Map<string, GitSnapshotRef[]>()
    snapshot?.refs.forEach((ref) => {
      const refs = map.get(ref.hash) ?? []
      refs.push(ref)
      map.set(ref.hash, refs)
    })
    return map
  }, [snapshot])
  const activeHash = hoveredHash ?? selectedHash
  const highlight = useMemo(
    () => collectAncestry(commitsByHash, activeHash),
    [commitsByHash, activeHash]
  )
  // HEAD's ancestry within the loaded window gates cherry-pick (pointless on
  // reachable commits) and revert (only meaningful on reachable commits).
  // Commits deeper than the loaded page can't be classified and stay ungated.
  const headAncestry = useMemo(
    () => collectAncestry(commitsByHash, snapshot?.headHash ?? null),
    [commitsByHash, snapshot?.headHash]
  )

  // The three non-populated states each wear their own idiom, so a failed
  // `git log` can never read as "no commits yet": loading is the shimmer,
  // failure is the error card with its retry, and empty is the kit empty state.
  if (state.status === 'loading') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <span role="status" className="sr-only">
          Loading commit graph…
        </span>
        <div aria-hidden="true">
          {[68, 52, 80, 44, 60].map((width, index) => (
            <div key={index} className="flex items-center gap-2 py-1.5">
              <Skeleton className="h-3 w-3 shrink-0 rounded-full bg-[color:var(--skeleton-shimmer-high)]" />
              <Skeleton className="h-3 rounded bg-[color:var(--skeleton-shimmer-high)]" style={{ width: `${width}%` }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <InlineNotice
          tone="error"
          title="Couldn't load the commit graph."
          detail={state.message}
          action={
            onRetry ? (
              <OutlineButton size="xs" onClick={onRetry}>
                Try again
              </OutlineButton>
            ) : undefined
          }
        />
      </div>
    )
  }

  if (!snapshot || snapshot.commits.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyState density="list" title="No commits yet" />
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
        <div className="text-meta font-semibold text-[color:var(--text-strong)]">Graph</div>
        <div className="tabular-nums text-micro text-[color:var(--text-muted)]">
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
              colorIndex={row.colorIndex}
              lines={row.lines}
              columns={layout.columns}
              isHead={snapshot.headHash === row.hash}
              currentBranch={currentBranch}
              mergeTargets={mergeTargetsForCommit({
                commit,
                refs: refsByHash.get(commit.hash) ?? [],
                currentBranch,
                headHash: snapshot.headHash,
              })}
              localBranches={(refsByHash.get(commit.hash) ?? [])
                .filter((ref) => ref.type === 'head' && ref.name !== 'HEAD')
                .map((ref) => ref.name)
                .slice(0, 4)}
              isOnCurrentBranch={headAncestry.has(row.hash)}
              highlight={highlight}
              selected={selectedHash === row.hash}
              actions={actions}
              onHover={setHoveredHash}
              onSelect={(hash) => setSelectedHash((prev) => (prev === hash ? null : hash))}
            />
          )
        })}

        {snapshot.hasMore ? (
          <div className="px-3 pt-3">
            <Tooltip content="Load older commits across all branches">
              {/* The log's one bordered action, on the kit's `sm` step. It ran
                  the Git panels' private 28px/6px ramp at 40% disabled
                  (MC-2113). */}
              <OutlineButton size="sm" className="w-full" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </OutlineButton>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </section>
  )
}
