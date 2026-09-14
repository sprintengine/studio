// node --test scripts/release/release-lib.test.mjs  (npm run test:release)

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  anonymousGet,
  buildReleaseNotes,
  channelForVersion,
  checkManifest,
  checkPublicRelease,
  feedTags,
  mergeMacManifests,
  missingInstallers,
  previewVersion,
  resolvePreviewBase,
  sourceShaFromBody,
  updaterUrls,
  utcDateStamp,
  verifyPublicRelease,
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

// The unauthenticated half of `release.mjs verify`. Every request is served
// from a fixture: these tests describe what a user's updater would see, and a
// test that needed the network could not run on a release that is broken.

const REPO = 'acme/studio-releases'

const winManifest = `version: 0.4.0
files:
  - url: SprintEngine-Studio-0.4.0-win-x64.exe
    sha512: exe
    size: 20
path: SprintEngine-Studio-0.4.0-win-x64.exe
sha512: exe
releaseDate: '2026-09-11T00:00:00.000Z'
`

const linuxManifest = `version: 0.4.0
files:
  - url: SprintEngine-Studio-0.4.0-linux-x86_64.AppImage
    sha512: appimage
    size: 21
path: SprintEngine-Studio-0.4.0-linux-x86_64.AppImage
sha512: appimage
releaseDate: '2026-09-11T00:00:00.000Z'
`

const RELEASE_ASSETS = [
  'SprintEngine-Studio-0.4.0-mac-arm64.zip',
  'SprintEngine-Studio-0.4.0-mac-arm64.dmg',
  'SprintEngine-Studio-0.4.0-mac-x64.zip',
  'SprintEngine-Studio-0.4.0-mac-x64.dmg',
  'SprintEngine-Studio-0.4.0-win-x64.exe',
  'SprintEngine-Studio-0.4.0-linux-x86_64.AppImage',
]

const ok = (text) => ({ ok: true, status: 200, text })

function atomFeed(tags) {
  const entries = tags.map(
    (tag) =>
      `  <entry>\n    <title>${tag}</title>\n` +
      `    <link rel="alternate" type="text/html" href="https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}"/>\n` +
      `  </entry>`,
  )
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed>\n${entries.join('\n')}\n</feed>\n`
}

// Anything not published answers 404, which is what GitHub does.
const servedBy = (responses) => async (url) => responses[url] ?? { ok: false, status: 404, text: '' }

// A release as it stands on the releases repository: the feed it appears in,
// the tag /releases/latest resolves to, and the three channel manifests, all
// named after the version so a preview and a stable differ the way they really
// do. Defaults describe a healthy publish; every test breaks one thing.
function published(version, { feed, latest } = {}) {
  const tag = `v${version}`
  const channel = channelForVersion(version)
  const forVersion = (text) => text.replaceAll('0.4.0', version)
  const assetNames = RELEASE_ASSETS.map(forVersion)
  const urls = updaterUrls({ repo: REPO, tag, channel })
  const responses = {
    [urls.feed]: ok(atomFeed(feed ?? [tag])),
    [urls.manifests.win]: ok(forVersion(winManifest)),
    [urls.manifests.mac]: ok(forVersion(mergeMacManifests(armManifest, x64Manifest))),
    [urls.manifests.linux]: ok(forVersion(linuxManifest)),
  }
  const pointer = latest === undefined ? (channel === 'latest' ? tag : null) : latest
  if (pointer) responses[urls.latestPointer] = ok(JSON.stringify({ tag_name: pointer }))
  const world = { tag, channel, version, assetNames, urls, responses }
  world.check = () => checkPublicRelease({ repo: REPO, tag, channel, version, assetNames, get: servedBy(responses) })
  return world
}

test('anonymousGet sends no credential, whatever is in the environment', async () => {
  const sent = []
  const previousToken = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'ghp_not_a_real_token'
  try {
    const get = anonymousGet(async (url, init) => {
      sent.push({ url, headers: init.headers })
      return { ok: true, status: 200, text: async () => 'body' }
    })
    assert.deepEqual(await get('https://github.com/acme/studio-releases/releases.atom', { accept: 'application/xml' }), {
      ok: true,
      status: 200,
      text: 'body',
    })
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousToken
  }
  const headerNames = Object.keys(sent[0].headers).map((name) => name.toLowerCase())
  assert.deepEqual(headerNames, ['accept', 'user-agent'])
  assert.ok(!JSON.stringify(sent[0]).includes('ghp_not_a_real_token'))
})

test('anonymousGet reports a refused connection rather than throwing', async () => {
  const get = anonymousGet(async () => {
    throw new Error('getaddrinfo ENOTFOUND github.com')
  })
  const response = await get('https://github.com/acme/studio-releases/releases.atom')
  assert.equal(response.ok, false)
  assert.equal(response.status, 0)
  assert.match(response.error, /ENOTFOUND/)
})

test('updaterUrls names the files electron-updater downloads for each channel', () => {
  const stable = updaterUrls({ repo: REPO, tag: 'v0.4.0', channel: 'latest' })
  assert.equal(stable.feed, `https://github.com/${REPO}/releases.atom`)
  assert.equal(stable.latestPointer, `https://github.com/${REPO}/releases/latest`)
  assert.deepEqual(Object.values(stable.manifests), [
    `https://github.com/${REPO}/releases/download/v0.4.0/latest.yml`,
    `https://github.com/${REPO}/releases/download/v0.4.0/latest-mac.yml`,
    `https://github.com/${REPO}/releases/download/v0.4.0/latest-linux.yml`,
  ])

  const preview = updaterUrls({ repo: REPO, tag: 'v0.4.1-preview.20260911.3', channel: 'preview' })
  assert.deepEqual(Object.values(preview.manifests), [
    `https://github.com/${REPO}/releases/download/v0.4.1-preview.20260911.3/preview.yml`,
    `https://github.com/${REPO}/releases/download/v0.4.1-preview.20260911.3/preview-mac.yml`,
    `https://github.com/${REPO}/releases/download/v0.4.1-preview.20260911.3/preview-linux.yml`,
  ])
})

