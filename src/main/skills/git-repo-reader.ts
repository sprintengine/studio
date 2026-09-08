// Reading a skill or plugin repository over git instead of the GitHub API.
//
// The git-transport ruling (owner, 2026-09-08): GitHub's REST limit is what
// capped the linked-plugin follow at 20 repositories an hour for a machine
// without a token, and git's own protocol is not counted by it at all. So this
// reader answers the same three questions `github-tree.ts` did, over the git
// CLI, with no REST call anywhere:
//
//   head   → `git ls-remote`, one round trip, no clone;
//   tree   → a bare partial clone (`--filter=blob:none`) fetched at the pinned
//            commit, listed with `git ls-tree -r -t`;
//   file   → `git cat-file -p <sha>:<path>`, whose blob the promisor remote
//            fetches lazily on first read — which is the point of the filter:
//            a 200-plugin marketplace scan downloads trees, not contents.
//
// Everything it returns is shaped like the API listing (mode `040000` for a
// directory, `type` one of blob/tree/commit) because `scanSkillTree` reads those
// fields and must not be able to tell the two transports apart. The one field it
// cannot answer is `size`, which is optional and display-only — see the note at
// the `ls-tree` call for why asking git for it costs three and a half minutes a
// repository.

import { execFile } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  DEFAULT_SKILL_MAX_FILE_BYTES,
  DEFAULT_SKILL_MAX_LISTING_BYTES,
  DEFAULT_SKILL_MAX_TREE_ENTRIES,
} from './github-tree'
import type { SkillRepoReader } from './repo-reader'
import type { SkillTreeEntry } from './scan'

const DEFAULT_HOST = 'github.com'
const DEFAULT_CONCURRENCY = 8
const NETWORK_TIMEOUT_MS = 60_000
const LOCAL_TIMEOUT_MS = 15_000

/** Why a git read failed, for the copy that decides between "retry" and "give up". */
export type GitRepoReadErrorKind = 'offline' | 'unreadable' | 'timeout'

export class GitRepoReadError extends Error {
  constructor(
    readonly kind: GitRepoReadErrorKind,
    message: string,
    /** What git said on stderr, kept for the log; never shown raw to a user. */
    readonly stderr = ''
  ) {
    super(message)
    this.name = 'GitRepoReadError'
  }
}

export type GitRunOptions = { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
export type GitRunResult = { stdout: Buffer; stderr: string }
/** Runs `git` with these args and resolves its stdout, or rejects when git exits non-zero. */
export type RunGit = (args: string[], options: GitRunOptions) => Promise<GitRunResult>

export type GitRepoReaderOptions = {
  /** Directory the per-repository clones live under (the integrator passes `<userData>/skill-repos`). */
  cacheDir: string
  /** Host the `owner/name` names live on; default 'github.com'. */
  host?: string
  /**
   * Resolved GitHub token or ''. Used ONLY as an `Authorization: Bearer` header
   * via `-c http.extraHeader=…` on the commands that talk to the network — never
   * written into the clone's config or the remote URL, so a token that is later
   * revoked or rotated leaves nothing behind on disk to leak or to go stale.
   */
  resolveToken?: () => Promise<string>
  /** How many git processes may talk to the network at once; default 8. */
  concurrency?: number
  /** Per-command timeout, ms; default 60_000 for network commands, 15_000 for local ones. */
  timeoutMs?: number
  /** Injected in tests: runs `git` with these args in this cwd and returns stdout. */
  runGit?: RunGit
  /**
   * TEST ONLY. Builds the clone URL for a repository. The suite points this at a
   * fixture repository on disk so the whole reader can be exercised with the real
   * git binary and no network; production always uses `https://<host>/<owner>/<name>.git`.
   */
  remoteUrl?: (repo: string) => string
}

// ── Names, paths and URLs ────────────────────────────────────────────────────

// The pattern `parseSkillRepoRef` accepts, minus the three shapes that are fine
// in a URL but are not a directory name: `.`, `..`, and a leading dash. A repo
// name reaches here from a marketplace manifest we did not write, and it becomes
// both a path segment under the cache directory and a URL path segment, so it is
// checked before either is built rather than after.
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/

type ParsedRepo = { owner: string; name: string }

function parseRepo(repo: string): ParsedRepo {
  const segments = repo.trim().split('/')
  if (segments.length !== 2) throw refused(repo)
  const owner = segments[0]
  const name = segments[1].endsWith('.git') ? segments[1].slice(0, -4) : segments[1]
  for (const segment of [owner, name]) {
    if (!REPO_NAME_PATTERN.test(segment)) throw refused(repo)
    if (segment === '.' || segment === '..' || segment.startsWith('-')) throw refused(repo)
  }
  return { owner, name }
}

function refused(repo: string): GitRepoReadError {
  return new GitRepoReadError('unreadable', `"${repo}" is not a valid owner/name repository.`)
}

function checkedHost(host: string): string {
  if (!HOST_PATTERN.test(host) || host === '..') {
    throw new GitRepoReadError('unreadable', `"${host}" is not a valid git host.`)
  }
  return host
}

/** Where a repository's clone lives, so the integrator can report disk usage later. */
export function gitRepoCacheDir(cacheDir: string, host: string, repo: string): string {
  const { owner, name } = parseRepo(repo)
  return join(cacheDir, checkedHost(host), owner, `${name}.git`)
}

// ── Running git ──────────────────────────────────────────────────────────────

// Nothing may ever prompt: an Electron main process has no terminal to answer a
// credential question on, so a repository that asks would hang the scan instead
// of failing it. GIT_TERMINAL_PROMPT and GIT_ASKPASS close git's own doors,
// GCM_INTERACTIVE closes Git Credential Manager's, and an emptied
// `credential.helper` (set per-command below) stops the macOS keychain helper
// from opening a dialog. LC_ALL=C pins the messages this file classifies on.
function gitEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
    ...overrides,
  }
}

