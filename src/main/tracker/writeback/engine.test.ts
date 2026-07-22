import assert from 'node:assert/strict'

import type { TrackerCapabilities, TrackerProviderId } from '../../../shared/tracker/types'
import { DEFAULT_TRACKER_WRITEBACK_CONFIG, type TrackerWriteBackConfig } from '../../../shared/tracker/writeback'
import {
  desiredPostsFor,
  TrackerWriteBackEngine,
  type ProxyItemLookup,
  type RunProxyItem,
  type RunStateReader,
  type RunWriteBackFacts,
  type TrackerWriteBackPoster,
  type WriteBackCapabilityResolver,
  type WriteBackConfigReader,
} from './engine'
import { TrackerWriteBackLedger } from './ledger'

// Verifies the acceptance-critical write-back engine behavior (MC-1640 / T10):
// the reconcile lifecycle producing exactly three comments (started/PR/completed)
// and staying idempotent across an app restart; event→post mapping and ordering;
// capability gating; the honesty gate (a done comment only when the run store
// says completed); failure isolation with retry-on-next-event; and disabling
// mid-run stopping future posts without retracting anything.

const GITHUB_CAPS: TrackerCapabilities = { canComment: true, canTransition: false, selfHostable: true }
const JIRA_CAPS: TrackerCapabilities = { canComment: true, canTransition: true, selfHostable: true }
const LINEAR_CAPS: TrackerCapabilities = { canComment: false, canTransition: false, selfHostable: false }

async function main(): Promise<void> {
  await testExactlyThreeCommentsAcrossLifecycleAndRestart()
  await testHonestyCompletionGatedOnRunStore()
  await testDisablingMidRunStopsFuturePostsAndRetractsNothing()
  await testFailureIsolationRetriesOnNextEvent()
  await testCapabilityGatingSkipsUnsupportedPosts()
  await testTransitionTierMapsRunEventsToNamedTransitions()
  await testMultiRepoPrCommentsPostPerUrlSet()
  testEventToPostMappingAndOrdering()

  console.log('tracker-writeback-engine tests passed')
}

// ---------------------------------------------------------------------------
// Multi-repo PR comment (MC-1730 item 6): the comment:pr key folds the sorted
// PR-URL set, so a later repo's PR (a new set) posts its own comment instead of
// being deduped away by the first PR's key — while a redundant reconcile of the
// same set stays idempotent.
// ---------------------------------------------------------------------------
async function testMultiRepoPrCommentsPostPerUrlSet(): Promise<void> {
  const poster = recordingPoster()
  const firstPr = 'https://github.com/o/r/pull/7'
  const secondPr = 'https://github.com/o/r2/pull/3'
  const runState = mutableRunState({ ...startedFacts(), pullRequestUrls: [firstPr] })
  const engine = new TrackerWriteBackEngine({
    runState,
    proxyItems: proxyLookup([githubItem()]),
    config: configReader({ 'conn-gh': allCommentsOn() }),
    capabilities: capabilityResolver({ github: GITHUB_CAPS }),
    poster,
    ledger: new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter }),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  })

  const prComments = () => poster.comments.filter((c) => /Pull request/.test(c.body))

  // First PR set → one PR comment. A redundant reconcile at the same set adds none.
  await engine.reconcileRun(run())
  await engine.reconcileRun(run())
  assert.equal(prComments().length, 1)

  // A second repo's PR arrives (arrival order does not matter — the key sorts the
  // set) → a second PR comment listing both.
  runState.set({ ...startedFacts(), pullRequestUrls: [secondPr, firstPr] })
  await engine.reconcileRun(run())
  assert.equal(prComments().length, 2)
  assert.match(prComments()[1].body, /pull\/3/)

  // Reconciling the same two-PR set again is idempotent — still two.
  await engine.reconcileRun(run())
  assert.equal(prComments().length, 2)
}

