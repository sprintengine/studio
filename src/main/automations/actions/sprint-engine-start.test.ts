import assert from 'node:assert/strict'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../../../shared/automation'
import type { ActionContext } from '../../../shared/automations/contracts'
import {
  SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID,
  SPRINT_ENGINE_START_ACTION_KIND,
  createSprintEngineStartActionProvider,
  type SprintEngineStartActionDeps,
} from './sprint-engine'

// Declared before main() is invoked: the bundle downlevels `const` to `var`,
// so a constant defined below the entry call would read as undefined inside
// main's synchronous prologue instead of throwing.
const WORKSPACE_ROOT = '/repo'

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertStartDelegatesPlanSourcedCreationOnRefreshedBase()
  await assertNonWorktreeStartSkipsFetchAndStartPoint()
  await assertBaseRefreshFailurePropagatesAsRunFailure()
  await assertLegacyTeamConfigKeyStillStaffsTheRoster()
  await assertWatchedTeamRidesAsSelfTriggerGuard()
  await assertInvalidConfigsAreRefused()
  await assertRendererRefusalFailsTheRun()
  await assertMissingIntegrationBlocks()
}

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    automationId: 'chain',
    runId: 'run-1',
    workspaceRoot: WORKSPACE_ROOT,
    triggerPayload: {},
    spawnAgent: async () => {
      throw new Error('sprint-engine-start never spawns an automation agent')
    },
    runCommand: async () => {
      throw new Error('not used')
    },
    reportProgress: () => undefined,
    requireIntegration: () => undefined,
    ...overrides,
  }
}

function harness(overrides: Partial<SprintEngineStartActionDeps> & {
  respond?: AutomationRendererResponse
} = {}) {
  const requests: AutomationRendererRequest[] = []
  const provider = createSprintEngineStartActionProvider({
    delegateToRenderer: async (request) => {
      requests.push(request)
      return overrides.respond ?? { ok: true, workspaceId: 'ws-chained' }
    },
    resolveBaseStartPoint: overrides.resolveBaseStartPoint ?? (async () => 'origin/main'),
  })
  assert.equal(provider.kind, SPRINT_ENGINE_START_ACTION_KIND)
  return { provider, requests }
}

async function assertStartDelegatesPlanSourcedCreationOnRefreshedBase(): Promise<void> {
  const fetched: string[] = []
  const { provider, requests } = harness({
    resolveBaseStartPoint: async (workspaceRoot) => {
      fetched.push(workspaceRoot)
      return 'origin/main'
    },
  })

  const result = await provider.run(
    { backlogItem: 'backlog/2026-07-02-next-item.md', roster: 'Core Roster', sprintName: 'Next Sprint' },
    context(),
  )

  assert.equal(result.status, 'completed', 'the automation run finalizes completed at successful launch')
  assert.equal(result.workspaceId, 'ws-chained')
  assert.deepEqual(fetched, [WORKSPACE_ROOT], 'a worktree chain fetches before resolving the start point')
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.kind, 'sprint.create')
  if (request.kind !== 'sprint.create') return
  assert.equal(request.folderPath, WORKSPACE_ROOT)
  assert.equal(request.sourceRelativePath, 'backlog/2026-07-02-next-item.md')
  assert.equal(request.rosterName, 'Core Roster')
  assert.equal(request.name, 'Next Sprint')
  assert.equal(request.useWorktrees, true, 'worktree mode is the default')
  assert.equal(request.startRunner, true, 'a chained sprint starts its runner')
  assert.equal(request.baseStartPoint, 'origin/main', 'the chained run bases on the refreshed remote base')
}

// SEAM (MC-1874): automation configs are persisted per workspace with no
// normalizer to migrate through, so `sprint-engine-start` is the ONE place the
// pre-rename `team` spelling is still read. A user's saved chain automation
// must keep staffing the roster it named — and the new `roster` key must win
// when both are present, so a rewritten config is never overridden by a stale
// one. This is the only legacy read left; if it disappears, so does this test.
async function assertLegacyTeamConfigKeyStillStaffsTheRoster(): Promise<void> {
  const legacy = harness()
  await legacy.provider.run(
    { backlogItem: 'backlog/item.md', team: 'Core Roster' },
    context(),
  )
  const legacyRequest = legacy.requests[0]
  if (legacyRequest.kind !== 'sprint.create') return assert.fail('expected sprint.create')
  assert.equal(
    legacyRequest.rosterName,
    'Core Roster',
    'a pre-rename automation config still staffs the roster it named',
  )

  const both = harness()
  await both.provider.run(
    { backlogItem: 'backlog/item.md', roster: 'New Roster', team: 'Stale Roster' },
    context(),
  )
  const bothRequest = both.requests[0]
  if (bothRequest.kind !== 'sprint.create') return assert.fail('expected sprint.create')
  assert.equal(bothRequest.rosterName, 'New Roster', 'the new key wins over the legacy one')
}

