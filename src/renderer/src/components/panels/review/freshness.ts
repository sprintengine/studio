// Freshness + re-run projections (MC-1682). Pure, node-free, React-free logic the
// review panel uses to answer three questions honestly:
//
//   1. Has the reviewed head moved since the walkthrough was generated, and if so
//      which steps are affected? (`computeFreshness`)
//   2. When the reviewer refreshes, what survives? Read progress on unchanged
//      files stays read; changed files flip to unread; pending comments survive
//      verbatim, and a comment whose file changed flips to the 'moved' re-review
//      state rather than silently pointing at shifted code. (`migrateReviewState`)
//   3. How is the banner worded? (`buildFreshnessBanner`)
//
// A step/file is "affected" iff its per-file diff signature differs between the
// old and new changeset (or the file was added/removed). The signature is a
// canonical serialization of the file's structural diff — two ingests of the same
// content produce the same signature, so an unchanged file is never re-reviewed.

import type {
  ChangeSetFile,
  ReviewBrief,
  ReviewChangeSet,
  ReviewComment,
  ReviewWorkspaceState,
} from '../../../../../shared/review'
import type { ReviewSourceInput } from '../../../../../shared/electron-api'
import { orderedSteps } from './reviewSelectors'

// A stable, order-preserving signature of a file's structural diff. Covers the
// status, rename source, binary flag, and every hunk header + line (kind + text),
// so any real change to how the file diffs shows up as a different string. Line
// numbering is included via the hunk headers, so a pure line shift above the file
// still counts as a change (the diff genuinely differs).
export function changeSetFileSignature(file: ChangeSetFile): string {
  const hunks = file.hunks
    .map(
      (hunk) =>
        `@${hunk.oldStart},${hunk.oldLines},${hunk.newStart},${hunk.newLines}\n` +
        hunk.lines.map((line) => `${line.kind[0]} ${line.text}`).join('\n'),
    )
    .join('\n~~\n')
  return `${file.status}|${file.oldPath ?? ''}|${file.binary ? 'b' : 't'}|${hunks}`
}

// The set of paths whose diff differs between two changesets: present in the new
// one with a different signature (added or changed), or gone from it (removed).
function changedPathSet(oldCs: ReviewChangeSet, newCs: ReviewChangeSet): Set<string> {
  const oldSig = new Map(oldCs.files.map((file) => [file.path, changeSetFileSignature(file)]))
  const newSig = new Map(newCs.files.map((file) => [file.path, changeSetFileSignature(file)]))
  const changed = new Set<string>()
  for (const [path, signature] of newSig) {
    if (oldSig.get(path) !== signature) changed.add(path)
  }
  for (const path of oldSig.keys()) {
    if (!newSig.has(path)) changed.add(path)
  }
  return changed
}

export interface FreshnessResult {
  headMoved: boolean
  oldHeadSha?: string
  newHeadSha?: string
  affectedStepIds: string[] // steps that touch a changed file — regenerate on refresh
  unaffectedStepIds: string[] // steps whose files are all unchanged — keep verbatim
  changedPaths: string[]
}

// Compare the walkthrough's brief + its old changeset against a freshly probed
// changeset. `headMoved` keys off brief.headSha (the sha the walkthrough was
// generated against) vs the probed head — a patch source has no head, so it can
// never report moved. Affected steps are those whose files' diffs changed.
export function computeFreshness(
  oldCs: ReviewChangeSet,
  newCs: ReviewChangeSet,
  brief: ReviewBrief,
): FreshnessResult {
  const oldHeadSha = brief.headSha ?? oldCs.headSha
  const newHeadSha = newCs.headSha
  const headMoved = Boolean(oldHeadSha && newHeadSha && oldHeadSha !== newHeadSha)

  const changed = changedPathSet(oldCs, newCs)
  const affectedStepIds: string[] = []
  const unaffectedStepIds: string[] = []
  for (const step of orderedSteps(brief)) {
    const isAffected = step.files.some((file) => changed.has(file.path))
    ;(isAffected ? affectedStepIds : unaffectedStepIds).push(step.id)
  }

  return {
    headMoved,
    oldHeadSha,
    newHeadSha,
    affectedStepIds,
    unaffectedStepIds,
    changedPaths: [...changed],
  }
}

// Carry reviewer state across a re-run. The new changeset has a new id, so the
// panel would otherwise reset to defaults and lose everything; this migrates it:
//   - readFiles: a path stays read only if its file is present AND its diff is
//     unchanged. A changed file flips to unread — it genuinely needs re-reading.
//   - comments: every comment survives. One whose file is unchanged keeps its
//     anchor exactly (and clears any prior 'moved' flag). One whose file changed
//     or vanished flips to 'moved' — we cannot recover the exact new-side line
//     from base-diffs alone, so we surface it for re-review instead of silently
//     re-pointing it. Never dropped.
export function migrateReviewState(
  prev: ReviewWorkspaceState,
  oldCs: ReviewChangeSet,
  newCs: ReviewChangeSet,
): ReviewWorkspaceState {
  const oldSig = new Map(oldCs.files.map((file) => [file.path, changeSetFileSignature(file)]))
  const newSig = new Map(newCs.files.map((file) => [file.path, changeSetFileSignature(file)]))
  const isUnchanged = (path: string): boolean => newSig.has(path) && oldSig.get(path) === newSig.get(path)

  const readFiles = prev.readFiles.filter(isUnchanged)
  const comments = prev.comments.map((comment): ReviewComment => {
    if (isUnchanged(comment.path)) {
      if (comment.anchorStatus === undefined) return comment
      const { anchorStatus: _dropped, ...anchored } = comment
      return anchored
    }
    return { ...comment, anchorStatus: 'moved' }
  })

  return { ...prev, changeSetId: newCs.id, readFiles, comments }
}

