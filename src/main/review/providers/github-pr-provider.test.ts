import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePullRequestUrl, validateReviewChangeSet } from '../../../shared/review'
import { registerReviewSourceProvider, ReviewChangeSetService } from '../changeset-service'
import {
  createGithubPrProvider,
  defaultResolveToken,
  matchPrProjectRoots,
  parseGitRemoteRef,
  readProjectRemoteUrls,
  remoteMatchesPullRequest,
  type FetchLike,
  type FetchResponseLike,
  type GhRunner,
  type GithubPrProviderDeps,
} from './github-pr-provider'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-pr-'))
  tempDirs.push(dir)
  return dir
}

const service = new ReviewChangeSetService()
const PR_URL = 'https://github.com/acme/app/pull/123'
const BASE_SHA = 'b'.repeat(40)
const HEAD_SHA = 'h'.repeat(40)
const SECRET_TOKEN = 'ghp_SUPERSECRET_should_never_persist'

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-old', '+new', ''].join('\n')

const REST_META = {
  title: 'Add widget',
  body: 'Adds a widget.',
  base: { ref: 'main', sha: BASE_SHA },
  head: { ref: 'feature', sha: HEAD_SHA },
  additions: 1,
  deletions: 1,
  changed_files: 1,
}

const GH_META = {
  title: 'Add widget',
  body: 'Adds a widget.',
  baseRefName: 'main',
  headRefName: 'feature',
  baseRefOid: BASE_SHA,
  headRefOid: HEAD_SHA,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
}

const GH_UNAVAILABLE: GhRunner = {
  available: async () => false,
  run: async () => ({ found: false, code: -1, stdout: '', stderr: '' }),
}

function ghStub(view: unknown, diff: string): GhRunner {
  return {
    available: async () => true,
    run: async (args) =>
      args.includes('diff')
        ? { found: true, code: 0, stdout: diff, stderr: '' }
        : { found: true, code: 0, stdout: JSON.stringify(view), stderr: '' },
  }
}

function jsonResponse(status: number, json: unknown): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) }
}
function textResponse(status: number, text: string): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text || 'null'), text: async () => text }
}

interface FetchStubOptions {
  metaStatus?: number
  meta?: unknown
  diffStatus?: number
  diff?: string
}
function fetchStub(options: FetchStubOptions): { fetchImpl: FetchLike; authHeaders: Array<string | undefined> } {
  const authHeaders: Array<string | undefined> = []
  const fetchImpl: FetchLike = async (_url, init) => {
    authHeaders.push(init?.headers?.Authorization)
    if (init?.headers?.Accept === 'application/vnd.github.v3.diff') {
      return textResponse(options.diffStatus ?? 200, options.diff ?? '')
    }
    return jsonResponse(options.metaStatus ?? 200, options.meta ?? {})
  }
  return { fetchImpl, authHeaders }
}

function install(deps: Partial<GithubPrProviderDeps> & Pick<GithubPrProviderDeps, 'fetchImpl' | 'gh'>): void {
  registerReviewSourceProvider(
    'pull-request',
    createGithubPrProvider({
      gh: deps.gh,
      fetchImpl: deps.fetchImpl,
      resolveToken: deps.resolveToken ?? (async () => null),
    })
  )
}