// ---------------------------------------------------------------------------
// Acceptance 1: exactly three comments (started/PR/completed), and exactly three
// after an app restart mid-run.
// ---------------------------------------------------------------------------
async function testExactlyThreeCommentsAcrossLifecycleAndRestart(): Promise<void> {
  const fs = memoryFs()
  const poster = recordingPoster()
  const proxy = proxyLookup([githubItem()])
  const config = configReader({ 'conn-gh': allCommentsOn() })
  const caps = capabilityResolver({ github: GITHUB_CAPS })

  const runState = mutableRunState(startedFacts())
  const engine = new TrackerWriteBackEngine({
    runState,
    proxyItems: proxy,
    config,
    capabilities: caps,
    poster,
    ledger: new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: fs.adapter }),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  })

  // started → 1 comment.
  await engine.reconcileRun(run())
  assert.equal(poster.comments.length, 1)
  assert.match(poster.comments[0].body, /Sprint started/)

  // a redundant reconcile at the same state posts nothing more (idempotent).
  await engine.reconcileRun(run())
  assert.equal(poster.comments.length, 1)

  // PR opened → a second comment.
  runState.set(withPullRequest(startedFacts(), 'https://github.com/o/r/pull/7'))
  await engine.reconcileRun(run())
  assert.equal(poster.comments.length, 2)
  assert.match(poster.comments[1].body, /Pull request opened/)

  // completed → a third comment. Total exactly three.
  runState.set(completedFacts(['https://github.com/o/r/pull/7']))
  await engine.reconcileRun(run())
  assert.equal(poster.comments.length, 3)
  assert.match(poster.comments[2].body, /Sprint completed/)

  // App restart mid-run: a FRESH ledger loaded from the same persisted file, a
  // fresh engine, reconciling the completed run again posts nothing — still three.
  const restartPoster = recordingPoster()
  const restarted = new TrackerWriteBackEngine({
    runState: mutableRunState(completedFacts(['https://github.com/o/r/pull/7'])),
    proxyItems: proxy,
    config,
    capabilities: caps,
    poster: restartPoster,
    // The run is still on disk across the restart, so the reloaded ledger keeps
    // its posted records (idempotency) rather than evicting them as gone.
    ledger: new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: fs.adapter, runStateExists: async () => true }),
    now: () => new Date('2026-07-19T13:00:00.000Z'),
  })
  await restarted.reconcileRun(run())
  assert.equal(restartPoster.comments.length, 0, 'restart must not re-post already-recorded comments')
}

// ---------------------------------------------------------------------------
// Acceptance 5 (honesty-vs-run-store): a done comment only when the run facts say
// completed. A run whose facts report not-completed never posts a completion,
// even though other posts (started) already happened.
// ---------------------------------------------------------------------------
async function testHonestyCompletionGatedOnRunStore(): Promise<void> {
  const poster = recordingPoster()
  const engine = buildEngine({
    facts: startedFacts(), // started, NOT completed
    items: [githubItem()],
    configs: { 'conn-gh': allCommentsOn() },
    caps: { github: GITHUB_CAPS },
    poster,
  })
  await engine.reconcileRun(run())
  assert.ok(
    poster.comments.every((c) => !/Sprint completed/.test(c.body)),
    'no completion comment while the run store reports the run is not completed',
  )
  assert.equal(poster.comments.length, 1) // only the started comment
}

// ---------------------------------------------------------------------------
// Acceptance 3: disabling write-back mid-run stops future posts; nothing already
// posted is retracted.
// ---------------------------------------------------------------------------
async function testDisablingMidRunStopsFuturePostsAndRetractsNothing(): Promise<void> {
  const poster = recordingPoster()
  const config = configReader({ 'conn-gh': allCommentsOn() })
  const runState = mutableRunState(startedFacts())
  const engine = new TrackerWriteBackEngine({
    runState,
    proxyItems: proxyLookup([githubItem()]),
    config,
    capabilities: capabilityResolver({ github: GITHUB_CAPS }),
    poster,
    ledger: new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter }),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  })

  await engine.reconcileRun(run())
  assert.equal(poster.comments.length, 1) // started posted

  // Disable mid-run, then complete: no completion comment, and the started
  // comment is not retracted (the poster only ever adds, never removes).
  config.set('conn-gh', { ...allCommentsOn(), enabled: false })
  runState.set(completedFacts([]))
  const summary = await engine.reconcileRun(run())
  assert.equal(poster.comments.length, 1, 'no new post after disabling')
  assert.equal(summary.posted, 0)
}

