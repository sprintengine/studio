import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateReviewChangeSet } from '../../shared/review'
import {
  MAX_CHANGESET_FILES,
  ReviewChangeSetService,
  reviewChangeSetDir,
} from './changeset-service'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.co', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.co' },
  })
}

const service = new ReviewChangeSetService()

const SIMPLE_PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  '',
].join('\n')

run('branch ingestion honors three-dot (merge-base) semantics', async () => {
  const repo = makeTempDir('review-repo-')
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'A.txt'), 'base-A\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'base with A'])

  // Fork feature from this point.
  git(repo, ['branch', 'feature'])

  // Advance main after the fork — three-dot must ignore this file.
  writeFileSync(join(repo, 'B.txt'), 'main-only-B\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'main adds B after fork'])

  // Feature edits A and adds C.
  git(repo, ['checkout', '-q', 'feature'])
  writeFileSync(join(repo, 'A.txt'), 'feature-A\n')
  writeFileSync(join(repo, 'C.txt'), 'feature-only-C\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'feature edits A, adds C'])

  const target = makeTempDir('review-out-')
  const changeset = await service.ingest(
    { kind: 'branch', repoRoot: repo, baseRef: 'main', headRef: 'feature' },
    target
  )

  const paths = changeset.files.map((file) => file.path).sort()
  assert.deepEqual(paths, ['A.txt', 'C.txt'], 'three-dot excludes B added on main after the fork')
  assert.equal(changeset.stats.files, 2)
  assert.ok(changeset.headSha && changeset.headSha.length === 40)
  assert.ok(changeset.baseSha && changeset.baseSha.length === 40)
  assert.equal(changeset.source.kind, 'branch')
  assert.ok(validateReviewChangeSet(changeset).ok)

  // Persisted atomically at changeset.json with no leftover temp file.
  const entries = readdirSync(target)
  assert.deepEqual(entries, ['changeset.json'])
  const onDisk = JSON.parse(readFileSync(join(target, 'changeset.json'), 'utf-8'))
  assert.equal(onDisk.id, changeset.id)
})

run('detect on a branch returns stats without throwing', async () => {
  const repo = makeTempDir('review-repo-')
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'A.txt'), 'a\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'base'])
  git(repo, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(repo, 'A.txt'), 'a2\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'edit'])

  const probe = await service.detect({ kind: 'branch', repoRoot: repo, baseRef: 'main', headRef: 'feature' })
  assert.equal(probe.ok, true)
  assert.equal(probe.stats?.files, 1)
  assert.ok(probe.headSha)
})

run('detect on an unknown ref returns ok:false, never throws', async () => {
  const repo = makeTempDir('review-repo-')
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'A.txt'), 'a\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'base'])

  const probe = await service.detect({ kind: 'branch', repoRoot: repo, baseRef: 'main', headRef: 'does-not-exist' })
  assert.equal(probe.ok, false)
  assert.match(probe.error ?? '', /does-not-exist/)
})

run('patch ingestion writes atomically and re-ingest yields the same id', async () => {
  const target = makeTempDir('review-out-')
  const first = await service.ingest({ kind: 'patch', text: SIMPLE_PATCH }, target)
  const second = await service.ingest({ kind: 'patch', text: SIMPLE_PATCH }, target)
  assert.equal(first.id, second.id, 'unchanged content yields a stable id')
  assert.deepEqual(readdirSync(target), ['changeset.json'], 'no temp file survives a successful write')

  // A logically identical patch pasted with CRLF hashes to the same id.
  const crlfTarget = makeTempDir('review-out-')
  const crlf = await service.ingest({ kind: 'patch', text: SIMPLE_PATCH.replace(/\n/g, '\r\n') }, crlfTarget)
  assert.equal(crlf.id, first.id, 'CRLF normalization keeps the id stable')
})

run('detect on nonsense patch returns an actionable error', async () => {
  const probe = await service.detect({ kind: 'patch', text: 'not a diff, just words' })
  assert.equal(probe.ok, false)
  assert.match(probe.error ?? '', /Not a unified diff/)
})

