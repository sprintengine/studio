// The git transport, against a real repository built by the real git binary.
//
// Nothing here is mocked except the two cases a fixture cannot produce — an
// unreachable host and a timeout — because the whole point of this reader is
// what git actually does: whether `ls-remote` peels an annotated tag, whether a
// bare `init` plus two config keys really arms the promisor, whether a fetch of
// an unadvertised SHA is served. A double would have answered "yes" to all of
// those regardless.
//
// The fixture repository sets `uploadpack.allowFilter` and
// `uploadpack.allowAnySHA1InWant`, which is what github.com already has on, and
// is served over `file://` so the partial-clone protocol is genuinely used
// (a plain path takes git's local transport, which ignores the filter).

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_SKILL_MAX_FILE_BYTES } from './github-tree'
import {
  createGitRepoReader,
  defaultRunGit,
  gitRepoCacheDir,
  GitRepoReadError,
  isGitAvailable,
  sweepGitRepoCache,
  type GitRunOptions,
  type GitRunResult,
} from './git-repo-reader'

const POSIX = process.platform !== 'win32'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const tests: Array<{ name: string; body: () => Promise<void> }> = []
function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(' ')}: ${stderr || error.message}`))
        else resolve(stdout.trim())
      },
    )
  })
}

type Fixture = {
  /** The working copy the fixture is served from, for the few tests that run git in it directly. */
  root: string
  url: string
  first: string
  second: string
  sidecar: string
  tagObject: string
  bigBlob: string
  /** A chain of commits longer than the listing cache holds, newest first. */
  ladder: string[]
}

async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'git-repo-reader-src-'))
  const write = async (path: string, body: string | Buffer): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), body)
  }

  await git(root, ['init', '-q', '-b', 'main', '.'])
  await git(root, ['config', 'user.email', 'fixture@example.com'])
  await git(root, ['config', 'user.name', 'Fixture'])
  await git(root, ['config', 'commit.gpgsign', 'false'])
  await git(root, ['config', 'uploadpack.allowFilter', 'true'])
  await git(root, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])

  await write('README.md', 'one\n')
  await write('plugins/x/.claude-plugin/plugin.json', '{"name":"x","version":"1.0.0"}\n')
  await write('skills/y/SKILL.md', '---\nname: y\n---\n\nDo the thing.\n')
  await write('skills/y/reference/notes.md', 'notes\n')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'one'])
  const first = await git(root, ['rev-parse', 'HEAD'])
  await git(root, ['branch', 'feature'])
  await git(root, ['tag', '-a', 'v1', '-m', 'release one'])
  const tagObject = await git(root, ['rev-parse', 'v1'])

  await write('README.md', 'two\n')
  // Just over the cap the API reader enforces, so the refusal is exercised for
  // real rather than by lowering the ceiling for the test.
  await write('big.bin', Buffer.alloc(DEFAULT_SKILL_MAX_FILE_BYTES + 1, 0x61))
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'two'])
  const second = await git(root, ['rev-parse', 'HEAD'])

  // A commit that is nobody's ancestor, so fetching it into a clone that already
  // holds `second` really is a second fetch — `git fetch <sha>` brings the whole
  // ancestry with it, and an older commit on the same line would already be there.
  await git(root, ['checkout', '-q', '-b', 'sidecar', first])
  await write('sidecar.md', 'off to one side\n')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'sidecar'])
  const sidecar = await git(root, ['rev-parse', 'HEAD'])
  await git(root, ['checkout', '-q', 'main'])
  const bigBlob = await git(root, ['rev-parse', `${second}:big.bin`])

  // A chain longer than the reader's listing cache, so eviction can be seen.
  // Empty commits: the point is the count of distinct commit SHAs, and one
  // `fetch` of the tip brings the whole chain with it.
  await git(root, ['checkout', '-q', '-b', 'ladder', second])
  for (let step = 0; step < 70; step += 1) await git(root, ['commit', '-q', '--allow-empty', '-m', `step ${step}`])
  const ladder = (await git(root, ['rev-list', '--max-count=70', 'HEAD'])).split('\n')
  await git(root, ['checkout', '-q', 'main'])

  return { root, url: `file://${root}`, first, second, sidecar, tagObject, bigBlob, ladder }
}

