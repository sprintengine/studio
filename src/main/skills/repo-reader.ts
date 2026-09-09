import type { SkillTreeEntry } from './scan'

// The one shape every reader of a skill or plugin repository answers to — the
// source's own scan, the linked-plugin follow, the update check and the skill
// file copy all read through it (git-transport ruling, owner 2026-09-08).
//
// Why an interface: GitHub's REST API is what the anonymous 60-an-hour limit
// counts, and the tree listing that scan needed per repository is a REST
// call. Git's own protocol is not counted at all, and it already answers every
// question the API did — `ls-remote` for a head, a partial clone at a pinned
// commit for the tree, a lazily fetched blob for a file — while bringing down
// only the objects that changed. So the reader over git (`git-repo-reader.ts`)
// is the one the app uses whenever git is installed, and the reader over the
// API (`github-tree.ts`, wrapped by the skills service) is the fallback for a
// machine without it. Both answer this, and nothing above them knows which.
//
// `repo` is always `owner/name`, never a URL: every caller already holds the
// two halves, and a reader chooses the host it speaks to.

export type SkillRepoReader = {
  /**
   * The commit a ref names right now — a branch, a tag, or '' for the
   * repository's default branch. One round trip; the answer is what the update
   * check compares with the commit a source was scanned at.
   */
  resolveCommit(repo: string, ref: string): Promise<string>
  /**
   * Every path in the repository at that commit, blobs and trees, in the shape
   * the scanners walk. The commit is pinned, so a reader may cache this forever.
   */
  readTree(repo: string, sha: string): Promise<readonly SkillTreeEntry[]>
  /**
   * One file's bytes at that commit, or null when the path is not there. A
   * reader throws (a `SkillFetchError` or its own error) only for a failure
   * that is about the moment — no network, a refusal — never for a missing
   * file, which the scanners treat as an answer.
   */
  readFile(repo: string, sha: string, path: string): Promise<Buffer | null>
}

/**
 * Which transport a reader speaks, for the copy that says why a cadence or a
 * limit applies. It is DEFINED in `src/shared/skills.ts` — the renderer says
 * those sentences and cannot import main — and re-exported here so this file
 * stays the whole contract a reader is written against.
 */
export type { SkillRepoTransport } from '../../shared/skills'
