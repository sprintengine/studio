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
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_SKILL_MAX_FILE_BYTES } from './github-tree'
import {
  createGitRepoReader,
  defaultRunGit,
  gitRepoCacheDir,
  GitRepoReadError,
  isGitAvailable,
  type GitRunOptions,
  type GitRunResult,
} from './git-repo-reader'

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
      }
    )
  })
}

type Fixture = {
  url: string
  first: string
  second: string
  sidecar: string
  tagObject: string
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

  return { url: `file://${root}`, first, second, sidecar, tagObject }
}

type Spy = { runGit: typeof defaultRunGit; calls: string[][] }

function spy(): Spy {
  const calls: string[][] = []
  return {
    calls,
    runGit: (args: string[], options: GitRunOptions): Promise<GitRunResult> => {
      calls.push(args)
      return defaultRunGit(args, options)
    },
  }
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
      'a machine without git says so rather than throwing'
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
        /no branch or tag named/.test(error.message)
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
      'refused from `cat-file -s` when nothing has been listed yet'
    )

    const warm = reader({ cacheDir: await cacheRoot() })
    await warm.readTree('acme/widgets', fixture.second)
    await assert.rejects(
      () => warm.readFile('acme/widgets', fixture.second, 'big.bin'),
      (error: unknown) => error instanceof GitRepoReadError,
      'and refused just the same once the tree has been listed'
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
    assert.ok(!aside.some((entry) => entry.path === 'big.bin'), 'and it is that commit\'s own tree')
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
        `${name} is refused`
      )
    }
    await assert.rejects(
      () => reads.readTree('acme/widgets', 'not-a-sha'),
      (error: unknown) => error instanceof GitRepoReadError && error.kind === 'unreadable'
    )
    assert.deepEqual(watcher.calls, [], 'no git process ran for any of them')
  })

  run('the cache directory is one path per host, owner and name', async () => {
    assert.equal(
      gitRepoCacheDir('/data/skill-repos', 'github.com', 'acme/widgets'),
      join('/data/skill-repos', 'github.com', 'acme', 'widgets.git')
    )
    assert.equal(
      gitRepoCacheDir('/data/skill-repos', 'github.com', 'acme/widgets.git'),
      join('/data/skill-repos', 'github.com', 'acme', 'widgets.git'),
      'a clone-URL name and a plain name land in the same place'
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
      'offline'
    )
    assert.equal(await kinds('fatal: unable to access: Failed to connect: Connection refused\n'), 'offline')
    assert.equal(await kinds('fatal: repository not found\n'), 'unreadable', 'a gone repository is not "offline"')
    assert.equal(
      await kinds("fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403\n"),
      'unreadable',
      'a refusal wearing the same "unable to access" wrapper is still a refusal'
    )
    assert.equal(await kinds('', { timedOut: true }), 'timeout')
    assert.equal(await kinds('fatal: the remote end hung up\n', { killed: true }), 'timeout')
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