run('empty patch text is rejected', async () => {
  const probe = await service.detect({ kind: 'patch', text: '   \n  ' })
  assert.equal(probe.ok, false)
  assert.match(probe.error ?? '', /empty/i)
})

run('patch label becomes the title', async () => {
  const target = makeTempDir('review-out-')
  const changeset = await service.ingest({ kind: 'patch', text: SIMPLE_PATCH, label: 'My fix' }, target)
  assert.equal(changeset.title, 'My fix')
  assert.equal(changeset.source.kind, 'patch')
})

run('oversized patch fails with a named limit', async () => {
  const target = makeTempDir('review-out-')
  const huge = 'x'.repeat(5 * 1024 * 1024 + 10)
  await assert.rejects(
    () => service.ingest({ kind: 'patch', text: huge }, target),
    /too large to review.*limit/
  )
})

run('too many files fails with a named limit', async () => {
  const target = makeTempDir('review-out-')
  const blocks: string[] = []
  for (let n = 0; n <= MAX_CHANGESET_FILES; n++) {
    blocks.push(
      `diff --git a/f${n}.ts b/f${n}.ts`,
      `--- a/f${n}.ts`,
      `+++ b/f${n}.ts`,
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b'
    )
  }
  await assert.rejects(
    () => service.ingest({ kind: 'patch', text: blocks.join('\n') }, target),
    /too many files.*limit/
  )
})

run('pull-request source is not installed until MC-1678', async () => {
  const probe = await service.detect({ kind: 'pull-request', url: 'https://github.com/acme/app/pull/1' })
  assert.equal(probe.ok, false)
  assert.match(probe.error ?? '', /GitHub provider/)
  const target = makeTempDir('review-out-')
  await assert.rejects(
    () => service.ingest({ kind: 'pull-request', url: 'https://github.com/acme/app/pull/1' }, target),
    /GitHub provider/
  )
})

run('read returns null when nothing has been ingested', async () => {
  const target = makeTempDir('review-out-')
  const result = await service.read(target)
  assert.deepEqual(result, { ok: true, changeset: null })
})

run('read round-trips an ingested change set', async () => {
  const target = makeTempDir('review-out-')
  const written = await service.ingest({ kind: 'patch', text: SIMPLE_PATCH }, target)
  const result = await service.read(target)
  assert.ok(result.ok)
  if (result.ok) assert.equal(result.changeset?.id, written.id)
})

run('read surfaces a corrupt file instead of silently returning null', async () => {
  const target = makeTempDir('review-out-')
  writeFileSync(join(target, 'changeset.json'), '{ not json')
  const result = await service.read(target)
  assert.equal(result.ok, false)
})

run('read rejects a valid-JSON file that violates the schema', async () => {
  const target = makeTempDir('review-out-')
  writeFileSync(join(target, 'changeset.json'), JSON.stringify({ schemaVersion: 1, id: 'x' }))
  const result = await service.read(target)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /invalid/i)
})

run('reviewChangeSetDir rejects a path-traversing workspace id', () => {
  assert.throws(() => reviewChangeSetDir('/tmp/root', '../escape'), /Invalid workspace id/)
  assert.throws(() => reviewChangeSetDir('/tmp/root', ''), /Invalid workspace id/)
  const dir = reviewChangeSetDir('/tmp/root', 'ws_123')
  assert.ok(dir.endsWith(join('.multi-code', 'review', 'ws_123')))
})

run('ingest creates the target directory when missing', async () => {
  const base = makeTempDir('review-out-')
  const nested = join(base, 'a', 'b', 'c')
  await mkdir(base, { recursive: true })
  const changeset = await service.ingest({ kind: 'patch', text: SIMPLE_PATCH }, nested)
  assert.ok(readFileSync(join(nested, 'changeset.json'), 'utf-8').includes(changeset.id))
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
  console.log('changeset-service.test.ts: ok')
}

void main()