run('REST happy path produces a valid pull-request change set with a token applied but never persisted', async () => {
  const { fetchImpl, authHeaders } = fetchStub({ meta: REST_META, diff: DIFF })
  install({ gh: GH_UNAVAILABLE, fetchImpl, resolveToken: async () => SECRET_TOKEN })

  const target = makeTempDir()
  const changeset = await service.ingest({ kind: 'pull-request', url: PR_URL }, target)

  assert.ok(validateReviewChangeSet(changeset).ok)
  assert.equal(changeset.source.kind, 'pull-request')
  if (changeset.source.kind === 'pull-request') {
    assert.equal(changeset.source.provider, 'github')
    assert.equal(changeset.source.host, 'github.com')
    assert.equal(changeset.source.owner, 'acme')
    assert.equal(changeset.source.repo, 'app')
    assert.equal(changeset.source.number, 123)
    assert.equal(changeset.source.url, 'https://github.com/acme/app/pull/123')
  }
  assert.equal(changeset.baseSha, BASE_SHA)
  assert.equal(changeset.headSha, HEAD_SHA)
  assert.equal(changeset.stats.files, 1)
  assert.equal(changeset.stats.additions, 1)
  assert.equal(changeset.stats.deletions, 1)

  // The token reached GitHub as a bearer credential…
  assert.ok(authHeaders.includes(`Bearer ${SECRET_TOKEN}`), 'token is sent as an Authorization header')
  // …but is absent from the persisted record.
  const onDisk = readFileSync(join(target, 'changeset.json'), 'utf-8')
  assert.ok(!onDisk.includes(SECRET_TOKEN), 'token never lands in changeset.json')
})

run('gh CLI path is used first and needs no REST token', async () => {
  let fetchCalled = false
  let tokenResolved = false
  const fetchImpl: FetchLike = async () => {
    fetchCalled = true
    return jsonResponse(500, {})
  }
  install({
    gh: ghStub(GH_META, DIFF),
    fetchImpl,
    resolveToken: async () => {
      tokenResolved = true
      return SECRET_TOKEN
    },
  })

  const changeset = await service.ingest({ kind: 'pull-request', url: PR_URL }, makeTempDir())
  assert.ok(validateReviewChangeSet(changeset).ok)
  assert.equal(changeset.headSha, HEAD_SHA)
  assert.equal(changeset.stats.files, 1)
  assert.equal(fetchCalled, false, 'gh success short-circuits the REST fallback')
  assert.equal(tokenResolved, false, 'no token is resolved when gh serves the request')
})

run('a 404 maps to a not-found error naming both auth paths', async () => {
  const { fetchImpl } = fetchStub({ metaStatus: 404, meta: { message: 'Not Found' } })
  install({ gh: GH_UNAVAILABLE, fetchImpl, resolveToken: async () => null })
  await assert.rejects(
    () => service.ingest({ kind: 'pull-request', url: PR_URL }, makeTempDir()),
    (error: Error) => /not found/i.test(error.message) && /gh auth login/.test(error.message) && /GH_TOKEN/.test(error.message)
  )
})

run('a 401 maps to a distinct credentials error and never echoes the token', async () => {
  const { fetchImpl } = fetchStub({ metaStatus: 401, meta: { message: 'Bad credentials' } })
  install({ gh: GH_UNAVAILABLE, fetchImpl, resolveToken: async () => SECRET_TOKEN })
  await assert.rejects(
    () => service.ingest({ kind: 'pull-request', url: PR_URL }, makeTempDir()),
    (error: Error) => /401/.test(error.message) && !error.message.includes(SECRET_TOKEN)
  )
})

run('a PR over the file limit hits the size guard before parsing', async () => {
  const { fetchImpl } = fetchStub({ meta: { ...REST_META, changed_files: 401 }, diff: DIFF })
  install({ gh: GH_UNAVAILABLE, fetchImpl, resolveToken: async () => null })
  await assert.rejects(
    () => service.ingest({ kind: 'pull-request', url: PR_URL }, makeTempDir()),
    /too many files.*limit/
  )
})

run('detect returns title, stats and head sha on success', async () => {
  const { fetchImpl } = fetchStub({ meta: REST_META, diff: DIFF })
  install({ gh: GH_UNAVAILABLE, fetchImpl, resolveToken: async () => null })
  const probe = await service.detect({ kind: 'pull-request', url: PR_URL })
  assert.equal(probe.ok, true)
  assert.equal(probe.title, 'Add widget')
  assert.equal(probe.stats?.files, 1)
  assert.equal(probe.headSha, HEAD_SHA)
})