// ---------------------------------------------------------------------------
// Acceptance 4: a post failure never fails the run; it retries on the next event.
// ---------------------------------------------------------------------------
async function testFailureIsolationRetriesOnNextEvent(): Promise<void> {
  const ledger = new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter })
  const failing = recordingPoster()
  failing.failNextComment = true

  const runState = mutableRunState(startedFacts())
  const engine = new TrackerWriteBackEngine({
    runState,
    proxyItems: proxyLookup([githubItem()]),
    config: configReader({ 'conn-gh': allCommentsOn() }),
    capabilities: capabilityResolver({ github: GITHUB_CAPS }),
    poster: failing,
    ledger,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  })

  // First attempt throws inside the poster; reconcile still resolves (never
  // throws) and reports the failure.
  const first = await engine.reconcileRun(run())
  assert.equal(first.failed, 1)
  assert.equal(first.posted, 0)
  assert.equal(await ledger.hasPosted(startedKey()), false, 'a failed post is not recorded as posted')
  const notices = await ledger.listNotices()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].postKind, 'comment:started')

  // Next real event: the poster now succeeds, so the still-due started comment
  // retries and lands — and the notice clears.
  failing.failNextComment = false
  const second = await engine.reconcileRun(run())
  assert.equal(second.posted, 1)
  assert.equal(await ledger.hasPosted(startedKey()), true)
  assert.equal((await ledger.listNotices()).length, 0, 'a later success clears the failure notice')
}

// ---------------------------------------------------------------------------
// Capability gating: a provider that cannot comment (Linear) never has a comment
// attempted; a provider that cannot transition never has a transition attempted.
// ---------------------------------------------------------------------------
async function testCapabilityGatingSkipsUnsupportedPosts(): Promise<void> {
  const poster = recordingPoster()
  const engine = buildEngine({
    facts: completedFacts([]),
    items: [linearItem()],
    configs: {
      'conn-linear': { enabled: true, comments: { started: true, pr: true, done: true }, transitions: { onStart: 't1', onComplete: 't2' } },
    },
    caps: { linear: LINEAR_CAPS },
    poster,
  })
  const summary = await engine.reconcileRun(run())
  assert.equal(poster.comments.length, 0, 'Linear cannot comment ⇒ no comment attempted')
  assert.equal(poster.transitions.length, 0, 'Linear cannot transition ⇒ no transition attempted')
  assert.equal(summary.posted, 0)
}

// ---------------------------------------------------------------------------
// Tier 2 transitions: a mapped named transition on start/complete is applied via
// transitionIssue for a provider that supports it (Jira).
// ---------------------------------------------------------------------------
async function testTransitionTierMapsRunEventsToNamedTransitions(): Promise<void> {
  const poster = recordingPoster()
  const engine = buildEngine({
    facts: completedFacts([]),
    items: [jiraItem()],
    configs: {
      'conn-jira': {
        enabled: true,
        comments: { started: false, pr: false, done: false },
        transitions: { onStart: 'trans-start', onComplete: 'trans-done' },
      },
    },
    caps: { jira: JIRA_CAPS },
    poster,
  })
  await engine.reconcileRun(run())
  // A completed run is also started, so both mapped transitions fire.
  const ids = poster.transitions.map((t) => t.transitionId).sort()
  assert.deepEqual(ids, ['trans-done', 'trans-start'])
  assert.equal(poster.comments.length, 0)
}

// ---------------------------------------------------------------------------
// Event→post mapping and ordering (pure): comments before transitions per event,
// started → PR → completed across events, each gated by fact + toggle + capability.
// ---------------------------------------------------------------------------
function testEventToPostMappingAndOrdering(): void {
  const facts = completedFacts(['https://x/pull/1'])
  const config: TrackerWriteBackConfig = {
    enabled: true,
    comments: { started: true, pr: true, done: true },
    transitions: { onStart: 'ts', onComplete: 'tc' },
  }
  const posts = desiredPostsFor(facts, config, JIRA_CAPS).map((p) => p.postKind)
  assert.deepEqual(posts, [
    'comment:started',
    'transition:onStart',
    'comment:pr',
    'comment:done',
    'transition:onComplete',
  ])

  // With no PR observed, the PR comment drops out.
  const noPr = desiredPostsFor(startedFacts(), config, JIRA_CAPS).map((p) => p.postKind)
  assert.deepEqual(noPr, ['comment:started', 'transition:onStart'])

  // Disabled master ⇒ still produces posts here (gating on `enabled` happens in
  // reconcile, not in desiredPostsFor), but every comment toggle off ⇒ none.
  const commentsOff = desiredPostsFor(facts, { ...config, comments: { started: false, pr: false, done: false } }, JIRA_CAPS)
  assert.deepEqual(commentsOff.map((p) => p.postKind), ['transition:onStart', 'transition:onComplete'])
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function buildEngine(input: {
  facts: RunWriteBackFacts
  items: RunProxyItem[]
  configs: Record<string, TrackerWriteBackConfig>
  caps: Partial<Record<TrackerProviderId, TrackerCapabilities>>
  poster: ReturnType<typeof recordingPoster>
}): TrackerWriteBackEngine {
  return new TrackerWriteBackEngine({
    runState: mutableRunState(input.facts),
    proxyItems: proxyLookup(input.items),
    config: configReader(input.configs),
    capabilities: capabilityResolver(input.caps),
    poster: input.poster,
    ledger: new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter }),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  })
}

