// Per-hunk staging — git-commit-window T7, "include a hunk".
//
// The one rule this module exists to enforce: **the patch is produced here**.
// The renderer names a hunk (a position hint and a fingerprint of its body);
// this file reads the diff again, finds that hunk in the diff it just read, and
// writes the patch from git's own header lines. Nothing that arrived over IPC
// is ever concatenated into a patch, so a compromised or merely stale renderer
// cannot write into the index something git did not just say was there.
//
// The second rule follows from the first: **nothing is cached**. Staging one
// hunk rewrites every later hunk's line numbers and the file's blob ids, so the
// diff is re-read immediately before every apply, and the hunk is found in it
// by content (`locateHunk`). An offset that was true when the box was drawn is
// not evidence a second later.

import { execFile } from 'child_process'
import { isAbsolute } from 'path'

import type { GitCommandResult } from './git'
import { getRelativeGitPath, runGitCommand, toPosixPath } from './git-utils'
import {
  formatHunkHeader,
  hunkFingerprint,
  locateHunk,
  parseUnifiedDiff,
  summariseInclusion,
  type DiffHunk,
  type GitFileHunksResult,
  type GitHunkRef,
  type GitHunkScope,
  type GitHunkView,
  type ParsedFileDiff,
} from '../shared/git/hunks'

/**
 * `git diff`, pinned.
 *
 * Three of a person's own settings would otherwise produce a diff no patch can
 * be built from, silently: `diff.noprefix` and `diff.mnemonicPrefix` rewrite the
 * `a/` `b/` prefixes `git apply -p1` counts on, and `diff.external` /
 * a textconv filter replace the content entirely with something that is not a
 * patch at all. `--no-color` is belt and braces for a `color.ui = always`.
 */
function diffArgs(scope: GitHunkScope, relativePath: string): string[] {
  return [
    '-c', 'diff.noprefix=false',
    '-c', 'diff.mnemonicPrefix=false',
    'diff',
    ...(scope === 'staged' ? ['--cached'] : []),
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    // Rename detection is off on purpose. A rename WITH a content change puts
    // `rename from` / `rename to` in the header every one-hunk patch replays,
    // so the first hunk would carry the rename with it and the second would
    // then be refused — the file it names having already moved in the index.
    // Without detection the same change is a deletion of one path and an
    // addition of another, which is two files that each behave.
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-U0',
    '--',
    // `:(literal)` because a path IS a pathspec to git: a file called
    // `[id].tsx` is a character class, and `a?b.ts` would match `axb.ts`. The
    // renderer hands over the name of a real file, and this says so.
    `:(literal)${relativePath}`,
  ]
}

/**
 * The path, as git wants to hear it, and only if it is this repository's to
 * give. `getRelativeGitPath` resolves a relative path against the PROCESS's
 * working directory, which is not the repository — so a path that already is
 * relative is taken as given, and one that is absolute is made relative to the
 * root. Either way it must land inside the root: the renderer names the file,
 * and a name that climbs out with `..` is refused rather than diffed.
 */
function repoRelativePath(repoRoot: string, filePath: string): string | null {
  const relativePath = isAbsolute(filePath)
    ? getRelativeGitPath(repoRoot, filePath)
    : toPosixPath(filePath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) return null
  return relativePath
}

type FileDiffRead = { ok: true; file: ParsedFileDiff | null } | { ok: false; message: string }

async function readFileDiff(
  repoRoot: string,
  relativePath: string,
  scope: GitHunkScope
): Promise<FileDiffRead> {
  const result = await runGitCommand(repoRoot, diffArgs(scope, relativePath))
  if (!result.ok) return { ok: false, message: result.message ?? result.stderr ?? 'Could not read the diff.' }
  const files = parseUnifiedDiff(result.stdout)
  // `-- <path>` means at most one entry; a rename that git chose to pair could
  // in principle report one, and taking the first is the same answer either way.
  return { ok: true, file: files[0] ?? null }
}

async function isUntracked(repoRoot: string, relativePath: string): Promise<boolean> {
  const result = await runGitCommand(repoRoot, ['ls-files', '--cached', '--', `:(literal)${relativePath}`])
  if (!result.ok) return false
  return result.stdout.trim() === ''
}

function toHunkViews(hunks: DiffHunk[], scope: GitHunkScope): GitHunkView[] {
  return hunks.map((hunk, index) => ({
    index,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    fingerprint: hunkFingerprint(hunk),
    // A hunk's include state IS its scope: the staged diff is HEAD↔index, so
    // every hunk in it is in the index; the unstaged diff is index↔worktree, so
    // none of its hunks is. There is no third answer at hunk granularity — the
    // mixed state belongs to the FILE, and the summary below is where it shows.
    included: scope === 'staged',
  }))
}

/**
 * The hunks of the diff the viewer is showing, and the whole file's counter.
 *
 * Both diffs are read every time, because the counter is about the file and the
 * boxes are about one side of it: `staged` (HEAD→index) is the included half,
 * `unstaged` (index→worktree) is the rest, and they partition the file's
 * differences between them (see `summariseInclusion`).
 */
