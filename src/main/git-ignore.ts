import { runGitCommand } from './git-run'

// `git check-ignore` answers the question the tree actually asks — "would git
// ignore this?" — against the full rule stack (.gitignore at every depth, the
// repo's info/exclude, and the user's core.excludesFile). Re-implementing that
// in the renderer means shipping a second, worse ignore engine.
//
// Three behaviours of the command shape this module:
//
// 1. **Exit 1 means "nothing matched", not "it failed."** Only codes above 1
//    are real errors (128 = not a repository). Both come back with nothing on
//    stdout, so either answers "nothing ignored" here.
// 2. **The answer depends on the path existing.** A rule written `out/` matches
//    only a directory, and git decides directory-ness by looking at the disk.
//    Every caller here passes entries it has just listed, so they exist — but a
//    speculative path would answer "not ignored" and be wrong.
// 3. **`-z` requires `--stdin`.** The argv form has to be read back as
//    newline-split text, where a filename containing a newline splits into two
//    wrong answers and any path with a quote or a non-ASCII byte comes back in
//    git's `core.quotePath` escaping and matches nothing. NUL in, NUL out, no
//    escaping, no argv ceiling.
//
// It runs through the app's one git runner, so it gets the same read deadline
// as every other view read, and a repository inside a WSL distribution is
// asked of that distribution's git rather than of a Windows one.

/**
 * Which of `relativePaths` git ignores, as a Set of the same strings.
 *
 * Paths must be RELATIVE to `repoRoot` and use forward slashes — that is the
 * form git echoes back, and matching the reply to the request by string is what
 * lets the caller skip a second normalisation pass.
 *
 * Never rejects for an ordinary miss: a path outside the repo, a repo with no
 * commits, or a missing `git` on PATH all answer "nothing ignored" rather than
 * failing the tree render that asked for it.
 */
export async function checkIgnoredPaths(repoRoot: string, relativePaths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  if (relativePaths.length === 0) return ignored
  const result = await runGitCommand(repoRoot, ['check-ignore', '-z', '--stdin'], undefined, {
    stdin: relativePaths.map((path) => `${path}\0`).join(''),
  })
  if (!result.ok) return ignored
  for (const path of result.stdout.split('\0')) {
    if (path) ignored.add(path)
  }
  return ignored
}
