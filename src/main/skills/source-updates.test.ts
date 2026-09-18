// The source update check: one head resolution per repository source whose
// cadence window has elapsed, drift recorded on the source, "newly changed"
// said exactly once — and the window itself, which is what the GitHub token
// buys (MC-2519, owner ruling 2026-09-08).

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describeCheckAge,
  sourceHasUpdate,
  sourceUpdateCadenceLine,
  sourceUpdateIntervalMs,
  sourceUpdateSkipMessage,
  SOURCE_UPDATE_INTERVAL_ANONYMOUS_MS,
  SOURCE_UPDATE_INTERVAL_WITH_TOKEN_MS,
  type SkillSource,
} from '../../shared/skills'
import type { SkillRepoReader } from './repo-reader'
import { createSkillSourceStore } from './source-store'
import { createSourceUpdateChecker } from './source-updates'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function source(repo: string, commitSha: string): SkillSource {
  return {
    id: `github:${repo}`,
    kind: 'github',
    name: repo.split('/')[1],
    repo,
    monogram: 'XX',
    blurb: '',
    commitSha,
    scannedAt: '2026-09-05T09:00:00Z',
  }
}

async function main(): Promise<void> {
  const userData = await mkdtemp(join(tmpdir(), 'multicode-source-updates-'))
  const store = createSkillSourceStore(userData)
  // Our own marketplace is a repository like the rest since the
  // studio-marketplace ruling (2026-09-06), so it is checked like the rest —
  // and it is always present, which is why it appears here without being added.
  await store.putSource(source('sprintengine/studio-releases', 'sss'), null)
  await store.putSource(source('anthropics/claude-plugins-official', 'aaa'), null)
  await store.putSource(source('pbakaus/impeccable', 'bbb'), null)
  await store.putSource(source('broken/repo', 'ccc'), null)

  const heads = new Map([
    ['sprintengine/studio-releases', 'sss'],
    ['anthropics/claude-plugins-official', 'aaa'],
    ['pbakaus/impeccable', 'bbb2'],
  ])
  const asked: string[] = []
  let clock = Date.parse('2026-09-05T10:00:00Z')
  let token = ''
  const advance = (ms: number): void => {
    clock += ms
  }
  const checker = createSourceUpdateChecker({
    store,
    resolveToken: async () => token,
    resolveHead: async (candidate) => {
      asked.push(candidate.repo)
      const head = heads.get(candidate.repo)
      if (!head) throw new Error('GitHub replied with HTTP 404.')
      return head
    },
    now: () => new Date(clock),
  })

  // First check: one source moved, one did not, one could not be asked.
  const first = await checker.check()
  assert.deepEqual(asked, [
    'sprintengine/studio-releases',
    'anthropics/claude-plugins-official',
    'pbakaus/impeccable',
    'broken/repo',
  ])
  assert.deepEqual(first.changed, ['github:pbakaus/impeccable'])
  assert.deepEqual(first.newlyChanged, ['github:pbakaus/impeccable'])
  assert.deepEqual(first.skipped, [], 'a source never checked before is always due')
  assert.equal(first.failures.length, 1)
  assert.equal(first.failures[0].sourceId, 'github:broken/repo')
  assert.equal(first.sources.length, 3, 'a source that could not be asked is a failure, not a row')
  assert.equal(
    first.sources.every((entry) => entry.checked),
    true,
    'every row here was really asked',
  )

  // The head is written onto the source, so a rail can mark it without a
  // second read.
  const impeccable = await store.getSource('github:pbakaus/impeccable')
  assert.equal(impeccable?.headSha, 'bbb2')
  assert.equal(impeccable?.headCheckedAt, '2026-09-05T10:00:00.000Z')
  assert.equal(sourceHasUpdate(impeccable!), true)
  const official = await store.getSource('github:anthropics/claude-plugins-official')
  assert.equal(official?.headSha, 'aaa')
  assert.equal(sourceHasUpdate(official!), false)
  // A check that ran records that it ran, even where the head had not moved —
  // the window below reads this timestamp, so a source whose head never budges
  // must not look permanently overdue.
  assert.equal(official?.headCheckedAt, '2026-09-05T10:00:00.000Z')

  // ── The anonymous window: once a day per source ────────────────────────────
  // A second check right away, and again three hours later, asks GitHub
  // nothing: with no token the studio checks each source once a day. The rail
  // keeps its mark, because a source is not up to date merely because this run
  // did not look at it.
  asked.length = 0
  const immediately = await checker.check()
  assert.deepEqual(asked, ['broken/repo'], 'only the source that failed — nothing was recorded for it, so it is due')
  assert.deepEqual(immediately.changed, ['github:pbakaus/impeccable'], 'the rail keeps its mark')
  assert.deepEqual(immediately.newlyChanged, [], 'and nothing is announced twice')
  assert.deepEqual(
    immediately.skipped.map((entry) => entry.sourceId).sort(),
    ['github:anthropics/claude-plugins-official', 'github:pbakaus/impeccable', 'github:sprintengine/studio-releases'],
    'every source that was checked is inside its window',
  )
  assert.equal(
    immediately.sources.every((entry) => !entry.checked),
    true,
  )
  // A source that FAILED is not skipped next time: nothing was recorded for
  // it, so it is still due.
  assert.equal(
    immediately.skipped.some((entry) => entry.sourceId === 'github:broken/repo'),
    false,
    'a source the check could not reach stays due',
  )

  advance(3 * HOUR)
  asked.length = 0
  const threeHoursLater = await checker.check()
  assert.deepEqual(asked, ['broken/repo'], 'still only the unreachable one, three hours in')
  const skipMessage = threeHoursLater.skipped.find((entry) => entry.sourceId === 'github:pbakaus/impeccable')?.message
  assert.equal(
    skipMessage,
    'Checked 3 hours ago; without a GitHub token the studio checks each source once a day.',
    'a manual Check now counts against the same window, and says so rather than looking broken',
  )

  // Past a day, the source is due again, and drift found then is new drift.
  advance(22 * HOUR)
  heads.set('pbakaus/impeccable', 'bbb3')
  const nextDay = await checker.check()
  assert.ok(asked.includes('pbakaus/impeccable'), 'past 24 hours the source is asked again')
  assert.deepEqual(nextDay.newlyChanged, ['github:pbakaus/impeccable'])
  assert.deepEqual(nextDay.skipped, [], 'nothing was inside its window')

  // ── The token window: hourly, as before ───────────────────────────────────
  token = 'ghp_a_real_token'
  asked.length = 0
  advance(30 * MINUTE)
  const halfAnHourIn = await checker.check()
  assert.deepEqual(asked, ['broken/repo'], 'half an hour is still inside the hourly window')
  assert.equal(
    halfAnHourIn.skipped.find((entry) => entry.sourceId === 'github:pbakaus/impeccable')?.message,
    'Checked 30 minutes ago; the studio checks each source once an hour.',
    'with a token the reason no longer names one',
  )

  advance(31 * MINUTE)
  await checker.check()
  assert.ok(asked.includes('pbakaus/impeccable'), 'past an hour a token-configured check runs again')

  // Concurrent checks share one run.
  const [a, b] = await Promise.all([checker.check(), checker.check()])
  assert.equal(a, b)

  // ── The intervals themselves, and how Settings says them ──────────────────
  assert.equal(sourceUpdateIntervalMs(true), SOURCE_UPDATE_INTERVAL_WITH_TOKEN_MS)
  assert.equal(sourceUpdateIntervalMs(false), SOURCE_UPDATE_INTERVAL_ANONYMOUS_MS)
  assert.equal(SOURCE_UPDATE_INTERVAL_WITH_TOKEN_MS, HOUR)
  assert.equal(SOURCE_UPDATE_INTERVAL_ANONYMOUS_MS, 24 * HOUR)
  assert.equal(describeCheckAge(30_000), 'just now')
  assert.equal(describeCheckAge(MINUTE), '1 minute ago')
  assert.equal(describeCheckAge(2 * HOUR), '2 hours ago')
  assert.equal(describeCheckAge(50 * HOUR), '2 days ago')
  assert.match(sourceUpdateCadenceLine(false), /once a day/)
  assert.match(sourceUpdateCadenceLine(false), /GitHub token/)
  assert.match(sourceUpdateCadenceLine(true), /once an hour/)

  await overGit()

  console.log('skills source update tests passed')
}