export async function readFileHunks(
  repoRoot: string,
  filePath: string,
  scope: GitHunkScope
): Promise<GitFileHunksResult> {
  const relativePath = repoRelativePath(repoRoot, filePath)
  if (!relativePath) return { ok: false, message: 'That file is not in this repository.' }
  const [staged, unstaged] = await Promise.all([
    readFileDiff(repoRoot, relativePath, 'staged'),
    readFileDiff(repoRoot, relativePath, 'unstaged'),
  ])
  if (!staged.ok) return { ok: false, message: staged.message }
  if (!unstaged.ok) return { ok: false, message: unstaged.message }

  if (staged.file?.binary || unstaged.file?.binary) {
    return { ok: true, scope, hunks: [], summary: null, unsupported: 'binary' }
  }

  if (!staged.file && !unstaged.file && (await isUntracked(repoRoot, relativePath))) {
    // An untracked file is not in any diff, so there is nothing to count and no
    // hunk to include on its own. The whole-file box is the only control that
    // means anything here, and the counter says the shorter true thing.
    return { ok: true, scope, hunks: [], summary: null, unsupported: 'untracked' }
  }

  const stagedHunks = staged.file?.hunks ?? []
  const unstagedHunks = unstaged.file?.hunks ?? []
  return {
    ok: true,
    scope,
    hunks: toHunkViews(scope === 'staged' ? stagedHunks : unstagedHunks, scope),
    summary: summariseInclusion(stagedHunks, unstagedHunks),
    unsupported: null,
  }
}

/**
 * A one-hunk patch, built from git's own header for this file plus this one
 * hunk. Replaying the header verbatim is what makes the awkward cases correct
 * without this function knowing they exist: `new file mode` + `--- /dev/null`
 * for a creation, `deleted file mode` + `+++ /dev/null` for a removal, the mode
 * line of a chmod, and the `index` blob ids git apply checks the preimage
 * against. The body keeps every byte git wrote — the `\r` of a CRLF file and the
 * `\ No newline at end of file` marker included.
 */
export function buildOneHunkPatch(file: ParsedFileDiff, hunk: DiffHunk): string {
  return [...file.header, formatHunkHeader(hunk), ...hunk.lines, ''].join('\n')
}

/**
 * `git apply` with the patch on stdin. `runGitCommand` cannot do this — it has
 * no stdin — and writing the patch to a temp file would leave the person's
 * changes lying in /tmp.
 */
function applyPatch(repoRoot: string, args: string[], patch: string): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', repoRoot, ...args],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        const err = (stderr ?? '').trim()
        if (!error) {
          resolve({ ok: true, stdout: stdout ?? '', stderr: err, message: null })
          return
        }
        resolve({
          ok: false,
          stdout: stdout ?? '',
          stderr: err,
          // git apply's own words, which say WHICH line failed to match — the
          // most useful thing anyone can be told when a patch is refused.
          message: err || (error as Error).message || 'git apply failed.',
        })
      }
    )
    // git exits before reading the whole patch when it rejects one; the EPIPE
    // that follows is not the failure and must not become an unhandled error.
    child.stdin?.on('error', () => {})
    child.stdin?.end(patch)
  })
}

const NOT_FOUND: Record<'gone' | 'ambiguous', string> = {
  gone: 'That change is no longer there — the file moved under the diff. It has been re-read.',
  ambiguous: 'That change appears more than once in this file and could not be told apart. Include the whole file instead.',
}

async function applyHunk(ref: GitHunkRef, reverse: boolean): Promise<GitCommandResult> {
  const { repoRoot, scope } = ref
  const relativePath = repoRelativePath(repoRoot, ref.filePath)
  if (!relativePath) {
    return { ok: false, stdout: '', stderr: '', message: 'That file is not in this repository.' }
  }
  const read = await readFileDiff(repoRoot, relativePath, scope)
  if (!read.ok) return { ok: false, stdout: '', stderr: '', message: read.message }

  const file = read.file
  if (!file) {
    return { ok: false, stdout: '', stderr: '', message: NOT_FOUND.gone }
  }
  if (file.binary) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      message: 'A binary file cannot be included one change at a time — include the whole file.',
    }
  }

  const located = locateHunk(file.hunks, ref.index, ref.fingerprint)
  if (!located.ok) return { ok: false, stdout: '', stderr: '', message: NOT_FOUND[located.reason] }

  const patch = buildOneHunkPatch(file, located.hunk)
  return applyPatch(
    repoRoot,
    ['apply', '--cached', ...(reverse ? ['--reverse'] : []), '--unidiff-zero', '-'],
    patch
  )
}

/**
 * Put one hunk of the working tree into the index. The hunk is named in the
 * UNSTAGED diff (index→worktree), which is exactly the coordinate system
 * `git apply --cached` applies in, so the patch needs no adjusting.
 */
export async function stageGitHunk(ref: GitHunkRef): Promise<GitCommandResult> {
  if (ref.scope !== 'unstaged') {
    return { ok: false, stdout: '', stderr: '', message: 'Only an unstaged change can be included.' }
  }
  return applyHunk(ref, false)
}

/**
 * Take one hunk back out of the index. The hunk is named in the STAGED diff
 * (HEAD→index), and removing it is that same patch applied in reverse — which
 * is why the diff is re-read first: reverse-applying a hunk the index no longer
 * has is the failure this guards against, and git's own refusal is what the
 * band would otherwise show.
 */
export async function unstageGitHunk(ref: GitHunkRef): Promise<GitCommandResult> {
  if (ref.scope !== 'staged') {
    return { ok: false, stdout: '', stderr: '', message: 'Only an included change can be taken out.' }
  }
  return applyHunk(ref, true)
}
