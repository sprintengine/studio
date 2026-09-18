// Staging a CHANGELIST's hunks — the half of agent changelists that touches the
// index (epic `git-commit-window`, agent-changelists Wave 3).
//
// A guest row in the panel says "this list owns some of this file's lines". Its
// tick therefore cannot be `git add <file>`: that would put another agent's
// lines in the index under this list's name, which is the one failure the whole
// feature exists to prevent. So it is a loop over the file's hunks instead —
// read them, ask the shared model who owns each one, and stage or unstage only
// the ones that answer with this list.
//
// THREE THINGS THIS FILE DOES NOT DO, on purpose:
//
//   IT BUILDS NO PATCH. `git:stage-hunk` takes a REFERENCE — scope, index hint,
//   fingerprint — and main reads the diff again and writes the patch itself
//   (shared/git/hunks). A patch synthesised here is a patch nobody could apply.
//
//   IT DOES NOT TRUST THE INDEX HINT. Staging one hunk renumbers every later
//   one, so the loop hands over the fingerprint too and main's `locateHunk`
//   finds the hunk by its body. That is what makes the order of the loop a
//   detail rather than a decision.
//
//   IT DOES NOT STOP AT THE FIRST FAILURE. A hunk that has moved out from under
//   the read (`gone`, `ambiguous`) must not cost the other nine their staging;
//   the count of what landed and the first message come back together, and the
//   panel says both.
//
// Pure but for the three IPC calls it is handed: the api is an argument, so the
// arithmetic is testable without a `window`.

import { hunkOwnerId, type Changelist } from '../../../../../shared/git/changelists'
import {
  hunkToggleScope,
  type GitFileHunksResult,
  type GitHunkRef,
  type GitHunkScope,
} from '../../../../../shared/git/hunks'
import type { GitCommandResult } from '../../../../../shared/electron-api'
import { changeRowKey } from './gitChangesModel'

/** One file a changelist owns a piece of. `relativePath` is the spelling the
 *  store's spans are keyed by; `path` is the one git took. */
export type ChangelistHunkTarget = {
  path: string
  relativePath: string
  changelistId: string
}

/** The three calls this needs, named rather than reached for, so a test can
 *  hand over three functions and no DOM. */
export type ChangelistHunkApi = {
  getGitFileHunks: (repoRoot: string, filePath: string, scope: GitHunkScope) => Promise<GitFileHunksResult>
  stageGitHunk: (ref: GitHunkRef) => Promise<GitCommandResult>
  unstageGitHunk: (ref: GitHunkRef) => Promise<GitCommandResult>
}

export type ChangelistHunkOutcome = {
  ok: boolean
  /** How many hunks this list owned and were on the wrong side of the index. */
  attempted: number
  /** How many actually moved. */
  applied: number
  /** The first thing that went wrong, or null. */
  message: string | null
}

/**
 * Stage (or unstage) exactly the hunks `target.changelistId` owns, in every
 * file named.
 *
 * Which hunks are candidates is decided by the index, not by the scope argument
 * of the read: `getGitFileHunks` returns the UNION of both diffs with an
 * `included` flag (shared/git/hunks — "the boxes are the union"), so staging
 * wants the ones that are not in the index and unstaging the ones that are.
 * The scope passed to the read only picks which text a viewer would show, and
 * this has no viewer; it is passed the side being worked on so a future main
 * that reads it sees the honest intent.
 *
 * KNOWN LIMIT: ownership is decided from the hunk's NEW-side lines, which for a
 * staged hunk are index coordinates rather than worktree ones. For staging (the
 * common direction) the two agree, because an unstaged hunk's new side IS the
 * worktree. For unstaging a file whose worktree has moved on since the hunk was
 * staged, the answer can drift; the remainder rule then hands the hunk to the
 * file's home list, which errs towards leaving a guest's lines alone.
 */
export async function applyChangelistHunks(input: {
  repoRoot: string
  changelists: Changelist[]
  targets: ChangelistHunkTarget[]
  intent: 'stage' | 'unstage'
  api: ChangelistHunkApi
}): Promise<ChangelistHunkOutcome> {
  const { repoRoot, changelists, targets, intent, api } = input
  const wantIncluded = intent === 'unstage'
  const readScope: GitHunkScope = intent === 'stage' ? 'unstaged' : 'staged'
  let attempted = 0
  let applied = 0
  let message: string | null = null
  const fail = (text: string): void => {
    if (message === null) message = text
  }

  for (const target of targets) {
    let read: GitFileHunksResult
    try {
      read = await api.getGitFileHunks(repoRoot, target.path, readScope)
    } catch (error) {
      fail(`${target.relativePath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!read.ok) {
      fail(`${target.relativePath}: ${read.message}`)
      continue
    }
    if (read.unsupported) {
      // A binary or untracked file has no hunks to divide, so there is nothing
      // this list could own a piece of. Saying so beats a silent zero.
      fail(`${target.relativePath} has no per-hunk changes (${read.unsupported}).`)
      continue
    }
    const owned = read.hunks.filter(
      (hunk) =>
        hunk.included === wantIncluded && hunkOwnerId(changelists, target.relativePath, hunk) === target.changelistId,
    )
    for (const hunk of owned) {
      attempted += 1
      const ref: GitHunkRef = {
        repoRoot,
        filePath: target.path,
        // The hunk's OWN side of the index, which is what a stage or an unstage
        // is a patch of — the same rule the diff viewer's boxes follow.
        scope: hunkToggleScope(hunk),
        index: hunk.index,
        fingerprint: hunk.fingerprint,
      }
      try {
        const result = wantIncluded ? await api.unstageGitHunk(ref) : await api.stageGitHunk(ref)
        if (result.ok) applied += 1
        else fail(result.message ?? result.stderr ?? `Could not change ${target.relativePath}.`)
      } catch (error) {
        fail(`${target.relativePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return { ok: message === null, attempted, applied, message }
}

/** The rows a panel action must send through `applyChangelistHunks` rather than
 *  through `git:stage` — every guest row that knows which list it speaks for. */
export function changelistHunkTargets(
  rows: Array<{ path: string; relativePath: string; partial?: boolean; changelistId?: string }>,
): ChangelistHunkTarget[] {
  const seen = new Set<string>()
  const targets: ChangelistHunkTarget[] = []
  for (const row of rows) {
    if (row.partial !== true || !row.changelistId) continue
    const key = changeRowKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ path: row.path, relativePath: row.relativePath, changelistId: row.changelistId })
  }
  return targets
}
