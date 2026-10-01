import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { commitBump, commitTypes, strongestBump } from './conventional-commits.mjs'
import {
  bumpVersion,
  isOnMain,
  resolveMainRelease,
  resolveNightly,
  resolvePromotion,
  resolveTagRelease,
} from './main-release.mjs'

test('all accepted maintenance types release patches; features and breaking changes take precedence', () => {
  for (const type of commitTypes) {
    assert.equal(commitBump(`${type}(app): change behavior`), type === 'feat' ? 'minor' : 'patch')
    assert.equal(commitBump(`${type}!: change behavior`), 'major')
  }
  assert.equal(commitBump('fix: change format\n\nBREAKING CHANGE: migrate saved files'), 'major')
  assert.equal(commitBump('fix: change format\r\n\r\nBREAKING-CHANGE: migrate saved files'), 'major')
  assert.equal(commitBump('docs: describe the BREAKING CHANGE: footer'), 'patch')
  for (const title of ['Update app', 'feat:add search', 'fix: ', 'unknown: change app', 'feat(): add search']) {
    assert.throws(() => commitBump(title), /Conventional Commit/)
  }
  assert.equal(strongestBump(['Old prose subject', 'feat: add search', 'fix: repair search']), 'minor')
  assert.equal(strongestBump(['feat!: change format', 'feat: add search']), 'major')
  // Before 1.0 a breaking change moves the minor version; 1.0.0 is only ever typed in.
  assert.equal(bumpVersion('0.4.9', 'major'), '0.5.0')
  assert.equal(bumpVersion('0.4.9', 'minor'), '0.5.0')
  assert.equal(bumpVersion('0.4.9', 'patch'), '0.4.10')
  assert.equal(bumpVersion('1.4.9', 'major'), '2.0.0')
  assert.equal(bumpVersion('1.4.9', 'minor'), '1.5.0')
  assert.equal(bumpVersion('1.4.9', 'patch'), '1.4.10')
})

