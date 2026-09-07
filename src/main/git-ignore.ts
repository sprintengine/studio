import { spawn } from 'child_process'

// `git check-ignore` answers the question the tree actually asks — "would git
// ignore this?" — against the full rule stack (.gitignore at every depth, the
// repo's info/exclude, and the user's core.excludesFile). Re-implementing that
// in the renderer means shipping a second, worse ignore engine.
//
// Three behaviours of the command shape this module:
//
// 1. **Exit 1 means "nothing matched", not "it failed."** Only codes above 1
//    are real errors (128 = not a repository).
// 2. **The answer depends on the path existing.** A rule written `out/` matches
//    only a directory, and git decides directory-ness by looking at the disk.
//    Every caller here passes entries it has just listed, so they exist — but a
//    speculative path would answer "not ignored" and be wrong.
// 3. **`-z` requires `--stdin`.** Hence spawn rather than execFile: the argv
//    form has to be read back as newline-split text, where a filename
//    containing a newline splits into two wrong answers and any path with a
//    quote or a non-ASCII byte comes back in git's `core.quotePath` escaping
//    and matches nothing. NUL in, NUL out, no escaping, no argv ceiling.
const CHECK_IGNORE_EXIT_NO_MATCH = 1

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
export function checkIgnoredPaths(repoRoot: string, relativePaths: string[]): Promise<Set<string>> {
  if (relativePaths.length === 0) return Promise.resolve(new Set<string>())

  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoRoot, 'check-ignore', '-z', '--stdin'], {
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' },
    })

    let stdout = ''
    let settled = false
    const finish = (paths: Set<string>) => {
      if (settled) return
      settled = true
      resolve(paths)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    // Draining stderr matters: git writes a "fatal:" line when the path spec is
    // bad, and an unread pipe that fills would leave the child wedged.
    child.stderr.resume()

    child.on('error', () => finish(new Set<string>()))

    child.on('close', (code) => {
      if (code !== 0 && code !== CHECK_IGNORE_EXIT_NO_MATCH) {
        finish(new Set<string>())
        return
      }
      const ignored = new Set<string>()
      for (const path of stdout.split('\0')) {
        if (path) ignored.add(path)
      }
      finish(ignored)
    })

    // EPIPE if git exits before the whole list is written (it does not, but a
    // crashed child would); the `error` handler above has already answered.
    child.stdin.on('error', () => {})
    child.stdin.end(relativePaths.map((path) => `${path}\0`).join(''))
  })
}