/** A repository whose server refuses `--filter`, which is what an old or plain git host does. */
async function buildUnfilteredFixture(): Promise<{ url: string; sha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'git-repo-reader-plain-'))
  await git(root, ['init', '-q', '-b', 'main', '.'])
  await git(root, ['config', 'user.email', 'fixture@example.com'])
  await git(root, ['config', 'user.name', 'Fixture'])
  await git(root, ['config', 'commit.gpgsign', 'false'])
  await git(root, ['config', 'uploadpack.allowFilter', 'false'])
  await git(root, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
  await writeFile(join(root, 'README.md'), 'plain\n')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-qm', 'one'])
  return { url: `file://${root}`, sha: await git(root, ['rev-parse', 'HEAD']) }
}

type Seen = { args: string[]; options: GitRunOptions }
type Spy = { runGit: typeof defaultRunGit; calls: string[][]; seen: Seen[] }

function spy(): Spy {
  const calls: string[][] = []
  const seen: Seen[] = []
  return {
    calls,
    seen,
    runGit: (args: string[], options: GitRunOptions): Promise<GitRunResult> => {
      calls.push(args)
      seen.push({ args, options })
      return defaultRunGit(args, options)
    },
  }
}

function countCommands(calls: string[][], command: string): number {
  return calls.filter((args) => args.includes(command)).length
}

function countFetches(calls: string[][]): number {
  return calls.filter((args) => args.includes('fetch')).length
}

async function cacheRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'git-repo-reader-cache-'))
}

