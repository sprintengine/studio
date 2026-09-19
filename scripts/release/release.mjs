#!/usr/bin/env node
// The GitHub-facing half of .github/workflows/release.yml. One file, four
// subcommands, each run by one workflow step:
//
//   resolve                 decide what this run builds: channel, version, commit
//   notes <out-file>        write the release body
//   merge-mac <dir> <ch>    fold the two macOS manifests into one
//   verify                  prove the published release is installable, and
//                           reachable by an updater holding no credentials
//
// Inputs arrive as environment variables set by the workflow, outputs go to
// $GITHUB_OUTPUT. The pure logic is in release-lib.mjs.

import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  anonymousGet,
  buildReleaseNotes,
  channelForVersion,
  checkManifest,
  compareCore,
  coreVersion,
  manifestNames,
  mergeMacManifests,
  missingInstallers,
  parseVersion,
  previewVersion,
  resolvePreviewBase,
  sourceShaFromBody,
  updaterUrls,
  utcDateStamp,
  verifyPublicRelease,
} from './release-lib.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
// The releases repository is whatever electron-builder is configured to publish
// to, so the workflow and app-update.yml cannot disagree about it.
const RELEASES_REPO = `${packageJson.build.publish.owner}/${packageJson.build.publish.repo}`

// The self-hosted Mac only while the source is private: GitHub-hosted macOS
// minutes bill at 10x there and are free once public. On a public repository a
// fork's pull request can rewrite a workflow to run on any self-hosted runner,
// so nothing may depend on it after the switch.
const SELF_HOSTED_MAC = ['self-hosted', 'macOS', 'ARM64']
const HOSTED_MAC_ARM64 = 'macos-15'

function env(name, { required = true } = {}) {
  const value = process.env[name] ?? ''
  if (required && value === '') throw new Error(`${name} is not set`)
  return value
}

function setOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`)
  for (const line of lines) console.log(line)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

async function github(apiPath, token, { accept = 'application/vnd.github+json', allow404 = false } = {}) {
  const headers = { accept, 'user-agent': 'sprintengine-release', 'x-github-api-version': '2022-11-28' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`https://api.github.com${apiPath}`, { headers })
  if (allow404 && response.status === 404) return null
  if (!response.ok) throw new Error(`GET ${apiPath} answered ${response.status}: ${await response.text()}`)
  return accept.includes('json') ? response.json() : response.text()
}

async function listPublishedReleases(token) {
  const releases = []
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(`/repos/${RELEASES_REPO}/releases?per_page=100&page=${page}`, token)
    releases.push(...batch)
    if (batch.length < 100) break
  }
  return releases.filter((release) => !release.draft && release.published_at)
}

function versionOf(release) {
  try {
    return { version: parseVersion(release.tag_name), raw: release.tag_name.replace(/^v/, '') }
  } catch {
    return null
  }
}

function latestStable(releases) {
  return releases
    .map(versionOf)
    .filter((entry) => entry && entry.version.pre === null)
    .map((entry) => entry.raw)
    .sort((a, b) => compareCore(b, a))[0] ?? null
}

function latestRelease(releases, predicate) {
  return releases
    .filter((release) => {
      const entry = versionOf(release)
      return entry && predicate(entry.raw)
    })
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0] ?? null
}

const isPreview = (raw) => parseVersion(raw).pre !== null