run('detect on a Bitbucket URL reports the unsupported provider, never throws', async () => {
  const { fetchImpl } = fetchStub({ meta: REST_META })
  install({ gh: GH_UNAVAILABLE, fetchImpl, resolveToken: async () => null })
  const probe = await service.detect({
    kind: 'pull-request',
    url: 'https://bitbucket.org/team/repo/pull-requests/5',
  })
  assert.equal(probe.ok, false)
  assert.match(probe.error ?? '', /Bitbucket/)
})

run('detect returns a still-checking state instead of blocking when the probe is slow', async () => {
  // A fetch that never settles forces the probe timeout; the provider must answer
  // with a provisional title rather than hang the creation flow.
  const fetchImpl: FetchLike = () => new Promise<FetchResponseLike>(() => {})
  install({ gh: GH_UNAVAILABLE, fetchImpl, resolveToken: async () => null })
  const probe = await service.detect({ kind: 'pull-request', url: PR_URL })
  assert.equal(probe.ok, true)
  assert.equal(probe.title, 'acme/app #123')
  assert.equal(probe.stats, undefined, 'still-checking carries no stats yet')
})

run('the enterprise token is never handed to an unconfigured or mismatched host', async () => {
  const saved = { ...process.env }
  try {
    process.env.GH_ENTERPRISE_TOKEN = 'ent-secret'
    delete process.env.GH_HOST
    delete process.env.GH_ENTERPRISE_HOST
    // No configured enterprise host: the token must not be released to a pasted host.
    assert.equal(await defaultResolveToken('evil.example.com', 'github-enterprise'), null)

    process.env.GH_HOST = 'ghe.corp.example.com'
    // Configured host that does not match the pasted host: still withheld.
    assert.equal(await defaultResolveToken('evil.example.com', 'github-enterprise'), null)
    // Exact match: released.
    assert.equal(await defaultResolveToken('ghe.corp.example.com', 'github-enterprise'), 'ent-secret')

    // github.com is fixed to api.github.com, so GH_TOKEN is host-independent.
    process.env.GH_TOKEN = 'dotcom-secret'
    assert.equal(await defaultResolveToken('github.com', 'github'), 'dotcom-secret')
  } finally {
    for (const key of ['GH_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_HOST', 'GH_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

// --- PR-project inference (MC-1787) ---

run('parseGitRemoteRef handles the https, ssh, scp, git:// and .git-suffix forms', () => {
  const expected = { host: 'github.com', owner: 'acme', repo: 'app' }
  assert.deepEqual(parseGitRemoteRef('https://github.com/acme/app.git'), expected)
  assert.deepEqual(parseGitRemoteRef('https://github.com/acme/app'), expected)
  assert.deepEqual(parseGitRemoteRef('http://github.com/acme/app'), expected)
  assert.deepEqual(parseGitRemoteRef('git@github.com:acme/app.git'), expected)
  assert.deepEqual(parseGitRemoteRef('ssh://git@github.com/acme/app.git'), expected)
  assert.deepEqual(parseGitRemoteRef('ssh://git@github.com:22/acme/app.git'), expected)
  assert.deepEqual(parseGitRemoteRef('git://github.com/acme/app.git'), expected)
})

run('parseGitRemoteRef lower-cases host and owner/repo, and drops embedded credentials', () => {
  assert.deepEqual(parseGitRemoteRef('git@GitHub.com:Acme/App.git'), {
    host: 'github.com',
    owner: 'acme',
    repo: 'app',
  })
  // A user:token@ authority in an https remote must never survive into the ref.
  assert.deepEqual(parseGitRemoteRef('https://user:ghp_secret@ghe.example.com/Team/Service.git'), {
    host: 'ghe.example.com',
    owner: 'team',
    repo: 'service',
  })
})

run('parseGitRemoteRef rejects non-remotes: empty, a Windows path, and junk', () => {
  assert.equal(parseGitRemoteRef(''), null)
  assert.equal(parseGitRemoteRef('   '), null)
  assert.equal(parseGitRemoteRef('C:\\Users\\me\\repo'), null)
  assert.equal(parseGitRemoteRef('not a url'), null)
  assert.equal(parseGitRemoteRef('https://github.com/acme'), null) // no repo segment
})

run('remoteMatchesPullRequest compares host + owner/repo case-insensitively', () => {
  const pr = parsePullRequestUrl('https://GitHub.com/Acme/App/pull/9')
  assert.ok(pr && !('unsupported' in pr))
  if (pr && !('unsupported' in pr)) {
    assert.equal(remoteMatchesPullRequest({ host: 'github.com', owner: 'acme', repo: 'app' }, pr), true)
    assert.equal(remoteMatchesPullRequest({ host: 'github.com', owner: 'acme', repo: 'other' }, pr), false)
    assert.equal(remoteMatchesPullRequest({ host: 'gitlab.com', owner: 'acme', repo: 'app' }, pr), false)
  }
})

run('matchPrProjectRoots returns the one root whose remote matches', async () => {
  const remotes: Record<string, string[]> = {
    '/proj/app': ['git@github.com:acme/app.git'],
    '/proj/other': ['https://github.com/acme/other.git'],
  }
  const matches = await matchPrProjectRoots(
    'https://github.com/acme/app/pull/5',
    ['/proj/app', '/proj/other'],
    async (root) => remotes[root] ?? []
  )
  assert.deepEqual(matches, ['/proj/app'])
})

run('matchPrProjectRoots returns every matching root (two checkouts of one repo)', async () => {
  const matches = await matchPrProjectRoots(
    'https://github.com/acme/app/pull/5',
    ['/proj/a', '/proj/b', '/proj/a'], // duplicate root is de-duplicated
    async () => ['ssh://git@github.com/acme/app.git']
  )
  assert.deepEqual(matches, ['/proj/a', '/proj/b'])
})

run('matchPrProjectRoots returns [] when no remote matches', async () => {
  const matches = await matchPrProjectRoots(
    'https://github.com/acme/app/pull/5',
    ['/proj/other'],
    async () => ['git@github.com:acme/unrelated.git']
  )
  assert.deepEqual(matches, [])
})

run('matchPrProjectRoots yields [] for a non-PR or unsupported URL without reading remotes', async () => {
  let read = false
  const reader = async (): Promise<string[]> => {
    read = true
    return []
  }
  assert.deepEqual(await matchPrProjectRoots('not a pr url', ['/proj/a'], reader), [])
  assert.deepEqual(
    await matchPrProjectRoots('https://bitbucket.org/team/repo/pull-requests/1', ['/proj/a'], reader),
    []
  )
  assert.equal(read, false)
})

run('readProjectRemoteUrls reads a real repo LC_ALL=C-pinned and matchPrProjectRoots resolves it', async () => {
  const repo = makeTempDir()
  const git = (args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }
  git(['init', '-q'])
  git(['remote', 'add', 'origin', 'git@github.com:Acme/App.git'])
  git(['remote', 'add', 'upstream', 'https://github.com/acme/upstream.git'])

  const urls = await readProjectRemoteUrls(repo)
  assert.ok(urls.includes('git@github.com:Acme/App.git'))
  assert.ok(urls.includes('https://github.com/acme/upstream.git'))

  // A non-repo directory is a clean non-match, never a throw.
  assert.deepEqual(await readProjectRemoteUrls(makeTempDir()), [])

  // End-to-end through the real git reader: the origin remote resolves the root.
  const matches = await matchPrProjectRoots('https://github.com/acme/app/pull/7', [repo])
  assert.deepEqual(matches, [repo])
})

async function main(): Promise<void> {
  let failed = false
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  if (failed) process.exit(1)
  console.log('github-pr-provider.test.ts: ok')
}

void main()