function repository(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'studio-release-test-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Dev')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'tag.gpgsign', 'false')
  const commit = (message) => {
    git('commit', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  const initial = commit('The previous release')
  git('tag', 'v0.4.0')
  const releases = [{ tag_name: 'v0.4.0', draft: false }]
  const resolve = (sha = git('rev-parse', 'HEAD')) => resolveMainRelease({ sha, releases, packageVersion: '0.4.0', cwd })
  return { cwd, git, commit, releases, resolve, initial }
}

test('each stable moves the next version on without package.json edits', (t) => {
  const r = repository(t)
  r.commit('feat: add search')
  assert.deepEqual(r.resolve(), { version: '0.5.0', shouldBuild: true })
  r.git('tag', '-a', 'v0.5.0', '-m', 'Release')
  r.releases.push({ tag_name: 'v0.5.0', draft: false })
  r.commit('docs: explain search')
  assert.deepEqual(r.resolve(), { version: '0.5.1', shouldBuild: true })
  r.git('tag', 'v0.5.1')
  r.releases.push({ tag_name: 'v0.5.1', draft: false })
  r.commit('fix!: change saved format')
  // Breaking at 0.x moves the minor version; 1.0.0 is only ever typed in.
  assert.deepEqual(r.resolve(), { version: '0.6.0', shouldBuild: true })
})

test('initial migration accepts legacy prose, but a new release tip must be conventional', (t) => {
  const r = repository(t)
  r.commit('The old contribution policy required prose')
  assert.throws(() => r.resolve(), /Conventional Commit/)
  r.commit('ci: release main')
  assert.deepEqual(r.resolve(), { version: '0.4.1', shouldBuild: true })
})

test('a failed build contributes its strongest change to the next release', (t) => {
  const r = repository(t)
  r.commit('feat!: retire an old format')
  r.commit('fix: repair packaging')
  assert.deepEqual(r.resolve(), { version: '0.5.0', shouldBuild: true })
})

test('published retries and older queued runs cannot publish over a newer stable', (t) => {
  const r = repository(t)
  const older = r.commit('fix: repair search')
  const newer = r.commit('feat: add filters')
  r.git('tag', 'v0.5.0')
  r.releases.push({ tag_name: 'v0.5.0', draft: false })
  assert.deepEqual(r.resolve(newer), { version: '0.5.0', shouldBuild: false })
  assert.deepEqual(r.resolve(older), { version: '0.5.0', shouldBuild: false })
})

test('a tag left by an interrupted draft reserves its version and supports retry', (t) => {
  const r = repository(t)
  const failed = r.commit('feat: add search')
  r.git('tag', 'v0.5.0')
  r.releases.push({ tag_name: 'v0.5.0', draft: true })
  assert.deepEqual(r.resolve(failed), { version: '0.5.0', shouldBuild: true })
  r.commit('fix: repair packaging')
  assert.deepEqual(r.resolve(), { version: '0.5.1', shouldBuild: true })
})

test('branch commits and prerelease tags do not determine a squash or merge release', (t) => {
  const r = repository(t)
  r.git('checkout', '-b', 'topic')
  r.commit('feat!: internal experiment that was removed')
  r.git('tag', 'v9.0.0-nightly.1')
  r.git('checkout', 'main')
  r.git('merge', '--no-ff', 'topic', '-m', 'fix: repair search')
  assert.deepEqual(r.resolve(), { version: '0.4.1', shouldBuild: true })
})

test('unrelated stable tags cannot be reused and divergent main cannot roll users back', (t) => {
  const r = repository(t)
  r.git('checkout', '-b', 'other')
  r.commit('fix: release on another history')
  r.git('tag', 'v0.4.1')
  r.git('checkout', 'main')
  r.commit('fix: repair search')
  assert.throws(() => r.resolve(), /already belongs to another commit/)
  r.releases.push({ tag_name: 'v0.4.1', draft: false })
  assert.throws(() => r.resolve(), /not on this main history/)
})

test('PR validation reads title and breaking footer as data without executing shell syntax', (t) => {
  const r = repository(t)
  const event = path.join(r.cwd, 'event.json')
  const script = new URL('./check-pr-title.mjs', import.meta.url)
  writeFileSync(event, JSON.stringify({ pull_request: { title: 'feat: add `search` $(filters)', body: 'BREAKING CHANGE: new format' } }))
  const run = () => execFileSync(process.execPath, [script.pathname], { env: { ...process.env, GITHUB_EVENT_PATH: event }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(run(), /major release/)
  writeFileSync(event, JSON.stringify({ pull_request: { title: 'Add search' } }))
  assert.throws(run, /Conventional Commit/)
})

test('a nightly carries the next stable version, so a feat merged today shows in it at once', (t) => {
  const r = repository(t)
  const nightly = (sha = r.git('rev-parse', 'HEAD')) =>
    resolveNightly({ sha, releases: r.releases, packageVersion: '0.4.0', date: '20260923', runNumber: 41, cwd: r.cwd })
  r.commit('fix: repair search')
  assert.deepEqual(nightly(), { shouldBuild: true, base: '0.4.1', version: '0.4.1-nightly.20260923.41' })
  r.commit('feat: add filters')
  assert.deepEqual(nightly(), { shouldBuild: true, base: '0.5.0', version: '0.5.0-nightly.20260923.41' })
  // Promoted: the stable tag lands on the nightly's commit, and a nightly of
  // that same commit would sort below the stable, so there is none.
  r.git('tag', 'v0.5.0')
  r.releases.push({ tag_name: 'v0.5.0', draft: false })
  assert.deepEqual(nightly(), { shouldBuild: false, base: '0.5.0', version: null })
  r.commit('docs: explain filters')
  assert.equal(nightly().version, '0.5.1-nightly.20260923.41')
})

test('a promotion ships the nightly base version unless the maintainer names another above the latest stable', () => {
  const tag = 'v0.5.0-nightly.20260923.41'
  assert.equal(resolvePromotion({ nightlyTag: tag, latestStable: '0.4.0', tags: ['v0.4.0'] }), '0.5.0')
  assert.equal(resolvePromotion({ nightlyTag: tag, override: ' ', latestStable: '0.4.0' }), '0.5.0')
  assert.equal(resolvePromotion({ nightlyTag: tag, override: 'v1.0.0', latestStable: '0.4.0' }), '1.0.0')
  // The commit markers can overstate a change: two `!` commits for a release
  // process and an internal refactor derive 2.0.0, and the maintainer ships 1.1.0.
  const overstated = 'v2.0.0-nightly.20260923.41'
  assert.equal(resolvePromotion({ nightlyTag: overstated, override: '1.1.0', latestStable: '1.0.0' }), '1.1.0')
  assert.equal(resolvePromotion({ nightlyTag: tag, override: '0.4.9', latestStable: '0.4.0' }), '0.4.9')
  assert.throws(
    () => resolvePromotion({ nightlyTag: overstated, override: '1.0.0', latestStable: '1.0.0' }),
    /1\.0\.0 is already released/,
  )
  assert.throws(
    () => resolvePromotion({ nightlyTag: overstated, override: '0.9.0', latestStable: '1.0.0' }),
    /1\.0\.0 is already released/,
  )
  assert.throws(
    () => resolvePromotion({ nightlyTag: overstated, override: '1.1.0', latestStable: '1.0.0', tags: ['v1.1.0'] }),
    /already belongs/,
  )
  assert.throws(() => resolvePromotion({ nightlyTag: tag, override: '1.0.0-rc.1' }), /no prerelease part/)
  assert.throws(() => resolvePromotion({ nightlyTag: tag, override: '1.0' }), /Not a release version/)
  // Already promoted, or a tag reserves the version: never reused.
  assert.throws(() => resolvePromotion({ nightlyTag: tag, latestStable: '0.5.0' }), /0\.5\.0 is already released/)
  assert.throws(() => resolvePromotion({ nightlyTag: tag, latestStable: '0.4.0', tags: ['v0.5.0'] }), /already belongs/)
})

test('only a commit on main can be promoted', (t) => {
  const r = repository(t)
  const shipped = r.commit('feat: add search')
  r.git('checkout', '-b', 'topic')
  const offMain = r.commit('fix: never merged')
  r.git('checkout', 'main')
  const head = r.commit('fix: repair search')
  assert.equal(isOnMain({ sha: shipped, mainSha: head, cwd: r.cwd }), true)
  assert.equal(isOnMain({ sha: head, mainSha: head, cwd: r.cwd }), true)
  assert.equal(isOnMain({ sha: offMain, mainSha: head, cwd: r.cwd }), false)
  assert.equal(isOnMain({ sha: 'f'.repeat(40), mainSha: head, cwd: r.cwd }), false)
})

// The hotfix route. package.json stays at its development baseline by rule, so
// the tag is not checked against it; what matters is that the tag names a
// stable version above every published stable that no release already holds.
test('a pushed hotfix tag publishes its own version, whatever package.json says', () => {
  assert.equal(resolveTagRelease({ refName: 'v1.0.1', latestStable: '1.0.0', publishedTags: ['v1.0.0'] }), '1.0.1')
  assert.equal(resolveTagRelease({ refName: 'v0.1.0', latestStable: null }), '0.1.0', 'the first stable')
  assert.throws(() => resolveTagRelease({ refName: 'v1.0.0', latestStable: '1.0.0' }), /not above the latest stable/)
  assert.throws(() => resolveTagRelease({ refName: 'v0.9.9', latestStable: '1.0.0' }), /not above the latest stable/)
  assert.throws(
    () => resolveTagRelease({ refName: 'v1.1.0', latestStable: '1.0.0', publishedTags: ['v1.1.0'] }),
    /already published/,
  )
  assert.throws(() => resolveTagRelease({ refName: 'v1.1.0-nightly.20260923.1', latestStable: '1.0.0' }), /X\.Y\.Z/)
  assert.throws(() => resolveTagRelease({ refName: 'release-1', latestStable: '1.0.0' }), /Not a release version/)
})