async function resolve() {
  const eventName = env('EVENT_NAME')
  const sha = env('SHA')
  const sourceRepo = env('SOURCE_REPO')
  const sourceToken = env('SOURCE_TOKEN')
  const dispatchChannel = env('DISPATCH_CHANNEL', { required: false }) || 'preview'
  const publish = eventName !== 'workflow_dispatch' || env('DISPATCH_PUBLISH', { required: false }) !== 'false'

  const source = await github(`/repos/${sourceRepo}`, sourceToken)
  const releases = await listPublishedReleases(sourceToken)
  const stable = latestStable(releases)
  const lastPreview = latestRelease(releases, isPreview)
  const lastStableRelease = latestRelease(releases, (raw) => !isPreview(raw))

  let version
  let ref = sha
  let shouldBuild = true

  if (eventName === 'push') {
    // A pushed tag builds that commit, and must name the version package.json
    // already carries: the tag is a claim about the tree it points at.
    version = env('REF_NAME').replace(/^v/, '')
    if (version !== packageJson.version) {
      throw new Error(`Tag v${version} does not match package.json version ${packageJson.version}`)
    }
  } else if (eventName === 'schedule' || dispatchChannel === 'preview') {
    version = previewVersion(
      resolvePreviewBase(packageJson.version, stable),
      utcDateStamp(env('RUN_STARTED_AT', { required: false }) || new Date().toISOString()),
      env('RUN_NUMBER'),
    )
    if (eventName === 'schedule') shouldBuild = await hasNewCommits(sourceRepo, sourceToken, lastPreview, sha)
  } else if (dispatchChannel === 'stable') {
    // Stable ships the exact commit the latest preview shipped, so a stable
    // build is always one preview users have already run.
    if (!lastPreview) throw new Error('No published preview to promote. Run a preview release first.')
    ref = sourceShaFromBody(lastPreview.body)
    if (!ref) throw new Error(`${lastPreview.tag_name} does not record its source commit, so it cannot be promoted.`)
    version = coreVersion(lastPreview.tag_name)
    if (stable && compareCore(version, stable) <= 0) {
      throw new Error(`${lastPreview.tag_name} previews ${version}, but ${stable} is already released.`)
    }
    console.log(`Promoting ${lastPreview.tag_name} (${ref}) to ${version}.`)
  } else {
    throw new Error(`Unknown release channel ${dispatchChannel}`)
  }

  const channel = channelForVersion(version)
  const tag = `v${version}`
  if (shouldBuild && releases.some((release) => release.tag_name === tag)) {
    throw new Error(`${tag} is already published on ${RELEASES_REPO}.`)
  }
  const previous = channel === 'preview' ? lastPreview : lastStableRelease

  setOutputs({
    should_build: String(shouldBuild),
    publish: String(publish),
    version,
    tag,
    channel,
    prerelease: String(channel === 'preview'),
    ref,
    previous_sha: sourceShaFromBody(previous?.body) ?? '',
    source_private: String(source.private),
    mac_arm64_runner: JSON.stringify(source.private ? SELF_HOSTED_MAC : HOSTED_MAC_ARM64),
  })
}

async function hasNewCommits(sourceRepo, token, lastPreview, sha) {
  const lastSha = sourceShaFromBody(lastPreview?.body)
  if (!lastSha) {
    console.log('No earlier preview records a source commit. Building.')
    return true
  }
  if (lastSha === sha) {
    console.log(`${lastPreview.tag_name} already shipped ${sha}. Skipping.`)
    return false
  }
  const comparison = await github(`/repos/${sourceRepo}/compare/${lastSha}...${sha}?per_page=1`, token, { allow404: true })
  if (!comparison) {
    console.log(`Cannot compare against ${lastSha}. Building.`)
    return true
  }
  const ahead = comparison.status === 'ahead' || comparison.status === 'diverged'
  console.log(`main is ${comparison.status} relative to ${lastPreview.tag_name}. ${ahead ? 'Building.' : 'Skipping.'}`)
  return ahead
}

async function notes(outFile) {
  const sourceRepo = env('SOURCE_REPO')
  const sourcePrivate = env('SOURCE_PRIVATE') === 'true'
  const sha = env('REF')
  const previousSha = env('PREVIOUS_SHA', { required: false })
  let commits = []
  if (!sourcePrivate && previousSha) {
    const comparison = await github(`/repos/${sourceRepo}/compare/${previousSha}...${sha}`, env('SOURCE_TOKEN'), { allow404: true })
    commits = (comparison?.commits ?? [])
      .map((commit) => ({ sha: commit.sha, subject: commit.commit.message.split('\n')[0] }))
      .reverse()
  }
  writeFileSync(
    outFile,
    buildReleaseNotes({ version: env('VERSION'), channel: env('CHANNEL'), sourceRepo, sha, sourcePrivate, commits }),
  )
}