export type FreshnessBannerTone = 'stale' | 'current'

export interface FreshnessBannerModel {
  tone: FreshnessBannerTone
  // The lead phrase ("Branch moved." / "New commits on this pull request.") shown
  // in bold; empty for the current tone.
  lead: string
  // The detail sentence. For the stale tone it names the sha move and which steps
  // are unchanged vs need a refresh; for the current tone it confirms the settle.
  detail: string
  oldSha?: string
  newSha?: string
  refreshable: boolean
}

function shortSha(sha: string | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined
}

function stepNumbers(brief: ReviewBrief, stepIds: string[]): number[] {
  const order = new Map(orderedSteps(brief).map((step, index) => [step.id, index + 1]))
  return stepIds
    .map((id) => order.get(id))
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b)
}

function joinNumbers(numbers: number[]): string {
  return numbers.join(', ')
}

const SOURCE_MOVED_LEAD: Record<ReviewChangeSet['source']['kind'], string> = {
  branch: 'Branch moved.',
  'pull-request': 'New commits on this pull request.',
  patch: '',
}

// The warn banner shown when the head has moved. Names the sha move and splits
// the steps into unchanged vs needs-a-refresh, matching mockup §4.
export function buildStaleBanner(
  source: ReviewChangeSet['source'],
  brief: ReviewBrief,
  freshness: FreshnessResult,
): FreshnessBannerModel {
  const unchanged = stepNumbers(brief, freshness.unaffectedStepIds)
  const affected = stepNumbers(brief, freshness.affectedStepIds)

  const clauses: string[] = []
  if (unchanged.length > 0) {
    clauses.push(`${unchanged.length === 1 ? 'step' : 'steps'} ${joinNumbers(unchanged)} unchanged`)
  }
  if (affected.length > 0) {
    clauses.push(`${affected.length === 1 ? 'step' : 'steps'} ${joinNumbers(affected)} ${affected.length === 1 ? 'needs' : 'need'} a refresh`)
  }

  const oldSha = shortSha(freshness.oldHeadSha)
  const newSha = shortSha(freshness.newHeadSha)
  const move = oldSha && newSha ? `(${oldSha} → ${newSha})` : ''
  const detail = clauses.length > 0 ? `${move} — ${clauses.join(', ')}.` : `${move} — refresh to regenerate the walkthrough.`.trim()

  return {
    tone: 'stale',
    lead: SOURCE_MOVED_LEAD[source.kind],
    detail: detail.trim(),
    oldSha: freshness.oldHeadSha,
    newSha: freshness.newHeadSha,
    refreshable: true,
  }
}

// The quiet settle banner shown briefly after a successful refresh (mockup §4's
// `.fresh.ok` line). `refreshedStepIds` are the steps that were regenerated.
export function buildCurrentBanner(
  newHeadSha: string | undefined,
  brief: ReviewBrief,
  refreshedStepIds: string[],
): FreshnessBannerModel {
  const sha = shortSha(newHeadSha)
  const refreshed = stepNumbers(brief, refreshedStepIds)
  const stepClause =
    refreshed.length === 0
      ? 'nothing needed regenerating'
      : `${refreshed.length === 1 ? 'step' : 'steps'} ${joinNumbers(refreshed)} refreshed`
  const withSha = sha ? `current with ${sha}` : 'current'
  return {
    tone: 'current',
    lead: '',
    detail: `Walkthrough is ${withSha} — ${stepClause}; your read progress and pending comments were kept.`,
    newSha: newHeadSha,
    refreshable: false,
  }
}

// Rebuild the ingestion input from a persisted changeset's source so the panel can
// re-probe/re-ingest without the original creation form. A patch source has no
// upstream to re-probe — it can never go stale — so this returns null for it.
export function reconstructSourceInput(changeset: ReviewChangeSet): ReviewSourceInput | null {
  const source = changeset.source
  if (source.kind === 'branch') {
    return { kind: 'branch', repoRoot: source.repoRoot, baseRef: source.baseRef, headRef: source.headRef }
  }
  if (source.kind === 'pull-request') {
    return { kind: 'pull-request', url: source.url }
  }
  return null
}

// A patch source has no upstream, so its walkthrough can never be stale — the
// panel hides the banner and never probes.
export function sourceCanGoStale(changeset: ReviewChangeSet): boolean {
  return changeset.source.kind !== 'patch'
}

// Debounce for pull-request re-probes: at most one probe per minute, and never
// while the workspace is not visible. Pure so the "no background timer while the
// workspace is closed" contract is unit-testable — the caller drives it from
// reveal + explicit-action events, never a timer.
export const FRESHNESS_PROBE_MIN_INTERVAL_MS = 60_000

export function shouldProbePullRequest(nowMs: number, lastProbeAtMs: number | null, visible: boolean): boolean {
  if (!visible) return false
  if (lastProbeAtMs === null) return true
  return nowMs - lastProbeAtMs >= FRESHNESS_PROBE_MIN_INTERVAL_MS
}