test('feedTags reads the feed newest first, as the updater does', () => {
  assert.deepEqual(feedTags(atomFeed(['v0.4.1-preview.20260911.3', 'v0.4.0'])), ['v0.4.1-preview.20260911.3', 'v0.4.0'])
  assert.deepEqual(feedTags(atomFeed(['app@0.4.0'])), ['app@0.4.0'])
  assert.deepEqual(feedTags('<feed></feed>'), [])
})

test('a complete public release, stable and preview, has nothing to report', async () => {
  assert.deepEqual((await published('0.4.0').check()).problems, [])
  // A stable release is resolved through /releases/latest, so previews sitting
  // above it in the feed are none of its business.
  const stableUnderPreviews = published('0.4.0', { feed: ['v0.4.1-preview.20260912.9', 'v0.4.0'] })
  assert.deepEqual((await stableUnderPreviews.check()).problems, [])
  const preview = published('0.4.1-preview.20260911.3', {
    feed: ['v0.4.1-preview.20260911.3', 'v0.4.0'],
    latest: 'v0.4.0',
  })
  assert.deepEqual((await preview.check()).problems, [])
})

test('a releases repository no user can read fails at once, and says what to look at', async () => {
  const waits = []
  const problems = await verifyPublicRelease({
    repo: REPO,
    tag: 'v0.4.0',
    channel: 'latest',
    version: '0.4.0',
    assetNames: RELEASE_ASSETS,
    get: servedBy({}),
    attempts: 5,
    delayMs: 1,
    wait: async (ms) => waits.push(ms),
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /releases\.atom answered HTTP 404 without credentials/)
  assert.match(problems[0], /is public/)
  assert.match(problems[0], /build\.publish/)
  // Waiting cannot make a private repository public.
  assert.deepEqual(waits, [])
})

test('a release the feed has not caught up with is polled for, not failed on', async () => {
  const world = published('0.4.0', { feed: [] })
  const waits = []
  const problems = await verifyPublicRelease({
    repo: REPO,
    tag: world.tag,
    channel: world.channel,
    version: world.version,
    assetNames: world.assetNames,
    get: servedBy(world.responses),
    attempts: 3,
    delayMs: 1,
    wait: async (ms) => {
      waits.push(ms)
      world.responses[world.urls.feed] = ok(atomFeed([world.tag]))
    },
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(waits, [1])
})

test('a release missing from the feed after every attempt is reported with what the feed does list', async () => {
  const world = published('0.4.0', { feed: ['v0.3.9'] })
  const problems = await verifyPublicRelease({
    repo: REPO,
    tag: world.tag,
    channel: world.channel,
    version: world.version,
    assetNames: world.assetNames,
    get: servedBy(world.responses),
    attempts: 2,
    delayMs: 1,
    wait: async () => {},
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /v0\.4\.0 is not in .*releases\.atom, which lists v0\.3\.9/)
  assert.match(problems[0], /draft/)
})

test('the stable pointer must name the release, and must not name a preview', async () => {
  const stale = await published('0.4.0', { latest: 'v0.3.9' }).check()
  assert.equal(stale.problems.length, 1)
  assert.match(stale.problems[0], /resolves to v0\.3\.9, not v0\.4\.0/)
  assert.match(stale.problems[0], /gh release edit v0\.4\.0 --latest/)

  const previewTag = 'v0.4.1-preview.20260911.3'
  const mislabelled = await published('0.4.1-preview.20260911.3', { feed: [previewTag], latest: previewTag }).check()
  assert.equal(mislabelled.problems.length, 1)
  assert.match(mislabelled.problems[0], /resolves to v0\.4\.1-preview\.20260911\.3, a preview/)
  assert.match(mislabelled.problems[0], /--latest=false/)
  // A preview that stable users could be offered is a mistake waiting will not
  // undo, so it is not retried.
  assert.equal(mislabelled.retryable, false)
})

test('a preview behind a newer preview in the feed reaches nobody', async () => {
  const world = published('0.4.1-preview.20260911.3', {
    feed: ['v0.4.1-preview.20260912.9', 'v0.4.1-preview.20260911.3', 'v0.4.0'],
  })
  const { problems, retryable } = await world.check()
  assert.equal(problems.length, 1)
  assert.match(problems[0], /lists v0\.4\.1-preview\.20260912\.9 above v0\.4\.1-preview\.20260911\.3/)
  assert.equal(retryable, false)
})

test('a manifest the release page will not serve is named with the error it causes', async () => {
  const world = published('0.4.1-preview.20260911.3')
  delete world.responses[world.urls.manifests.linux]
  const { problems, retryable } = await world.check()
  assert.equal(problems.length, 1)
  assert.match(problems[0], /preview-linux\.yml answered HTTP 404 without credentials/)
  assert.match(problems[0], /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/)
  assert.equal(retryable, true)
})

test('a manifest served to users is checked, not only the copy the token can read', async () => {
  const world = published('0.4.0')
  world.responses[world.urls.manifests.mac] = ok(armManifest)
  const { problems, retryable } = await world.check()
  assert.deepEqual(problems, [`${world.urls.manifests.mac} has no Intel (x64) .zip`])
  assert.equal(retryable, false)
})
