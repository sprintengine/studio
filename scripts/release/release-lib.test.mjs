// node --test scripts/release/release-lib.test.mjs  (npm run test:release)

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildReleaseNotes,
  channelForVersion,
  checkManifest,
  mergeMacManifests,
  missingInstallers,
  previewVersion,
  resolvePreviewBase,
  sourceShaFromBody,
  utcDateStamp,
} from './release-lib.mjs'

const SHA = 'a'.repeat(40)

const armManifest = `version: 0.4.0
files:
  - url: SprintEngine-Studio-0.4.0-mac-arm64.zip
    sha512: arm-zip
    size: 10
  - url: SprintEngine-Studio-0.4.0-mac-arm64.dmg
    sha512: arm-dmg
    size: 11
path: SprintEngine-Studio-0.4.0-mac-arm64.zip
sha512: arm-zip
releaseDate: '2026-09-11T00:00:00.000Z'
`

const x64Manifest = `version: 0.4.0
files:
  - url: SprintEngine-Studio-0.4.0-mac-x64.zip
    sha512: x64-zip
    size: 12
  - url: SprintEngine-Studio-0.4.0-mac-x64.dmg
    sha512: x64-dmg
    size: 13
path: SprintEngine-Studio-0.4.0-mac-x64.zip
sha512: x64-zip
releaseDate: '2026-09-11T00:00:00.000Z'
`

test('channelForVersion: stable, preview, and prereleases no preview build could follow', () => {
  assert.equal(channelForVersion('0.4.0'), 'latest')
  assert.equal(channelForVersion('v0.4.1-preview.20260911.3'), 'preview')
  assert.equal(channelForVersion('0.4.0-preview'), 'preview')
  assert.throws(() => channelForVersion('0.4.0-beta.1'), /not a preview version/)
  assert.throws(() => channelForVersion('0.4'), /Not a release version/)
})

test('resolvePreviewBase previews the unreleased package.json version, else the next patch', () => {
  assert.equal(resolvePreviewBase('0.4.0', null), '0.4.0')
  assert.equal(resolvePreviewBase('0.4.0', '0.3.9'), '0.4.0')
  assert.equal(resolvePreviewBase('0.4.0', '0.4.0'), '0.4.1')
  assert.equal(resolvePreviewBase('0.4.0', '0.4.2'), '0.4.3')
})

test('previewVersion orders by date then run number', () => {
  assert.equal(previewVersion('0.4.1', '20260911', 42), '0.4.1-preview.20260911.42')
  assert.throws(() => previewVersion('0.4.1', '2026-09-11', 1), /YYYYMMDD/)
  assert.throws(() => previewVersion('0.4.1', '20260911', 0), /positive integer/)
  assert.equal(utcDateStamp('2026-09-11T23:59:00Z'), '20260911')
})

test('the source sha round-trips through the release body', () => {
  const body = buildReleaseNotes({ version: '0.4.0', channel: 'latest', sourceRepo: 'o/r', sha: SHA, sourcePrivate: true })
  assert.equal(sourceShaFromBody(body), SHA)
  assert.equal(sourceShaFromBody('no marker here'), null)
  assert.equal(sourceShaFromBody(null), null)
})

test('release notes list commit subjects only when the source is public', () => {
  const commits = [{ sha: 'b'.repeat(40), subject: 'Private subject line' }]
  const privateBody = buildReleaseNotes({ version: '0.4.0', channel: 'latest', sourceRepo: 'o/r', sha: SHA, sourcePrivate: true, commits })
  assert.ok(!privateBody.includes('Private subject line'))
  assert.ok(!privateBody.includes('github.com/o/r'))
  const publicBody = buildReleaseNotes({ version: '0.4.0', channel: 'latest', sourceRepo: 'o/r', sha: SHA, sourcePrivate: false, commits })
  assert.ok(publicBody.includes('- Private subject line'))
})

test('mergeMacManifests keeps both arches, and the merged manifest passes the updater check', () => {
  const merged = mergeMacManifests(armManifest, x64Manifest)
  const assetNames = [
    'SprintEngine-Studio-0.4.0-mac-arm64.zip',
    'SprintEngine-Studio-0.4.0-mac-arm64.dmg',
    'SprintEngine-Studio-0.4.0-mac-x64.zip',
    'SprintEngine-Studio-0.4.0-mac-x64.dmg',
  ]
  assert.deepEqual(checkManifest(merged, 'mac', { version: '0.4.0', assetNames }), [])
  assert.throws(() => mergeMacManifests(armManifest, x64Manifest.replace('0.4.0', '0.4.1')), /disagree/)
})

test('checkManifest names what a single-arch or dmg-only manifest lacks', () => {
  const assetNames = ['SprintEngine-Studio-0.4.0-mac-arm64.zip', 'SprintEngine-Studio-0.4.0-mac-arm64.dmg']
  assert.deepEqual(checkManifest(armManifest, 'mac', { version: '0.4.0', assetNames }), ['has no Intel (x64) .zip'])

  const dmgOnly = `version: 0.4.0\nfiles:\n  - url: A-mac-arm64.dmg\n    sha512: x\n    size: 1\n`
  const problems = checkManifest(dmgOnly, 'mac', { version: '0.4.0', assetNames: ['A-mac-arm64.dmg'] })
  assert.ok(problems.includes('has no Apple Silicon (arm64) .zip'))
  assert.ok(problems.includes('has no Intel (x64) .zip'))

  assert.deepEqual(
    checkManifest(armManifest, 'mac', { version: '0.4.1', assetNames: [] }).slice(0, 2),
    ['names version 0.4.0, expected 0.4.1', 'lists SprintEngine-Studio-0.4.0-mac-arm64.zip, which is not on the release'],
  )
})

test('missingInstallers wants both macOS dmgs, the Windows installer and the AppImage', () => {
  assert.deepEqual(
    missingInstallers(['a-mac-arm64.dmg', 'a-mac-x64.dmg', 'a-win-x64.exe', 'a-linux-x86_64.AppImage']),
    [],
  )
  assert.deepEqual(missingInstallers(['a-mac-x64.dmg']), ['an Apple Silicon .dmg', 'a .exe', 'an .AppImage'])
})