class GitProcessError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly timedOut: boolean,
    readonly overflow: boolean
  ) {
    super(message)
    this.name = 'GitProcessError'
  }
}

/**
 * The default runner. `maxBuffer` is the listing ceiling rather than a file's,
 * because one `ls-tree` of a 200k-entry repository is by far the largest thing
 * git hands back here — the same ceiling the API reader gives its tree call.
 */
export function defaultRunGit(args: string[], options: GitRunOptions): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        env: gitEnv(options.env),
        timeout: options.timeoutMs,
        maxBuffer: DEFAULT_SKILL_MAX_LISTING_BYTES,
        windowsHide: true,
        encoding: 'buffer',
      },
      (error, stdout, stderr) => {
        const errorText = stderr.toString('utf8')
        if (!error) {
          resolve({ stdout, stderr: errorText })
          return
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        reject(
          new GitProcessError(
            errorText.trim() || failure.message,
            errorText,
            failure.killed === true || typeof failure.signal === 'string',
            failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          )
        )
      }
    )
  })
}

/** True when a `git` the app can run is on PATH. The transport choice hangs on this. */
export async function isGitAvailable(runGit: RunGit = defaultRunGit): Promise<boolean> {
  try {
    await runGit(['--version'], { timeoutMs: LOCAL_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

// A refusal that will read the same way in an hour — the repository is gone,
// private, or behind SSO — must never be reported as "offline", or the caller
// retries forever. Checked first, because git wraps several of these in the
// same "unable to access" line that a genuinely unreachable host produces.
const GIT_REFUSAL = /not found|returned error: [45]\d\d|authentication failed|access denied|permission denied|does not appear to be a git repository|invalid username or password/i
const GIT_OFFLINE = /could not resolve host|could not resolve proxy|unable to access|connection refused|connection reset|network is unreachable|temporary failure in name resolution|failed to connect|operation timed out|could not read from remote repository|ssl/i

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  return line ?? ''
}

function classify(error: unknown, what: string): GitRepoReadError {
  if (error instanceof GitRepoReadError) return error
  const detail = error as
    | { stderr?: unknown; message?: unknown; timedOut?: unknown; overflow?: unknown; killed?: unknown }
    | undefined
  const stderr = typeof detail?.stderr === 'string' ? detail.stderr : ''
  const message = typeof detail?.message === 'string' ? detail.message : String(error)
  const text = `${stderr}\n${message}`
  if (detail?.overflow === true) {
    return new GitRepoReadError('unreadable', `This repository's file listing is larger than ${DEFAULT_SKILL_MAX_LISTING_BYTES} bytes.`, stderr)
  }
  if (detail?.timedOut === true || detail?.killed === true || /ETIMEDOUT/i.test(text)) {
    return new GitRepoReadError('timeout', `${what} took too long and was stopped.`, stderr)
  }
  if (!GIT_REFUSAL.test(text) && GIT_OFFLINE.test(text)) {
    return new GitRepoReadError('offline', `Could not reach the git host. ${firstLine(text)}`, stderr)
  }
  return new GitRepoReadError('unreadable', `${what} failed. ${firstLine(text)}`, stderr)
}

// ── Waiting in line ──────────────────────────────────────────────────────────

type Release = () => void

/** A plain counting semaphore: `limit` git processes may be on the network at once. */
function createSemaphore(limit: number): { acquire: () => Promise<Release> } {
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = (): Promise<Release> =>
    new Promise<Release>((resolve) => {
      const grant = (): void => {
        active += 1
        resolve(() => {
          active -= 1
          waiting.shift()?.()
        })
      }
      if (active < limit) grant()
      else waiting.push(grant)
    })
  return { acquire }
}

/**
 * One in-flight operation per clone directory. Two callers asking for the same
 * repository at the same time — which is exactly what the linked-plugin follow
 * does — would otherwise run two `git fetch`es into one directory and race over
 * its lockfiles.
 */
function createRepoLocks(): <T>(key: string, body: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>()
  return <T>(key: string, body: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.then(body, body)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

// ── The reader ───────────────────────────────────────────────────────────────

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/
// `<mode> SP <type> SP <sha> TAB <path>`, one NUL-terminated record per entry.
// `-z` is what makes this parseable: without it git quotes any path with a
// non-ASCII byte in it, and a skill repository full of emoji filenames would
// come back mangled.
const LS_TREE_ENTRY = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]*)$/

export function createGitRepoReader(options: GitRepoReaderOptions): SkillRepoReader {
  const host = checkedHost(options.host ?? DEFAULT_HOST)
  const runGit = options.runGit ?? defaultRunGit
  const network = createSemaphore(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY))
  const withRepoLock = createRepoLocks()
  const networkTimeoutMs = options.timeoutMs ?? NETWORK_TIMEOUT_MS
  const localTimeoutMs = options.timeoutMs ?? LOCAL_TIMEOUT_MS
  // A commit is immutable, so both of these are correct for the life of the
  // process: the listing never changes, and a commit already in the clone never
  // leaves it (nothing here ever deletes).
  const trees = new Map<string, readonly SkillTreeEntry[]>()
  const present = new Set<string>()

  const remoteUrl = (repo: string): string => {
    const { owner, name } = parseRepo(repo)
    return options.remoteUrl ? options.remoteUrl(repo) : `https://${host}/${owner}/${name}.git`
  }

  const cloneDir = (repo: string): string => gitRepoCacheDir(options.cacheDir, host, repo)

  /** The `-c` flags every network command carries: the token header, and no prompting helper. */
  const networkConfig = async (): Promise<string[]> => {
    const token = (await options.resolveToken?.())?.trim() ?? ''
    return [
      '-c',
      'credential.helper=',
      ...(token ? ['-c', `http.extraHeader=Authorization: Bearer ${token}`] : []),
    ]
  }

  const runNetwork = async (args: string[], cwd: string | undefined, what: string): Promise<GitRunResult> => {
    const release = await network.acquire()
    try {
      return await runGit([...(await networkConfig()), ...args], { cwd, timeoutMs: networkTimeoutMs })
    } catch (error) {
      throw classify(error, what)
    } finally {
      release()
    }
  }

  const runLocal = async (args: string[], cwd: string, what: string): Promise<GitRunResult> => {
    try {
      return await runGit(args, { cwd, timeoutMs: localTimeoutMs })
    } catch (error) {
      throw classify(error, what)
    }
  }

  const checkedSha = (repo: string, sha: string): string => {
    if (!SHA_PATTERN.test(sha)) {
      throw new GitRepoReadError('unreadable', `"${sha}" is not a commit SHA for ${repo}.`)
    }
    return sha
  }

  /** The bare, blob-filtered clone, created on first use and never removed. */
  const ensureClone = async (repo: string): Promise<string> => {
    const dir = cloneDir(repo)
    try {
      await access(join(dir, 'HEAD'))
      return dir
    } catch {
      // Not there yet.
    }
    await mkdir(dirname(dir), { recursive: true })
    // `init --bare` + the two `remote.origin.*` keys is byte-for-byte the config
    // `git clone --bare --filter=blob:none` writes, and it is the config alone
    // that arms the promisor: a later `cat-file` of a blob we never fetched goes
    // and gets it. Building it by hand is what lets the first fetch be of a bare
    // commit SHA rather than of a branch we would then have to guess.
    await runLocal(['init', '--bare', '-q', dir], dirname(dir), `Preparing a clone of ${repo}`)
    await runLocal(['remote', 'add', 'origin', remoteUrl(repo)], dir, `Preparing a clone of ${repo}`)
    await runLocal(['config', 'remote.origin.promisor', 'true'], dir, `Preparing a clone of ${repo}`)
    await runLocal(['config', 'remote.origin.partialclonefilter', 'blob:none'], dir, `Preparing a clone of ${repo}`)
    return dir
  }

  // GIT_NO_LAZY_FETCH is the whole point of this call. A promisor remote makes
  // `cat-file -e` on a missing object go and fetch it — one object, one round
  // trip — so without it "is the commit here?" quietly becomes "fetch the commit
  // alone", and the `ls-tree` after it then drags every directory down one at a
  // time. Git below 2.45 does not know the variable and falls back to that
  // behaviour: still correct, just slower, and only until the answer is cached.
  const hasCommit = async (dir: string, sha: string): Promise<boolean> => {
    try {
      await runGit(['cat-file', '-e', `${sha}^{commit}`], {
        cwd: dir,
        timeoutMs: localTimeoutMs,
        env: { GIT_NO_LAZY_FETCH: '1' },
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * The clone, holding that commit. Held under the repository's lock, so two
   * callers wanting the same commit produce one fetch and the second finds it
   * already there.
   */
  const ensureCommit = async (repo: string, sha: string): Promise<string> => {
    const key = `${host}/${repo}@${sha}`
    const dir = await ensureClone(repo)
    if (present.has(key)) return dir
    if (await hasCommit(dir, sha)) {
      present.add(key)
      return dir
    }
    // GitHub serves an unadvertised commit by full SHA (`uploadpack.allowAnySHA1InWant`),
    // which is what keeps a pinned marketplace entry to a single fetch of exactly
    // the commit it names — no branch guessing, no history we will not read.
    await runNetwork(
      ['fetch', '--filter=blob:none', '--no-tags', '--quiet', 'origin', sha],
      dir,
      `Fetching ${repo} at ${sha.slice(0, 7)}`
    )
    if (!(await hasCommit(dir, sha))) {
      throw new GitRepoReadError('unreadable', `${repo} does not contain the commit ${sha}.`)
    }
    present.add(key)
    return dir
  }

  const parseListing = (repo: string, stdout: Buffer): SkillTreeEntry[] => {
    const records = stdout.toString('utf8').split('\0')
    const entries: SkillTreeEntry[] = []
    for (const record of records) {
      if (record.length === 0) continue
      const match = LS_TREE_ENTRY.exec(record)
      if (!match) continue
      const [, mode, type, sha, path] = match
      // No `size`: see the note on `ls-tree` below. `SkillTreeEntry.size` is
      // optional and only ever displayed, so an entry without one is complete
      // for every decision the scanners make.
      entries.push({ path, mode, type, sha })
      if (entries.length > DEFAULT_SKILL_MAX_TREE_ENTRIES) {
        throw new GitRepoReadError(
          'unreadable',
          `${repo} lists more than ${DEFAULT_SKILL_MAX_TREE_ENTRIES} files, which is too large to scan.`
        )
      }
    }
    return entries
  }

  return {
    async resolveCommit(repo: string, ref: string): Promise<string> {
      const url = remoteUrl(repo)
      if (ref !== '' && !REF_PATTERN.test(ref)) {
        throw new GitRepoReadError('unreadable', `"${ref}" is not a valid ref for ${repo}.`)
      }
      // Ask for every shape the one name could be in a single round trip, then
      // pick in the order the API's `commits/{ref}` endpoint resolves them: a
      // branch, then a tag, then a literal ref name. An annotated tag's `^{}`
      // line carries the commit the tag points at, which is what a scan pins to —
      // the tag object's own SHA is not a commit and would fail every later read.
      const patterns =
        ref === '' ? ['HEAD'] : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`, ref]
      await mkdir(options.cacheDir, { recursive: true })
      const { stdout } = await runNetwork(
        ['ls-remote', url, ...patterns],
        options.cacheDir,
        `Reading the current commit of ${repo}`
      )
      const found = new Map<string, string>()
      for (const line of stdout.toString('utf8').split('\n')) {
        const [sha, name] = line.split('\t')
        if (!sha || !name) continue
        if (/^[0-9a-f]{40}$/.test(sha.trim())) found.set(name.trim(), sha.trim())
      }
      const order =
        ref === '' ? ['HEAD'] : [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`, ref]
      for (const name of order) {
        const sha = found.get(name)
        if (sha) return sha
      }
      throw new GitRepoReadError(
        'unreadable',
        ref === ''
          ? `${repo} has no default branch to read.`
          : `${repo} has no branch or tag named "${ref}".`
      )
    },

    async readTree(repo: string, sha: string): Promise<readonly SkillTreeEntry[]> {
      checkedSha(repo, sha)
      parseRepo(repo)
      const key = `${host}/${repo}@${sha}`
      const cached = trees.get(key)
      if (cached) return cached
      return withRepoLock(cloneDir(repo), async () => {
        const already = trees.get(key)
        if (already) return already
        const dir = await ensureCommit(repo, sha)
        // `-t` puts the directories in the listing: the API's recursive tree
        // returns them as `type: 'tree'`, and the scanners read that.
        //
        // What is deliberately NOT here is `-l`. `ls-tree --long` prints each
        // blob's size, and a blob's size is only knowable from the blob — so in
        // a `blob:none` clone git lazily fetches every file in the repository,
        // one round trip each, to print a column. Measured against
        // anthropics/claude-plugins-official: 3 minutes 31 seconds with `-l`,
        // 17 milliseconds without. Nothing in git's protocol offers a size
        // without the bytes, so the git transport lists sizeless blobs and the
        // API transport keeps its sizes. Only the file-list display reads
        // `size`; every scan decision is made from paths, modes and SHAs.
        const { stdout } = await runLocal(
          ['ls-tree', '-r', '-t', '-z', sha],
          dir,
          `Listing ${repo} at ${sha.slice(0, 7)}`
        )
        const entries = parseListing(repo, stdout)
        trees.set(key, entries)
        return entries
      })
    },

    async readFile(repo: string, sha: string, path: string): Promise<Buffer | null> {
      checkedSha(repo, sha)
      parseRepo(repo)
      if (path.length === 0 || path.includes('\0') || path.startsWith('/')) {
        throw new GitRepoReadError('unreadable', `"${path}" is not a path in ${repo}.`)
      }
      return withRepoLock(cloneDir(repo), async () => {
        const dir = await ensureCommit(repo, sha)
        const target = `${sha}:${path}`
        // `cat-file -s` is both the existence check and the cap check. It is
        // what pulls the blob in from the promisor, so unlike the API reader's
        // `content-length` the refusal lands after git has the bytes — git's
        // protocol has no way to ask a size without asking for the object.
        let size: Buffer
        try {
          size = (await runLocal(['cat-file', '-s', target], dir, `Reading ${path} from ${repo}`)).stdout
        } catch (error) {
          // A path that is not in this tree is an answer, not a failure — the
          // scanners ask for files they are not sure exist.
          if (error instanceof GitRepoReadError && isMissingPath(error.stderr, error.message)) return null
          throw error
        }
        const bytes = Number.parseInt(size.toString('utf8').trim(), 10)
        if (Number.isFinite(bytes) && bytes > DEFAULT_SKILL_MAX_FILE_BYTES) {
          throw new GitRepoReadError('unreadable', `A file in this repository is larger than ${DEFAULT_SKILL_MAX_FILE_BYTES} bytes.`)
        }
        const { stdout } = await runLocal(['cat-file', '-p', target], dir, `Reading ${path} from ${repo}`)
        return stdout
      })
    },
  }
}

// git says one of these when the rev exists but the path in it does not.
const MISSING_PATH = /does not exist in|exists on disk, but not in|not a valid object name|unknown revision or path/i

function isMissingPath(stderr: string, message: string): boolean {
  return MISSING_PATH.test(`${stderr}\n${message}`)
}