/**
 * Over git: the head check is the injected reader's, and the cadence is hourly
 * for everyone (git-transport ruling, owner 2026-09-08).
 *
 * `git ls-remote` is not a REST request, so the 60-an-hour limit the daily
 * window exists to protect is not being spent — and a token, which buys nothing
 * against a protocol GitHub does not meter, stops deciding anything. The copy
 * follows: no line here names one.
 */
async function overGit(): Promise<void> {
  const userData = await mkdtemp(join(tmpdir(), 'multicode-source-updates-git-'))
  const store = createSkillSourceStore(userData)
  await store.putSource(source('anthropics/claude-plugins-official', 'aaa'), null)

  const asked: string[] = []
  let clock = Date.parse('2026-09-08T10:00:00Z')
  const reader: SkillRepoReader = {
    resolveCommit: async (repo, ref) => {
      asked.push(`${repo}#${ref}`)
      return 'aaa2'
    },
    readTree: async () => {
      throw new Error('the update check lists nothing')
    },
    readFile: async () => {
      throw new Error('the update check reads nothing')
    },
  }
  const checker = createSourceUpdateChecker({
    store,
    // No token at all, which on the API path would mean a daily window.
    resolveToken: async () => '',
    repoReader: reader,
    transport: 'git',
    now: () => new Date(clock),
  })

  const first = await checker.check()
  assert.deepEqual(
    asked,
    // Our own marketplace is always in the list; both are asked through the
    // reader, and the empty ref after `#` is "the default branch".
    ['sprintengine/studio-releases#', 'anthropics/claude-plugins-official#'],
    'the reader resolved the head, not the API',
  )
  assert.deepEqual(first.newlyChanged, ['github:anthropics/claude-plugins-official'])

  // Half an hour in, still inside the hourly window — and the sentence says so
  // without mentioning a token.
  clock += 30 * MINUTE
  asked.length = 0
  const inWindow = await checker.check()
  assert.deepEqual(asked, [], 'half an hour is inside the hourly window')
  const message = inWindow.skipped.find(
    (entry) => entry.sourceId === 'github:anthropics/claude-plugins-official',
  )?.message
  assert.equal(message, 'Checked 30 minutes ago; the studio checks each source once an hour over git.')
  assert.doesNotMatch(message ?? '', /token/, 'the token is not what decides this cadence')

  // Past the hour it is asked again, with no token anywhere in sight.
  clock += 31 * MINUTE
  await checker.check()
  assert.deepEqual(
    asked,
    ['sprintengine/studio-releases#', 'anthropics/claude-plugins-official#'],
    'past an hour they are asked again',
  )

  // The cadence itself, and the two sentences Settings and the door say.
  assert.equal(sourceUpdateIntervalMs(false, 'git'), SOURCE_UPDATE_INTERVAL_WITH_TOKEN_MS)
  assert.equal(sourceUpdateIntervalMs(true, 'git'), SOURCE_UPDATE_INTERVAL_WITH_TOKEN_MS)
  assert.equal(sourceUpdateIntervalMs(false, 'api'), SOURCE_UPDATE_INTERVAL_ANONYMOUS_MS)
  assert.equal(
    sourceUpdateSkipMessage(2 * HOUR, false, 'api'),
    'Checked 2 hours ago; without a GitHub token the studio checks each source once a day.',
    'the API fallback keeps every word it had',
  )
  assert.match(sourceUpdateCadenceLine(false, 'git'), /once an hour/)
  assert.match(sourceUpdateCadenceLine(false, 'git'), /git ls-remote/)
  assert.match(
    sourceUpdateCadenceLine(false, 'git'),
    /not what decides the cadence/,
    'it names the token only to say it decides nothing here',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
