import type { DiffFileItem } from './diffFileList'
import { joinFilePath } from '../../utils/paths'
import type {
  BranchStepDiff,
  BranchStepSelection,
  BranchStepsSnapshot,
} from '../../../../shared/electron-api'

// The step strip's model (the-diff-an-agent-made / changed-files-and-commit-steps).
//
// Pure: everything the strip decides — what entries exist, which is selected,
// which two revisions a file's diff is read between — is here, so the rules can
// be tested without Monaco, a repo, or a render.

export type StripEntry = {
  /** Stable across a re-read: a commit keeps its identity by hash. */
  key: string
  label: string
  /** The short hash for a commit; absent for the span and the tail. */
  hash?: string
  /** Merge steps carry a diff (what they brought in) and say so. */
  isMerge?: boolean
  selection: BranchStepSelection
}

export type BranchDiffItem = DiffFileItem & {
  kind: 'branch'
  /** Revision for the original side. Null means "not present there". */
  originalRev: string | null
  /** Revision for the modified side, or the working tree. */
  modifiedRev: string | 'worktree' | null
  additions: number
  deletions: number
}

/**
 * The strip, left to right: the whole branch first because it is the default
 * view, then the uncommitted tail (which is where an agent mid-task lives), then
 * the commits oldest first.
 *
 * A checkout with no commits of its own and nothing uncommitted has one entry —
 * the span — rather than none, so the surface always has something selected and
 * never renders a strip that cannot be operated.
 */
export function stripEntriesFrom(snapshot: BranchStepsSnapshot | null): StripEntry[] {
  const steps = snapshot?.steps ?? []

  // With no commits ahead of the base, the span and the tail read the SAME diff
  // — `merge-base == HEAD`, so both are HEAD → working tree. Two chips that
  // cannot differ is a control that lies about having a choice, and the item's
  // acceptance says so: "a branch with no commits ahead of the base shows only
  // the uncommitted step".
  if (steps.length === 0) {
    return snapshot?.hasUncommitted
      ? [{ key: 'uncommitted', label: 'Uncommitted', selection: { kind: 'uncommitted' } }]
      : [{ key: 'span', label: 'All changes', selection: { kind: 'span' } }]
  }

  const entries: StripEntry[] = [
    { key: 'span', label: `All commits ${steps.length}`, selection: { kind: 'span' } },
  ]
  if (snapshot?.hasUncommitted) {
    entries.push({ key: 'uncommitted', label: 'Uncommitted', selection: { kind: 'uncommitted' } })
  }
  for (const step of steps) {
    entries.push({
      key: step.hash,
      // The subject is the label a person recognises; the hash disambiguates
      // two commits that share one. An empty subject is legal, so the hash
      // stands alone rather than leaving a blank chip.
      label: step.subject.trim() || step.shortHash,
      hash: step.shortHash,
      isMerge: step.isMerge,
      selection: { kind: 'commit', hash: step.hash },
    })
  }
  return entries
}

/** The entry a selection points at, or the span when it no longer exists. */
export function selectedEntry(entries: StripEntry[], selection: BranchStepSelection): StripEntry {
  const match = entries.find((entry) => sameSelection(entry.selection, selection))
  // A rebase re-identifies commits, so the hash a person had selected can simply
  // stop existing between two reads. Falling back to the span keeps the surface
  // showing something true rather than an empty list under a dead chip.
  return match ?? entries[0]
}

export function sameSelection(left: BranchStepSelection, right: BranchStepSelection): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'commit' && right.kind === 'commit') return left.hash === right.hash
  return true
}

/**
 * Which two revisions a file's diff is read between, for one selection.
 *
 * `<hash>^` for a commit's original side is deliberate and covers the root
 * commit for free: there is no parent, the read fails, and the caller renders an
 * empty original — which is exactly right for a commit that created everything.
 */
export function revsForSelection(
  selection: BranchStepSelection,
  snapshot: BranchStepsSnapshot | null
): { originalRev: string | null; modifiedRev: string | 'worktree' } {
  if (selection.kind === 'commit') {
    return { originalRev: `${selection.hash}^`, modifiedRev: selection.hash }
  }
  if (selection.kind === 'uncommitted') {
    return { originalRev: 'HEAD', modifiedRev: 'worktree' }
  }
  // The span measures from the merge-base. Without one there is nothing to
  // measure from but HEAD, which is the folder reading and is what the row shows
  // in that case too.
  return { originalRev: snapshot?.baseOid ?? 'HEAD', modifiedRev: 'worktree' }
}

/**
 * The viewer's item list for a step.
 *
 * An added file has no original side and a deleted one has no modified side;
 * carrying that as `null` rather than as a revision means the loader never asks
 * git for an object it knows is absent, and never shows a read failure where the
 * honest answer is "empty".
 */
export function branchItemsFrom(
  diff: BranchStepDiff | null,
  selection: BranchStepSelection,
  snapshot: BranchStepsSnapshot | null,
  repoRoot: string
): BranchDiffItem[] {
  if (!diff) return []
  const { originalRev, modifiedRev } = revsForSelection(selection, snapshot)
  return diff.files.map((file) => ({
    path: joinFilePath(repoRoot, file.path),
    relativePath: file.path,
    status: file.status,
    kind: 'branch' as const,
    originalRev: file.status === 'new' ? null : originalRev,
    modifiedRev: file.status === 'deleted' ? null : modifiedRev,
    additions: file.additions,
    deletions: file.deletions,
  }))
}

/**
 * What the surface may claim about these numbers, in words — the same three-way
 * honesty the sidebar row carries, said at greater length because there is room.
 */
export function scopeNote(snapshot: BranchStepsSnapshot | null): string | null {
  switch (snapshot?.scope) {
    case 'worktree':
      return null
    case 'branch':
      return `This chat shares its checkout, so these are ${snapshot.branch ?? 'the branch'}’s changes — a person or another chat may have made some of them.`
    case 'folder':
      return snapshot.branch
        ? `Working on ${snapshot.branch}. There is no branch to measure, so this is what is uncommitted in the folder — not this chat’s work alone.`
        : 'No branch to measure, so this is what is uncommitted in the folder — not this chat’s work alone.'
    default:
      return null
  }
}