async function main(): Promise<void> {
  if (!(await isGitAvailable())) {
    console.log('# skipped - git is not on PATH, and this suite is about what git actually does')
    return
  }

  const fixture = await buildFixture()
  const reader = (over: { cacheDir: string; runGit?: typeof defaultRunGit }) =>
    createGitRepoReader({
      cacheDir: over.cacheDir,
      host: 'github.com',
      runGit: over.runGit,
      remoteUrl: () => fixture.url,
    })

  run('git is available here', async () => {
    assert.equal(await isGitAvailable(), true)
    assert.equal(
      await isGitAvailable(() => Promise.reject(new Error('spawn ENOENT'))),
      false,
      'a machine without git says so rather than throwing',
    )
  })

  run('resolveCommit answers for HEAD, a branch and a tag', async () => {
    const reads = reader({ cacheDir: await cacheRoot() })
    assert.equal(await reads.resolveCommit('acme/widgets', ''), fixture.second, 'the default branch')
    assert.equal(await reads.resolveCommit('acme/widgets', 'main'), fixture.second)
    assert.equal(await reads.resolveCommit('acme/widgets', 'feature'), fixture.first)
    // The annotated tag's own object is not a commit: pinning to it would fail
    // every later read, so the peeled `^{}` line is what a tag resolves to.
    assert.notEqual(fixture.tagObject, fixture.first, 'the fixture tag really is annotated')
    assert.equal(await reads.resolveCommit('acme/widgets', 'v1'), fixture.first, 'the peeled commit')
  })

  run('a ref that is not there is unreadable, not offline', async () => {
    const reads = reader({ cacheDir: await cacheRoot() })
    await assert.rejects(
      () => reads.resolveCommit('acme/widgets', 'no-such-branch'),
      (error: unknown) =>
        error instanceof GitRepoReadError &&
        error.kind === 'unreadable' &&
        /no branch or tag named/.test(error.message),
    )
  })

  run('readTree lists blobs and trees the way the API does', async () => {
    const reads = reader({ cacheDir: await cacheRoot() })
    const entries = await reads.readTree('acme/widgets', fixture.second)
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))

    const skill = byPath.get('skills/y/SKILL.md')
    assert.ok(skill, 'the skill file is listed')
    assert.equal(skill.type, 'blob')
    assert.equal(skill.mode, '100644')
    assert.match(skill.sha, /^[0-9a-f]{40}$/)
    // Sizeless on purpose: `ls-tree --long` would fetch every blob in the
    // repository to print the column, which is the one thing `blob:none` exists
    // to avoid. Nothing the scanners decide reads it.
    assert.equal(skill.size, undefined, 'the git transport lists no blob sizes')

    const dir = byPath.get('skills/y')
    assert.ok(dir, 'directories appear too, which is what the scanners read')
    assert.equal(dir.type, 'tree')
    assert.equal(dir.mode, '040000', 'the same mode GitHub reports for a tree')
    assert.equal(dir.size, undefined, 'a tree carries no size, as in the API listing')

    assert.ok(byPath.has('plugins/x/.claude-plugin/plugin.json'), 'nested paths are full paths')
    assert.ok(byPath.has('skills/y/reference'), 'a subdirectory is listed as its own entry')
    assert.ok(byPath.has('skills/y/reference/notes.md'))
    assert.equal(byPath.get('README.md')?.mode, '100644')
  })

  run('readFile reads bytes, answers null for a path that is not there', async () => {
    const reads = reader({ cacheDir: await cacheRoot() })
    const plugin = await reads.readFile('acme/widgets', fixture.second, 'plugins/x/.claude-plugin/plugin.json')
    assert.ok(plugin, 'the blob came back')
    assert.equal(JSON.parse(plugin.toString('utf8')).name, 'x')

    // The blob is filtered out of the fetch and pulled in by the promisor on
    // this read; that it works at all is the whole reason for `blob:none`.
    const readme = await reads.readFile('acme/widgets', fixture.first, 'README.md')
    assert.equal(readme?.toString('utf8'), 'one\n', 'an older commit reads its own bytes')

    assert.equal(await reads.readFile('acme/widgets', fixture.second, 'nope/missing.md'), null)
  })

  run('a file over the cap is refused, listed or not', async () => {
    const cold = reader({ cacheDir: await cacheRoot() })
    await assert.rejects(
      () => cold.readFile('acme/widgets', fixture.second, 'big.bin'),
      (error: unknown) =>
        error instanceof GitRepoReadError &&
        error.message === `A file in this repository is larger than ${DEFAULT_SKILL_MAX_FILE_BYTES} bytes.`,
      'refused from `cat-file -s` when nothing has been listed yet',
    )

    const warm = reader({ cacheDir: await cacheRoot() })
    await warm.readTree('acme/widgets', fixture.second)
    await assert.rejects(
      () => warm.readFile('acme/widgets', fixture.second, 'big.bin'),
      (error: unknown) => error instanceof GitRepoReadError,
      'and refused just the same once the tree has been listed',
    )
  })

  run('a commit already in the clone is never fetched twice', async () => {
    const watcher = spy()
    const reads = reader({ cacheDir: await cacheRoot(), runGit: watcher.runGit })

    const first = await reads.readTree('acme/widgets', fixture.second)
    assert.equal(countFetches(watcher.calls), 1, 'the first read fetches once')

    const again = await reads.readTree('acme/widgets', fixture.second)
    assert.equal(countFetches(watcher.calls), 1, 'the second read fetches nothing')
    assert.deepEqual(again, first, 'and answers the same listing')

    await reads.readFile('acme/widgets', fixture.second, 'README.md')
    assert.equal(countFetches(watcher.calls), 1, 'nor does reading a file from it')

    // An ancestor of what we already hold costs nothing: `fetch <sha>` brought
    // the history with it, which is exactly why the update path is cheap.
    await reads.readTree('acme/widgets', fixture.first)
    assert.equal(countFetches(watcher.calls), 1, 'an ancestor is already in the clone')

    // A commit off the line we hold is a second fetch into the same clone, and
    // it brings only the objects that are new.
    const aside = await reads.readTree('acme/widgets', fixture.sidecar)
    assert.equal(countFetches(watcher.calls), 2)
    assert.ok(aside.some((entry) => entry.path === 'sidecar.md'))
    assert.ok(!aside.some((entry) => entry.path === 'big.bin'), "and it is that commit's own tree")
  })

  run('two callers racing one repository fetch once between them', async () => {
    const watcher = spy()
    const reads = reader({ cacheDir: await cacheRoot(), runGit: watcher.runGit })
    const [a, b] = await Promise.all([
      reads.readTree('acme/widgets', fixture.second),
      reads.readTree('acme/widgets', fixture.second),
    ])
    assert.equal(countFetches(watcher.calls), 1, 'the per-repository lock serialised them')
    assert.deepEqual(a, b)
  })

  run('a repository name that is not owner/name never reaches a process', async () => {
    const watcher = spy()
    const reads = reader({ cacheDir: await cacheRoot(), runGit: watcher.runGit })
    const refused = [
      '../../etc',
      'acme/../../etc',
      'acme/widgets/extra',
      'acme',
      'acme/wid gets',
      'acme/.',
      '-acme/widgets',
      'acme/wid;rm -rf /',
    ]
    for (const name of refused) {
      await assert.rejects(
        () => reads.readTree(name, 'a'.repeat(40)),
        (error: unknown) => error instanceof GitRepoReadError && error.kind === 'unreadable',
        `${name} is refused`,
      )
    }
    await assert.rejects(
      () => reads.readTree('acme/widgets', 'not-a-sha'),
      (error: unknown) => error instanceof GitRepoReadError && error.kind === 'unreadable',
    )
    assert.deepEqual(watcher.calls, [], 'no git process ran for any of them')
  })

  run('the cache directory is one path per host, owner and name', async () => {
    assert.equal(
      gitRepoCacheDir('/data/skill-repos', 'github.com', 'acme/widgets'),
      join('/data/skill-repos', 'github.com', 'acme', 'widgets.git'),
    )
    assert.equal(
      gitRepoCacheDir('/data/skill-repos', 'github.com', 'acme/widgets.git'),
      join('/data/skill-repos', 'github.com', 'acme', 'widgets.git'),
      'a clone-URL name and a plain name land in the same place',
    )
    assert.throws(() => gitRepoCacheDir('/data', 'github.com', 'acme/../evil'), GitRepoReadError)
  })

  run('an unreachable host reads as offline, a killed process as a timeout', async () => {
    const failing = (stderr: string, extra: Record<string, unknown> = {}) =>
      createGitRepoReader({
        cacheDir: '/tmp/never-used',
        remoteUrl: () => fixture.url,
        runGit: () => Promise.reject(Object.assign(new Error(stderr.trim()), { stderr, ...extra })),
      })

    const kinds = async (stderr: string, extra?: Record<string, unknown>): Promise<string> => {
      try {
        await failing(stderr, extra).resolveCommit('acme/widgets', '')
        return 'resolved'
      } catch (error) {
        return error instanceof GitRepoReadError ? error.kind : 'other'
      }
    }

    assert.equal(
      await kinds("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com\n"),
      'offline',
    )
    assert.equal(await kinds('fatal: unable to access: Failed to connect: Connection refused\n'), 'offline')
    assert.equal(await kinds('fatal: repository not found\n'), 'unreadable', 'a gone repository is not "offline"')
    assert.equal(
      await kinds("fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403\n"),
      'unreadable',
      'a refusal wearing the same "unable to access" wrapper is still a refusal',
    )
    assert.equal(await kinds('', { timedOut: true }), 'timeout')
    assert.equal(await kinds('fatal: the remote end hung up\n', { killed: true }), 'timeout')
  })

  // ── What a `cat-file` really is ────────────────────────────────────────────

  run('a cat-file that may fetch is run as a network command', async () => {
    const watcher = spy()
    const reads = createGitRepoReader({
      cacheDir: await cacheRoot(),
      host: 'github.com',
      runGit: watcher.runGit,
      remoteUrl: () => fixture.url,
      networkTimeoutMs: 41_000,
      localTimeoutMs: 7_000,
    })
    await reads.readFile('acme/widgets', fixture.second, 'README.md')

    // In a `blob:none` clone this is the call that pulls the blob down, so it
    // must carry what every other network command carries: the credential
    // config, and the longer of the two timeouts.
    const check = watcher.seen.find((call) => call.args.includes('--batch-check'))
    assert.ok(check, 'the file read went through --batch-check')
    assert.equal(check.options.timeoutMs, 41_000, 'the network timeout, not the local one')
    assert.equal(check.options.env?.GIT_CONFIG_KEY_0, 'credential.helper')
    assert.equal(check.options.env?.GIT_CONFIG_VALUE_0, '', 'no helper may open a dialog')

    const fetched = watcher.seen.find((call) => call.args.includes('fetch'))
    assert.equal(fetched?.options.timeoutMs, 41_000)
    const listing = watcher.seen.find((call) => call.args.includes('init'))
    assert.equal(listing?.options.timeoutMs, 7_000, 'a command that only touches the clone stays local')
    assert.equal(listing?.options.env, undefined, 'and carries no credential config at all')

    const both = createGitRepoReader({
      cacheDir: await cacheRoot(),
      remoteUrl: () => fixture.url,
      runGit: watcher.runGit,
      timeoutMs: 5_000,
    })
    const before = watcher.seen.length
    await both.readTree('acme/widgets', fixture.second)
    for (const call of watcher.seen.slice(before)) {
      assert.equal(call.options.timeoutMs, 5_000, 'the deprecated single option still sets both')
    }
  })

  run('eight reads of one repository are not serialised behind each other', async () => {
    let inFlight = 0
    let most = 0
    const runGit = async (args: string[], options: GitRunOptions): Promise<GitRunResult> => {
      if (!args.includes('--batch-check')) return defaultRunGit(args, options)
      inFlight += 1
      most = Math.max(most, inFlight)
      try {
        const result = await defaultRunGit(args, options)
        // Held open long enough that "did these overlap" is not a question
        // about how fast git is.
        await delay(40)
        return result
      } finally {
        inFlight -= 1
      }
    }
    const reads = createGitRepoReader({
      cacheDir: await cacheRoot(),
      remoteUrl: () => fixture.url,
      runGit,
    })
    // The clone first, so the eight below race only over reading, which is what
    // the per-repository lock used to serialise: eight SKILL.md reads of one
    // repository went one at a time.
    await reads.readTree('acme/widgets', fixture.second)
    const all = await Promise.all(
      Array.from({ length: 8 }, () => reads.readFile('acme/widgets', fixture.second, 'skills/y/SKILL.md')),
    )
    assert.ok(
      all.every((bytes) => bytes?.toString('utf8').includes('Do the thing')),
      'all eight read the file',
    )
    assert.ok(most >= 4, `reads overlapped (most at once: ${most})`)
  })

  // ── The token ──────────────────────────────────────────────────────────────

  run('the token never reaches an argv, and never a message', async () => {
    const token = 'ghp_notARealTokenButItWouldBeSecret'
    const watcher = spy()
    const reads = createGitRepoReader({
      cacheDir: await cacheRoot(),
      host: 'github.com',
      runGit: watcher.runGit,
      remoteUrl: () => fixture.url,
      resolveToken: async () => token,
    })
    await reads.resolveCommit('acme/widgets', 'main')
    await reads.readTree('acme/widgets', fixture.second)
    await reads.readFile('acme/widgets', fixture.second, 'README.md')

    for (const call of watcher.seen) {
      for (const arg of call.args) {
        assert.ok(!arg.includes(token), `no argv carries the token: ${call.args.join(' ')}`)
      }
    }
    // It is in the environment instead, scoped to this host's URL so a redirect
    // anywhere else cannot carry it.
    const network = watcher.seen.find((call) => call.args.includes('ls-remote'))
    assert.equal(network?.options.env?.GIT_CONFIG_COUNT, '2')
    assert.equal(network?.options.env?.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraHeader')
    assert.equal(network?.options.env?.GIT_CONFIG_VALUE_1, `Authorization: Bearer ${token}`)

    const failing = createGitRepoReader({
      cacheDir: await cacheRoot(),
      resolveToken: async () => token,
      remoteUrl: () => 'file:///nonexistent/gone.git',
    })
    const error = await failing.resolveCommit('acme/widgets', 'main').then(
      () => null,
      (reason: unknown) => reason,
    )
    assert.ok(error instanceof GitRepoReadError, 'the read failed, as it should have')
    assert.ok(!error.message.includes(token), 'and said nothing about the token')
    assert.ok(!error.stderr.includes(token))
    assert.ok(!String((error as Error).stack ?? '').includes(token))
  })

  run('a failure with nothing on stderr says the exit code, not the command', async () => {
    // Node's own error message for a failed child spells out the whole argv,
    // which is exactly what must never be reported.
    const secret = 'Authorization: Bearer ghp_neverPrintThis'
    const error = await defaultRunGit(['-c', `http.extraHeader=${secret}`, 'cat-file', '-e', '0'.repeat(40)], {
      cwd: fixture.root,
      timeoutMs: 15_000,
    }).then(
      () => null,
      (reason: unknown) => reason as Error,
    )
    assert.ok(error, 'git failed')
    assert.equal(error.message, 'git exited with code 1')
    assert.ok(!error.message.includes(secret))
  })

  // ── Killing a command kills what it started ────────────────────────────────

  run('a timed-out command takes its grandchildren with it', async () => {
    if (!POSIX) {
      console.log('  (skipped: no process groups on this platform)')
      return
    }
    const marker = join(await mkdtemp(join(tmpdir(), 'git-repo-reader-kill-')), 'promisor-stand-in')
    // A `cat-file` that lazily fetches has a `git fetch` grandchild; this alias
    // is a stand-in for it that is easy to look for in the process table.
    const error = await defaultRunGit(['-c', `alias.slow=!sh -c 'sleep 43; touch ${marker}'`, 'slow'], {
      cwd: fixture.root,
      timeoutMs: 400,
    }).then(
      () => null,
      (reason: unknown) => reason as Error & { timedOut?: boolean },
    )
    assert.ok(error, 'the command was stopped')
    assert.equal(error.timedOut, true)
    await delay(300)
    const table = await new Promise<string>((resolve) => {
      execFile('ps', ['-ax', '-o', 'command'], { maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) =>
        resolve(stdout ?? ''),
      )
    })
    assert.ok(!table.includes(marker), 'the grandchild died with the group rather than outliving it')
  })

  run('stdout comes back whole, however many chunks it arrives in', async () => {
    const { stdout } = await defaultRunGit(['cat-file', '-p', fixture.bigBlob], {
      cwd: fixture.root,
      timeoutMs: 30_000,
    })
    assert.equal(stdout.byteLength, DEFAULT_SKILL_MAX_FILE_BYTES + 1, 'every chunk was kept')
  })

  // ── Missing, or unreachable ────────────────────────────────────────────────

  run('a promisor fetch that failed is a failure, not a missing file', async () => {
    const cacheDir = await cacheRoot()
    const reads = reader({ cacheDir })
    await reads.readTree('acme/widgets', fixture.second)
    const dir = gitRepoCacheDir(cacheDir, 'github.com', 'acme/widgets')
    // The trees are here; the blobs are not, and now cannot be fetched.
    await git(dir, ['config', 'remote.origin.url', 'file:///nonexistent/gone.git'])

    const error = await reads.readFile('acme/widgets', fixture.second, 'skills/y/reference/notes.md').then(
      (value) => value,
      (reason: unknown) => reason,
    )
    assert.ok(error instanceof GitRepoReadError, 'a file we could not fetch is not "there is no such file"')
    assert.notEqual(error.kind, 'timeout')
    assert.equal(
      await reads.readFile('acme/widgets', fixture.second, 'nope/missing.md'),
      null,
      'and a path that really is not in the tree is still an answer',
    )
  })

  run('a cache directory deleted mid-process is rebuilt, not served empty', async () => {
    const watcher = spy()
    const cacheDir = await cacheRoot()
    const reads = reader({ cacheDir, runGit: watcher.runGit })
    const bytes = await reads.readFile('acme/widgets', fixture.second, 'README.md')
    assert.equal(countFetches(watcher.calls), 1)

    await rm(gitRepoCacheDir(cacheDir, 'github.com', 'acme/widgets'), { recursive: true, force: true })
    const again = await reads.readFile('acme/widgets', fixture.second, 'README.md')
    assert.deepEqual(again, bytes, 'the same bytes came back')
    assert.equal(countFetches(watcher.calls), 2, 'because the commit was fetched into the rebuilt clone')
  })

  run('a clone left without a remote is finished rather than failing forever', async () => {
    // What a crash between `init --bare` and the remote config leaves behind.
    const cacheDir = await cacheRoot()
    const dir = gitRepoCacheDir(cacheDir, 'github.com', 'acme/widgets')
    await mkdir(dirname(dir), { recursive: true })
    await git(dirname(dir), ['init', '--bare', '-q', dir])
    assert.ok(await exists(join(dir, 'HEAD')), 'it has a HEAD, which is what readiness used to mean')

    const reads = reader({ cacheDir })
    const entries = await reads.readTree('acme/widgets', fixture.second)
    assert.ok(
      entries.some((entry) => entry.path === 'skills/y/SKILL.md'),
      'the half-written clone was completed instead of failing on a missing origin',
    )
  })

  // ── Hosts that cannot serve us ─────────────────────────────────────────────

  run('a host that ignores the filter is refused, and the next repository fails fast', async () => {
    const plain = await buildUnfilteredFixture()
    const watcher = spy()
    const reads = createGitRepoReader({
      cacheDir: await cacheRoot(),
      host: 'github.com',
      runGit: watcher.runGit,
      remoteUrl: () => plain.url,
    })
    await assert.rejects(
      () => reads.readTree('acme/widgets', plain.sha),
      (error: unknown) =>
        error instanceof GitRepoReadError &&
        error.kind === 'unreadable' &&
        /does not support partial clone/.test(error.message),
      'a server that ignored --filter has just sent the whole repository',
    )
    const fetches = countFetches(watcher.calls)
    await assert.rejects(
      () => reads.readTree('acme/other', plain.sha),
      (error: unknown) => error instanceof GitRepoReadError && /does not support partial clone/.test(error.message),
    )
    assert.equal(countFetches(watcher.calls), fetches, 'the second repository on that host never fetched')
  })

  run('a commit no ref points at, on a host that will not serve one, says so', async () => {
    const runGit = (args: string[], options: GitRunOptions): Promise<GitRunResult> => {
      if (!args.includes('fetch')) return defaultRunGit(args, options)
      const stderr =
        'error: Server does not allow request for unadvertised object 1234567890123456789012345678901234567890\n'
      return Promise.reject(Object.assign(new Error(stderr.trim()), { stderr }))
    }
    const reads = createGitRepoReader({
      cacheDir: await cacheRoot(),
      remoteUrl: () => fixture.url,
      runGit,
    })
    await assert.rejects(
      () => reads.readTree('acme/widgets', fixture.sidecar),
      (error: unknown) =>
        error instanceof GitRepoReadError &&
        error.kind === 'unreadable' &&
        /no branch or tag points at/.test(error.message),
    )
  })

  run('a busy host reads as rate-limited, a refusal still as unreadable', async () => {
    const kinds = async (stderr: string): Promise<string> => {
      const reads = createGitRepoReader({
        cacheDir: '/tmp/never-used',
        remoteUrl: () => fixture.url,
        runGit: () => Promise.reject(Object.assign(new Error(stderr.trim()), { stderr })),
      })
      try {
        await reads.resolveCommit('acme/widgets', '')
        return 'resolved'
      } catch (error) {
        return error instanceof GitRepoReadError ? error.kind : 'other'
      }
    }
    const wrapped = (body: string): string => `fatal: unable to access 'https://github.com/a/b.git/': ${body}\n`

    assert.equal(await kinds(wrapped('The requested URL returned error: 429')), 'rate-limited')
    assert.equal(await kinds(wrapped('The requested URL returned error: 503')), 'rate-limited')
    assert.equal(await kinds('fatal: You have exceeded a secondary rate limit\n'), 'rate-limited')
    assert.equal(await kinds('remote: 429 Too Many Requests\n'), 'rate-limited')
    // Waiting will not help with any of these.
    assert.equal(await kinds(wrapped('The requested URL returned error: 403')), 'unreadable')
    assert.equal(await kinds(wrapped('The requested URL returned error: 404')), 'unreadable')
    assert.equal(await kinds(wrapped('The requested URL returned error: 401')), 'unreadable')
    assert.equal(await kinds('fatal: repository not found\n'), 'unreadable')
  })

  run('nothing can be prompted for: the askpass is empty, not a program', async () => {
    if (!POSIX) {
      console.log('  (skipped: no printenv on this platform)')
      return
    }
    // `GIT_ASKPASS=echo` would answer every credential prompt with the prompt's
    // own text, spending a round trip being rejected; empty leaves git no
    // askpass at all, and GIT_TERMINAL_PROMPT=0 then fails it on the spot.
    const { stdout } = await defaultRunGit(['-c', 'alias.showenv=!printenv GIT_ASKPASS; true', 'showenv'], {
      cwd: fixture.root,
      timeoutMs: 15_000,
    })
    assert.equal(stdout.toString('utf8'), '\n', 'set, and empty')
  })

  // ── Reading a file ─────────────────────────────────────────────────────────

  run('a directory is not a file', async () => {
    const reads = reader({ cacheDir: await cacheRoot() })
    await assert.rejects(
      () => reads.readFile('acme/widgets', fixture.second, 'skills/y'),
      (error: unknown) =>
        error instanceof GitRepoReadError && error.kind === 'unreadable' && /is a tree, not a file/.test(error.message),
      'reading a path that is a directory used to hand back the bytes of its listing',
    )
  })

  run('a path with a newline in it is refused rather than answered wrongly', async () => {
    const reads = reader({ cacheDir: await cacheRoot() })
    for (const path of ['skills/y/SKILL.md\nREADME.md', 'a\0b', '/etc/passwd', '']) {
      await assert.rejects(
        () => reads.readFile('acme/widgets', fixture.second, path),
        (error: unknown) => error instanceof GitRepoReadError && error.kind === 'unreadable',
        `${JSON.stringify(path)} is refused`,
      )
    }
  })

  // ── Caching ────────────────────────────────────────────────────────────────

  run('a name with .git shares its cache entry with the name without', async () => {
    const watcher = spy()
    const reads = reader({ cacheDir: await cacheRoot(), runGit: watcher.runGit })
    const plain = await reads.readTree('acme/widgets', fixture.second)
    const dotted = await reads.readTree('acme/widgets.git', fixture.second)
    assert.equal(dotted, plain, 'the very same listing, because they are the very same clone')
    assert.equal(countFetches(watcher.calls), 1)
  })

  run('the listing cache is bounded, and a re-list is one local command', async () => {
    const watcher = spy()
    const reads = reader({ cacheDir: await cacheRoot(), runGit: watcher.runGit })
    const [tip, ...rest] = fixture.ladder
    await reads.readTree('acme/widgets', tip)
    const oldest = rest[rest.length - 1]
    await reads.readTree('acme/widgets', oldest)
    const listed = countCommands(watcher.calls, 'ls-tree')
    await reads.readTree('acme/widgets', oldest)
    assert.equal(countCommands(watcher.calls, 'ls-tree'), listed, 'a listing just read is remembered')

    for (const sha of rest.slice(0, rest.length - 1)) await reads.readTree('acme/widgets', sha)
    const before = countCommands(watcher.calls, 'ls-tree')
    const again = await reads.readTree('acme/widgets', oldest)
    assert.equal(countCommands(watcher.calls, 'ls-tree'), before + 1, 'the oldest listing was evicted')
    assert.equal(countFetches(watcher.calls), 1, 'and re-listing it cost nothing on the network')
    assert.ok(again.some((entry) => entry.path === 'skills/y/SKILL.md'))
  })

  run('a ref that is already a commit costs no round trip', async () => {
    const watcher = spy()
    const reads = reader({ cacheDir: await cacheRoot(), runGit: watcher.runGit })
    assert.equal(await reads.resolveCommit('acme/widgets', fixture.second), fixture.second)
    assert.equal(
      await reads.resolveCommit('acme/widgets', fixture.second.toUpperCase()),
      fixture.second,
      'and an uppercase one answers in the case everything else here uses',
    )
    assert.equal(await reads.resolveCommit('acme/widgets', 'A'.repeat(64)), 'a'.repeat(64), 'a sha-256 name too')
    assert.deepEqual(watcher.calls, [], 'no ls-remote for a ref that is already the answer')

    const entries = await reads.readTree('acme/widgets', fixture.second.toUpperCase())
    assert.ok(
      entries.some((entry) => entry.path === 'README.md'),
      'an uppercase sha reads like any other',
    )
  })

  // ── Disk ───────────────────────────────────────────────────────────────────

  run('sweepGitRepoCache removes what nothing has read, and only what it wrote', async () => {
    const cacheDir = await cacheRoot()
    const reads = reader({ cacheDir })
    await reads.readTree('acme/widgets', fixture.second)
    const dir = gitRepoCacheDir(cacheDir, 'github.com', 'acme/widgets')

    // Two things under the cache that this reader did not write: a directory of
    // the wrong shape, and a symlink wearing a clone's name.
    const loose = join(cacheDir, 'github.com', 'acme', 'loose')
    await mkdir(loose, { recursive: true })
    const outside = await mkdtemp(join(tmpdir(), 'git-repo-reader-outside-'))
    await writeFile(join(outside, 'keep.txt'), 'not ours to delete\n')
    if (POSIX) await symlink(outside, join(cacheDir, 'github.com', 'acme', 'linked.git'))

    const fresh = await sweepGitRepoCache(cacheDir, 60 * 60 * 1000)
    assert.deepEqual(fresh.removed, [], 'a clone read a moment ago stays')
    assert.ok((fresh.keptBytes ?? 0) > 0, 'and its bytes are reported')

    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await utimes(dir, old, old)
    const swept = await sweepGitRepoCache(cacheDir, 24 * 60 * 60 * 1000)
    assert.deepEqual(swept.removed, [dir], 'a clone nothing has read for a day is gone')
    assert.equal(await exists(dir), false)
    assert.ok(await exists(loose), 'a path that is not the layout is left alone')
    assert.ok(await exists(join(outside, 'keep.txt')), 'and a symlink is never followed out of the cache')

    // And the reader simply makes it again.
    const bytes = await reads.readFile('acme/widgets', fixture.second, 'README.md')
    assert.equal(bytes?.toString('utf8'), 'two\n')
  })

  let failures = 0
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failures > 0) throw new Error(`${failures} git repo reader test(s) failed`)
  console.log('git repo reader tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
