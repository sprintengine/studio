import { execFileSync } from 'node:child_process'

import { commitBump, strongestBump } from './conventional-commits.mjs'
import { compareCore, parseVersion } from './release-lib.mjs'

export function bumpVersion(version, bump) {
  const { major, minor, patch } = parseVersion(version)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`Unknown release bump: ${bump}`)
}

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