function run(): { statePath: string; workspaceRoot: string } {
  return { statePath: '/ws/.multi-code/sprintengine/team/run.yaml', workspaceRoot: '/ws' }
}

function startedFacts(): RunWriteBackFacts {
  return { runId: 'team:abc123', goal: 'Ship the thing', started: true, completed: false, canceled: false, pullRequestUrls: [], taskCount: 3 }
}
function withPullRequest(facts: RunWriteBackFacts, url: string): RunWriteBackFacts {
  return { ...facts, pullRequestUrls: [url] }
}
function completedFacts(prs: string[]): RunWriteBackFacts {
  return { runId: 'team:abc123', goal: 'Ship the thing', started: true, completed: true, canceled: false, pullRequestUrls: prs, taskCount: 3 }
}
function startedKey(): string {
  return 'team:abc123|comment:started|o/r#7'
}

function allCommentsOn(): TrackerWriteBackConfig {
  return { ...DEFAULT_TRACKER_WRITEBACK_CONFIG, enabled: true }
}

function githubItem(): RunProxyItem {
  return { relativePath: 'backlog/gh.md', provider: 'github', connectionId: 'conn-gh', externalId: 'o/r#7', nativeKey: '#7' }
}
function jiraItem(): RunProxyItem {
  return { relativePath: 'backlog/jira.md', provider: 'jira', connectionId: 'conn-jira', externalId: '10023', nativeKey: 'PROJ-17' }
}
function linearItem(): RunProxyItem {
  return { relativePath: 'backlog/lin.md', provider: 'linear', connectionId: 'conn-linear', externalId: 'uuid-1', nativeKey: 'ENG-1' }
}

function mutableRunState(initial: RunWriteBackFacts | null): RunStateReader & { set(facts: RunWriteBackFacts | null): void } {
  let facts = initial
  return {
    set: (next) => {
      facts = next
    },
    readRunFacts: async () => facts,
  }
}

function proxyLookup(items: RunProxyItem[]): ProxyItemLookup {
  return { proxyItemsForRun: async () => items }
}

function configReader(initial: Record<string, TrackerWriteBackConfig>): WriteBackConfigReader & { set(id: string, c: TrackerWriteBackConfig): void } {
  const map = new Map(Object.entries(initial))
  return {
    set: (id, c) => map.set(id, c),
    get: async (id) => map.get(id) ?? { ...DEFAULT_TRACKER_WRITEBACK_CONFIG },
    anyActive: async () => [...map.values()].some((c) => c.enabled),
  }
}

function capabilityResolver(caps: Partial<Record<TrackerProviderId, TrackerCapabilities>>): WriteBackCapabilityResolver {
  return { capabilitiesFor: (provider) => caps[provider] }
}

function recordingPoster(): TrackerWriteBackPoster & {
  comments: Array<{ provider: TrackerProviderId; connectionId: string; externalId: string; body: string }>
  transitions: Array<{ provider: TrackerProviderId; connectionId: string; externalId: string; transitionId: string }>
  failNextComment: boolean
} {
  const poster = {
    comments: [] as Array<{ provider: TrackerProviderId; connectionId: string; externalId: string; body: string }>,
    transitions: [] as Array<{ provider: TrackerProviderId; connectionId: string; externalId: string; transitionId: string }>,
    failNextComment: false,
    async postComment(input: { provider: TrackerProviderId; connectionId: string; externalId: string; body: string }) {
      if (poster.failNextComment) throw new Error('tracker rejected the comment')
      poster.comments.push(input)
    },
    async transitionIssue(input: { provider: TrackerProviderId; connectionId: string; externalId: string; transitionId: string }) {
      poster.transitions.push(input)
    },
  }
  return poster
}

function memoryFs(): { files: Map<string, string>; adapter: { mkdir: any; readFile: any; writeFile: any; rename: any } } {
  const files = new Map<string, string>()
  return {
    files,
    adapter: {
      mkdir: async () => undefined,
      readFile: async (path: string) => {
        if (!files.has(path)) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return files.get(path) as string
      },
      writeFile: async (path: string, data: string) => {
        files.set(path, typeof data === 'string' ? data : String(data))
      },
      rename: async (from: string, to: string) => {
        const value = files.get(from)
        if (value === undefined) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        files.set(to, value)
        files.delete(from)
      },
    },
  }
}

void main()