function mergeMac(dir, channel) {
  const arm64Path = path.join(dir, `${channel}-mac.yml`)
  const x64Path = path.join(dir, `${channel}-mac-x64.yml`)
  const merged = mergeMacManifests(readFileSync(arm64Path, 'utf8'), readFileSync(x64Path, 'utf8'))
  writeFileSync(arm64Path, merged)
  rmSync(x64Path)
  console.log(merged)
}

// v0.3.0 is why this exists. That run went green on every job and published
// nothing anyone could read: build.publish still named the PRIVATE source repo.
// A release that publishes to the wrong place, publishes half its files, or
// ships a manifest the updater cannot use must not report success.
//
// Two passes, and the second is the one that class of bug fails: the API pass
// proves the release is complete, the unauthenticated pass proves a user can
// get at it. A private releases repository passes the first perfectly.
async function verify() {
  const token = env('SOURCE_TOKEN')
  const tag = env('TAG')
  const version = env('VERSION')
  const channel = env('CHANNEL')
  const release = await github(`/repos/${RELEASES_REPO}/releases/tags/${tag}`, token, { allow404: true })
  if (!release) throw new Error(`No release ${tag} on ${RELEASES_REPO}.`)

  const problems = []
  if (release.draft) problems.push('the release is still a draft')
  if (release.prerelease !== (channel === 'preview')) problems.push(`prerelease is ${release.prerelease}`)
  const assetNames = release.assets.map((asset) => asset.name)
  console.log(`Assets on ${tag}:\n${assetNames.map((name) => `  ${name}`).join('\n')}`)
  for (const missing of missingInstallers(assetNames)) problems.push(`missing ${missing}`)
  if (assetNames.some((name) => name.endsWith('-mac-x64.yml'))) problems.push('the Intel macOS manifest was not merged')

  for (const [platform, name] of Object.entries(manifestNames(channel))) {
    const asset = release.assets.find((candidate) => candidate.name === name)
    if (!asset) {
      problems.push(`missing ${name}`)
      continue
    }
    const text = await github(`/repos/${RELEASES_REPO}/releases/assets/${asset.id}`, token, { accept: 'application/octet-stream' })
    for (const problem of checkManifest(text, platform, { version, assetNames })) problems.push(`${name} ${problem}`)
  }

  if (problems.length > 0) throw new Error(`Release ${tag} is not installable:\n  - ${problems.join('\n  - ')}`)
  console.log(`Release ${tag} is complete on ${RELEASES_REPO}.`)

  // Everything above answered while holding the job's token, which is exactly
  // the credential no user has. Ask again with none, at the URLs the shipped
  // updater reads, so a releases repository that is private or misnamed fails
  // here rather than in the silence of an app that never finds an update.
  const urls = updaterUrls({ repo: RELEASES_REPO, tag, channel })
  console.log(`Checking without credentials:\n  ${[urls.feed, urls.latestPointer, ...Object.values(urls.manifests)].join('\n  ')}`)
  const unreachable = await verifyPublicRelease({
    repo: RELEASES_REPO,
    tag,
    channel,
    version,
    assetNames,
    get: anonymousGet(),
  })
  if (unreachable.length > 0) {
    throw new Error(`Release ${tag} is published but installed builds cannot reach it:\n  - ${unreachable.join('\n  - ')}`)
  }
  console.log(`Release ${tag} is readable on ${RELEASES_REPO} without credentials.`)
}

const [command, ...args] = process.argv.slice(2)
const commands = {
  resolve: () => resolve(),
  notes: () => notes(args[0] ?? 'release-notes.md'),
  'merge-mac': () => mergeMac(args[0], args[1]),
  verify: () => verify(),
}

if (!commands[command]) {
  console.error(`usage: release.mjs ${Object.keys(commands).join(' | ')}`)
  process.exit(2)
}
try {
  await commands[command]()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