async function assertNonWorktreeStartSkipsFetchAndStartPoint(): Promise<void> {
  const { provider, requests } = harness({
    resolveBaseStartPoint: async () => {
      throw new Error('a non-worktree chain must not fetch — v1 never mutates the checkout')
    },
  })
  const result = await provider.run(
    { backlogItem: 'backlog/item.md', useWorktrees: false },
    context(),
  )
  assert.equal(result.status, 'completed')
  const request = requests[0]
  if (request.kind !== 'sprint.create') return assert.fail('expected sprint.create')
  assert.equal(request.useWorktrees, false)
  assert.equal(request.baseStartPoint, undefined, 'no start point without a worktree')
}

// A failed base refresh must fail the run (the executor maps the throw to a
// failed record) — silently proceeding would chain the sprint onto a stale
// base, the exact defect the start-point plumbing exists to prevent.
async function assertBaseRefreshFailurePropagatesAsRunFailure(): Promise<void> {
  const { provider, requests } = harness({
    resolveBaseStartPoint: async () => {
      throw new Error('Could not refresh "origin" before starting the chained sprint.')
    },
  })
  await assert.rejects(
    provider.run({ backlogItem: 'backlog/item.md' }, context()),
    /Could not refresh "origin"/u,
  )
  assert.equal(requests.length, 0, 'a failed base refresh never reaches the renderer')
}

async function assertWatchedTeamRidesAsSelfTriggerGuard(): Promise<void> {
  const { provider, requests } = harness({})
  await provider.run(
    { backlogItem: 'backlog/item.md' },
    context({ triggerPayload: { kind: 'sprint-engine.run-landed', team: 'team-a' } }),
  )
  const request = requests[0]
  if (request.kind !== 'sprint.create') return assert.fail('expected sprint.create')
  assert.equal(request.refuseTeamSlug, 'team-a', 'the watched team rides along so the renderer can refuse a self-loop')
}

async function assertInvalidConfigsAreRefused(): Promise<void> {
  const { provider, requests } = harness({})
  const refused: Array<{ config: unknown; reason: RegExp }> = [
    { config: {}, reason: /requires a backlog item/u },
    { config: { backlogItem: '/abs/backlog/item.md' }, reason: /project-relative/u },
    { config: { backlogItem: 'backlog/../secrets.md' }, reason: /project-relative/u },
    { config: { backlogItem: 'docs/plan.md' }, reason: /under backlog\//u },
    { config: { backlogItem: 'backlog/epics/big-epic.md' }, reason: /cannot chain from an epic/u },
    { config: { backlogItem: 'backlog/item.md', useWorktrees: 'yes' }, reason: /useWorktrees must be a boolean/u },
  ]
  for (const { config, reason } of refused) {
    // The executor maps a thrown config error to a failed run; asserting the
    // throw keeps this test independent of executor wiring.
    await assert.rejects(provider.run(config, context()), reason)
  }
  assert.equal(requests.length, 0, 'an invalid config never reaches the renderer')
}

async function assertRendererRefusalFailsTheRun(): Promise<void> {
  const { provider } = harness({
    respond: { ok: false, code: 'sprint_self_trigger', message: 'Chained sprint would reuse the watched team directory.' },
  })
  const result = await provider.run({ backlogItem: 'backlog/item.md' }, context())
  assert.equal(result.status, 'failed')
  assert.match(result.summary ?? '', /watched team directory/u)
}

async function assertMissingIntegrationBlocks(): Promise<void> {
  const { provider, requests } = harness({})
  await assert.rejects(
    provider.run(
      { backlogItem: 'backlog/item.md' },
      context({
        requireIntegration: (id) => {
          assert.equal(id, SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID)
          throw new Error(`Required integration is unavailable or unverified: ${id}`)
        },
      }),
    ),
    /Required integration is unavailable/u,
  )
  assert.equal(requests.length, 0)
}
