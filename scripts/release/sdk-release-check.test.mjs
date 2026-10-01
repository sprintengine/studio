import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  changelogHeadVersion,
  checkSdkRelease,
  checkSdkReleaseTree,
  distTagForVersion,
  hostApiClaims,
  hostApiFromSource,
} from './sdk-release-check.mjs'

const HOST_API_SOURCE = 'export const HOST_API_VERSION = 2\n\nexport const HOST_API_MIN_SUPPORTED = 1\n'
const CHANGELOG = '# Changelog\n\n## 1.2.0-beta.3\n\n- Things.\n\n## 1.1.0 — 2026-09-10\n'

function inputs(overrides = {}) {
  return {
    packageVersion: '1.2.0-beta.3',
    changelog: CHANGELOG,
    hostApiSource: HOST_API_SOURCE,
    docs: [
      { path: 'docs/compatibility.md', text: '`HOST_API_VERSION = 2`, `HOST_API_MIN_SUPPORTED = 1`', required: true },
    ],
    templateManifests: [{ path: 'templates/panel/module/manifest.json', json: { engines: { hostApi: 2 } } }],
    ...overrides,
  }
}

test('a consistent tree is ready, and a prerelease goes out under its own dist-tag', () => {
  const result = checkSdkRelease(inputs())
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.equal(result.distTag, 'beta')
})

test('the dist-tag is latest only for a release, never for a prerelease', () => {
  assert.equal(distTagForVersion('1.0.0'), 'latest')
  assert.equal(distTagForVersion('1.0.0-beta.0'), 'beta')
  assert.equal(distTagForVersion('1.0.0-rc.2'), 'rc')
  assert.equal(distTagForVersion('1.0.0-0'), 'next')
  assert.throws(() => distTagForVersion('v1.0.0'), /not a semver/)
})

test('the changelog head is the first version heading, with or without a date', () => {
  assert.equal(changelogHeadVersion(CHANGELOG), '1.2.0-beta.3')
  assert.equal(changelogHeadVersion('# Changelog\n\n## 0.5.0 — 2026-09-10\n'), '0.5.0')
  assert.equal(changelogHeadVersion('# Changelog\n\n## Unreleased\n\n## 0.5.0\n'), null)
})

test('a changelog whose newest entry is another version blocks the release', () => {
  const result = checkSdkRelease(inputs({ packageVersion: '1.2.0' }))
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /newest entry is 1\.2\.0-beta\.3, and package\.json is 1\.2\.0/)
})

test('an Unreleased heading on top blocks the release', () => {
  const result = checkSdkRelease(inputs({ changelog: '# Changelog\n\n## Unreleased\n\n## 1.2.0-beta.3\n' }))
  assert.match(result.problems.join('\n'), /does not name a version/)
})

test('host API numbers are read from the source and every quote is held to them', () => {
  assert.deepEqual(hostApiFromSource(HOST_API_SOURCE), { version: 2, minSupported: 1 })
  assert.deepEqual(hostApiClaims('a\n`HOST_API_VERSION = 3` and HOST_API_MIN_SUPPORTED = 1'), [
    { name: 'HOST_API_VERSION', value: 3, line: 2 },
    { name: 'HOST_API_MIN_SUPPORTED', value: 1, line: 2 },
  ])
  const stale = checkSdkRelease(
    inputs({ docs: [{ path: 'docs/compatibility.md', text: 'HOST_API_VERSION = 1', required: true }] }),
  )
  assert.match(stale.problems.join('\n'), /docs\/compatibility\.md:1: says HOST_API_VERSION = 1, and host-api\.ts declares 2/)
})

test('the compatibility doc must quote the host API version at all', () => {
  const silent = checkSdkRelease(inputs({ docs: [{ path: 'docs/compatibility.md', text: 'nothing', required: true }] }))
  assert.match(silent.problems.join('\n'), /does not quote HOST_API_VERSION = 2/)
  const optional = checkSdkRelease(inputs({ docs: [{ path: 'README.md', text: 'nothing', required: false }] }))
  assert.equal(optional.ok, true)
})

test('a template built for another host API blocks the release', () => {
  const result = checkSdkRelease(
    inputs({ templateManifests: [{ path: 'templates/blank/module/manifest.json', json: { engines: { hostApi: 1 } } }] }),
  )
  assert.match(result.problems.join('\n'), /templates\/blank\/module\/manifest\.json: engines\.hostApi is 1/)
})

test('a floor above the version is refused', () => {
  const result = checkSdkRelease(
    inputs({ hostApiSource: 'export const HOST_API_VERSION = 1\nexport const HOST_API_MIN_SUPPORTED = 2\n', docs: [], templateManifests: [] }),
  )
  assert.match(result.problems.join('\n'), /HOST_API_MIN_SUPPORTED \(2\) is above HOST_API_VERSION \(1\)/)
})

test('a pushed tag must name the package version exactly', () => {
  assert.equal(checkSdkRelease(inputs({ tag: 'sdk-v1.2.0-beta.3' })).ok, true)
  const wrong = checkSdkRelease(inputs({ tag: 'sdk-v1.2.0' }))
  assert.match(wrong.problems.join('\n'), /The tag is sdk-v1\.2\.0, and package\.json is 1\.2\.0-beta\.3/)
})

// The real tree: a mismatch fails here, on the pull request that makes it.
test('this checkout is ready to publish', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const result = checkSdkReleaseTree(root)
  assert.deepEqual(result.problems, [])
})
