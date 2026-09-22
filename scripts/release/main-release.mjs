import { execFileSync } from 'node:child_process'

import { commitBump, strongestBump } from './conventional-commits.mjs'
import { compareCore, coreVersion, parseVersion, prereleaseVersion } from './release-lib.mjs'

export function bumpVersion(version, bump) {
  const { major, minor, patch } = parseVersion(version)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`Unknown release bump: ${bump}`)
}

// The version the next stable would take if main's head were promoted: the
// strongest Conventional Commit since the last stable tag, applied to that tag.
// Nightlies carry it as their base and a promotion ships it unchanged.
//
// Full history and tags are required. Tags, including a tag left by an interrupted
// publish, reserve versions so a retry cannot attach new code to an old version.
export function resolveMainRelease({ sha, releases, packageVersion, cwd = process.cwd() }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const history = git('rev-list', '--first-parent', sha).split('\n')
  const tags = git('tag', '--list', 'v*').split('\n').filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  const tagged = tags.map((tag) => ({ tag, sha: git('rev-list', '-n', '1', tag) }))
  const published = releases.filter((release) => !release.draft && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
  const latest = published.sort((a, b) => compareCore(b.tag_name, a.tag_name))[0]
  if (latest) {
    const latestSha = tagged.find((entry) => entry.tag === latest.tag_name)?.sha
    if (!latestSha) throw new Error(`Published tag ${latest.tag_name} is missing from source history`)
    if (git('rev-list', '--first-parent', latestSha).split('\n').includes(sha)) {
      return { version: latest.tag_name.slice(1), shouldBuild: false }
    }
    if (!history.includes(latestSha)) throw new Error('The latest stable release is not on this main history')
  }

  // A squash merge's title and body are the release contract; branch-internal
  // commits are deliberately excluded from both validation and versioning.
  commitBump(git('show', '-s', '--format=%B', sha))
  const base = tagged
    .filter((entry) => history.includes(entry.sha))
    .sort((a, b) => history.indexOf(a.sha) - history.indexOf(b.sha) || compareCore(b.tag, a.tag))[0]
  if (base?.sha === sha) return { version: base.tag.slice(1), shouldBuild: true }
  const range = base ? `${base.sha}..${sha}` : sha
  const messages = git('log', '--first-parent', '--format=%B%x00', range).split('\0').map((message) => message.trim()).filter(Boolean)
  const version = bumpVersion(base?.tag ?? packageVersion, strongestBump(messages))
  const collision = tagged.find((entry) => entry.tag === `v${version}`)
  if (collision) throw new Error(`${collision.tag} already belongs to another commit`)
  return { version, shouldBuild: true }
}

// A nightly of main's head: the next stable's version on the nightly train.
// `shouldBuild` is false when the latest stable already ships this commit, since
// a nightly of it would sort below the stable its users could already have.
export function resolveNightly({ sha, releases, packageVersion, date, runNumber, cwd = process.cwd() }) {
  const plan = resolveMainRelease({ sha, releases, packageVersion, cwd })
  if (!plan.shouldBuild) return { shouldBuild: false, base: plan.version, version: null }
  return { shouldBuild: true, base: plan.version, version: prereleaseVersion(plan.version, 'nightly', date, runNumber) }
}

// The stable a promotion publishes. The nightly already carries the version the
// commits call for, so by default it ships as that version with the train
// dropped (0.5.0-nightly.20260923.41 ships as 0.5.0). An override may only
// raise it, for a maintainer declaring a bigger change than the commits did:
// a lower stable would sit below the nightlies already out, and the next
// nightly would sort below them too. A version a tag already holds is never
// reused.
export function resolvePromotion({ nightlyTag, override = '', latestStable = null, tags = [] }) {
  const base = coreVersion(nightlyTag)
  let version = base
  if (override.trim() !== '') {
    const requested = override.trim().replace(/^v/, '')
    if (parseVersion(requested).pre !== null) throw new Error(`A stable version has no prerelease part: ${override}`)
    if (compareCore(requested, base) < 0) {
      throw new Error(`${requested} is below ${base}, the version ${nightlyTag} already carries. An override may only raise it.`)
    }
    version = requested
  }
  if (latestStable && compareCore(version, latestStable) <= 0) {
    throw new Error(`${nightlyTag} would ship as ${version}, but ${latestStable} is already released.`)
  }
  if (tags.includes(`v${version}`)) throw new Error(`v${version} already belongs to another commit.`)
  return version
}

// A pushed vX.Y.Z tag: the hotfix route, which publishes exactly the tagged
// commit as that stable. The tag is not compared with package.json, which
// stays at its development baseline by rule (the workflow stamps the version
// at build time), so it could never match. What is checked is what keeps
// installs safe: the tag names a stable version, it is above every published
// stable (installed builds never move backwards), and no release holds it.
export function resolveTagRelease({ refName, latestStable = null, publishedTags = [] }) {
  const version = String(refName).replace(/^v/, '')
  if (parseVersion(version).pre !== null) {
    throw new Error(`A pushed tag publishes a stable, so it must be vX.Y.Z, not ${refName}.`)
  }
  if (latestStable && compareCore(version, latestStable) <= 0) {
    throw new Error(`v${version} is not above the latest stable v${latestStable}; installed builds would never take it.`)
  }
  if (publishedTags.includes(`v${version}`)) throw new Error(`v${version} is already published.`)
  return version
}

// Stable only ships a commit main has: a nightly whose commit was force-pushed
// away, or that was cut from anywhere but main, is refused.
export function isOnMain({ sha, mainSha, cwd = process.cwd() }) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, mainSha], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
