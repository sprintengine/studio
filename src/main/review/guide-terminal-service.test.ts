import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalSessionSnapshot, TerminalSpawnResult } from '../../shared/electron-api'
import type { TerminalSpawnPayload } from '../ipc/terminal-ipc'
import type { BriefRunEvent } from './brief-run-service'
import { GuideRunRegistry } from './guide-run-registry'
import {
  createReviewGuideTerminalService,
  recordGuideRunEvent,
  reviewGuideAgentId,
  REVIEW_GUIDE_SKILL_ID,
  type GuideAgentExit,
  type ReviewGuideTerminalService,
} from './guide-terminal-service'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const REVIEW_ID = 'review_1'
const PROJECT_ROOT = '/projects/app'
const WORKSPACE_ID = 'ws-app'
const SESSION_ID = reviewGuideAgentId(REVIEW_ID)

function agentSession(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    sessionId: SESSION_ID,
    processAlive: true,
    kind: 'agent',
    workspaceId: WORKSPACE_ID,
    agentId: SESSION_ID,
    cli: 'claude-code',
    visible: false,
    suspended: false,
    reapExempt: false,
    startedAt: 1,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    activity: { kind: 'idle', since: 1 },
    ...overrides,
  }
}

type Harness = {
  service: ReviewGuideTerminalService
  registry: GuideRunRegistry
  events: BriefRunEvent[]
  spawns: TerminalSpawnPayload[]
  writes: Array<{ sessionId: string; data: string }>
  kills: string[]
  reapExempt: Array<{ sessionId: string; exempt: boolean }>
  sessions: TerminalSessionSnapshot[]
  exit: (event: GuideAgentExit) => void
  spawnResult: (result: TerminalSpawnResult) => void
}

function makeHarness(
  options: {
    sessions?: TerminalSessionSnapshot[]
    workspaces?: Array<{ id: string; folderPath?: string; mode?: string }>
    skillInvocation?: (cli: string) => string | undefined
  } = {}
): Harness {
  const registry = new GuideRunRegistry()
  const events: BriefRunEvent[] = []
  const spawns: TerminalSpawnPayload[] = []
  const writes: Array<{ sessionId: string; data: string }> = []
  const kills: string[] = []
  const reapExempt: Array<{ sessionId: string; exempt: boolean }> = []
  const sessions = options.sessions ?? []
  const exitListeners: Array<(event: GuideAgentExit) => void> = []
  let nextSpawn: TerminalSpawnResult = { ok: true, sessionId: SESSION_ID }

  const service = createReviewGuideTerminalService({
    listWorkspaces: () =>
      options.workspaces ?? [{ id: WORKSPACE_ID, folderPath: PROJECT_ROOT, mode: 'standard' }],
    terminal: {
      list: () => sessions,
      spawn: async (payload) => {
        spawns.push(payload)
        if (nextSpawn.ok) {
          sessions.push(agentSession({
            sessionId: payload.sessionId,
            cli: payload.cli,
            // The runtime materializes the spawn's agent identity onto the
            // session; the watchdog correlates on its execution id.
            ...(payload.agentSession
              ? { agentSession: { ...payload.agentSession, sessionId: payload.sessionId } }
              : {}),
          }))
        }
        return nextSpawn
      },
      write: (sessionId, data) => writes.push({ sessionId, data }),
      kill: (sessionId) => {
        kills.push(sessionId)
        const index = sessions.findIndex((session) => session.sessionId === sessionId)
        if (index >= 0) sessions.splice(index, 1)
      },
      setReapExempt: (sessionId, exempt) => reapExempt.push({ sessionId, exempt }),
      onAgentSessionExit: (listener) => {
        exitListeners.push(listener)
        return () => exitListeners.splice(exitListeners.indexOf(listener), 1)
      },
    },
    resolveSkillInvocation: options.skillInvocation ?? (() => '/review-guide'),
    emit: (event) => events.push(event),
    guideRuns: registry,
    delay: async () => {},
  })

  return {
    service,
    registry,
    events,
    spawns,
    writes,
    kills,
    reapExempt,
    sessions,
    exit: (event) => {
      for (const listener of [...exitListeners]) listener(event)
    },
    spawnResult: (result) => {
      nextSpawn = result
    },
  }
}

// The execution id a spawned guide terminal will report its exit under.
function executionIdOf(harness: Harness, index = 0): string {
  const executionId = harness.spawns[index]?.agentSession?.executionId
  assert.ok(executionId, 'the spawn carried an execution identity')
  return executionId
}

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    reviewId: REVIEW_ID,
    projectRoot: PROJECT_ROOT,
    depth: 'standard' as const,
    cli: 'claude-code',
    ...overrides,
  }
}

run('a start spawns the guide in the review project, with the skill attached', async () => {
  const harness = makeHarness()
  const result = await harness.service.startRun(startInput())

  assert.ok(result.ok && !('joined' in result), 'the start reports a fresh guide')
  assert.deepEqual(result.ok && !('joined' in result) ? result.guide : null, {
    workspaceId: WORKSPACE_ID,
    agentId: SESSION_ID,
    sessionId: SESSION_ID,
    cli: 'claude-code',
  })
  assert.equal(harness.spawns.length, 1)
  const spawn = harness.spawns[0]
  assert.equal(spawn.sessionId, SESSION_ID, 'session id equals the agent id, so a tab can reattach')
  assert.equal(spawn.workspaceId, WORKSPACE_ID, 'the guide runs under the review project workspace')
  assert.equal(spawn.cwd, PROJECT_ROOT)
  assert.equal(spawn.kind, 'agent')
  assert.equal(spawn.agentName, 'Review guide')
  assert.equal(spawn.spawnSkillId, REVIEW_GUIDE_SKILL_ID)
  assert.ok(
    spawn.agentSession?.executionId.startsWith(`${SESSION_ID}#`),
    'a per-pty execution identity is what reports the exit'
  )
  // Run coordinates only: the craft lives in the skill.
  assert.ok(spawn.initialPrompt?.startsWith('/review-guide'), 'the CLI-native skill invocation leads')
  assert.ok(spawn.initialPrompt?.includes(`Review: ${REVIEW_ID}`))
  assert.ok(spawn.initialPrompt?.includes(`Project root: ${PROJECT_ROOT}`))
  assert.ok(spawn.initialPrompt?.includes('Depth: standard'))

  assert.equal(harness.registry.status(REVIEW_ID)?.running, true)
  assert.deepEqual(harness.events.map((event) => event.phase), ['reading', 'grouping'])
  assert.deepEqual(harness.reapExempt, [{ sessionId: SESSION_ID, exempt: true }])
})

run('a CLI with no native skill invocation is pointed at the installed skill file', async () => {
  const harness = makeHarness({ skillInvocation: () => undefined })
  await harness.service.startRun(startInput({ cli: 'cursor' }))
  assert.ok(
    harness.spawns[0].initialPrompt?.startsWith(`Read .agents/skills/${REVIEW_GUIDE_SKILL_ID}/SKILL.md`),
    'the prompt names the skill file the spawn just installed'
  )
})

run('a refresh names only the affected steps', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput({ affectedStepIds: ['step-2', 'step-5'] }))
  assert.ok(harness.spawns[0].initialPrompt?.includes('step-2, step-5'))
})

run('a second start joins the live run instead of spawning a second guide', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  const joined = await harness.service.startRun(startInput())

  assert.ok(joined.ok && 'joined' in joined && joined.joined)
  assert.equal(joined.ok && 'joined' in joined ? joined.status.running : null, true)
  assert.equal(harness.spawns.length, 1, 'no second guide was spawned')
  assert.equal(harness.writes.length, 0, 'joining does not re-prompt the guide')
})

run('a restart re-prompts the live guide terminal rather than starting a twin', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  const restarted = await harness.service.startRun(startInput({ restart: true }))

  assert.ok(restarted.ok && !('joined' in restarted) && restarted.reused, 'the live terminal was reused')
  assert.equal(harness.spawns.length, 1)
  assert.equal(harness.writes.length, 2, 'the prompt is pasted, then submitted')
  assert.ok(harness.writes[0].data.includes(`Review: ${REVIEW_ID}`))
  assert.equal(harness.writes[1].data, '\r')
})

run('a run whose registry record outlived its terminal starts fresh instead of joining a ghost', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  // The terminal is gone (app restart, reaped session) but the registry still
  // holds the run: joining it would leave the reviewer watching nothing.
  harness.sessions.length = 0
  const restarted = await harness.service.startRun(startInput())
  assert.ok(restarted.ok && !('joined' in restarted))
  assert.equal(harness.spawns.length, 2)
})

run('a review whose project is not open fails visibly and closes the run', async () => {
  const harness = makeHarness({ workspaces: [] })
  const result = await harness.service.startRun(startInput())

  assert.deepEqual(result, { ok: false, error: 'Open the project to run the guide.' })
  assert.equal(harness.spawns.length, 0)
  const status = harness.registry.status(REVIEW_ID)
  assert.equal(status?.running, false, 'the run reached a terminal phase, so a later start is not stuck joining')
  assert.equal(status?.phase, 'failed')
  assert.equal(status?.detail, 'Open the project to run the guide.')
})

run('a spawn failure fails the run and leaves no in-flight record behind', async () => {
  const harness = makeHarness()
  harness.spawnResult({ ok: false, sessionId: SESSION_ID, message: 'claude was not found.', exitCode: 1 })
  const result = await harness.service.startRun(startInput())

  assert.deepEqual(result, { ok: false, error: 'claude was not found.' })
  assert.equal(harness.registry.status(REVIEW_ID)?.running, false)
  const failures = harness.events.filter((event) => event.phase === 'failed')
  assert.equal(failures.length, 1)

  // The failed launch's pty exit must not report a second failure.
  harness.exit({ agentId: SESSION_ID, executionId: executionIdOf(harness), exitCode: 1 })
  assert.equal(harness.events.filter((event) => event.phase === 'failed').length, 1)
})

run('a guide terminal that ends without a brief fails the run', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  harness.exit({ agentId: SESSION_ID, executionId: executionIdOf(harness), exitCode: 0 })

  const status = harness.registry.status(REVIEW_ID)
  assert.equal(status?.running, false)
  assert.equal(status?.phase, 'failed')
  assert.equal(
    status?.detail,
    'The guide session ended without delivering a walkthrough — its terminal has the details.'
  )
  assert.deepEqual(harness.reapExempt.at(-1), { sessionId: SESSION_ID, exempt: false })
})

run('a delivered brief closes the run, so the terminal exiting afterwards says nothing', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  // What the Studio gateway does when review_submit_brief lands.
  recordGuideRunEvent({ workspaceId: REVIEW_ID, phase: 'done' }, harness.registry)
  harness.exit({ agentId: SESSION_ID, executionId: executionIdOf(harness), exitCode: 0 })

  const status = harness.registry.status(REVIEW_ID)
  assert.equal(status?.phase, 'done', 'the delivered brief is still the outcome of record')
  assert.equal(harness.events.filter((event) => event.phase === 'failed').length, 0)
})

run('stopping the guide kills its terminal and names the reviewer as the reason', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  harness.service.stop(REVIEW_ID)

  assert.deepEqual(harness.kills, [SESSION_ID])
  const status = harness.registry.status(REVIEW_ID)
  assert.equal(status?.running, false)
  assert.equal(status?.detail, 'You stopped the guide.')

  // The kill's own exit event must not overwrite that with the watchdog message.
  harness.exit({ agentId: SESSION_ID, executionId: executionIdOf(harness), exitCode: 0 })
  assert.equal(harness.registry.status(REVIEW_ID)?.detail, 'You stopped the guide.')
})

run('a dead session under the guide id is disposed before a fresh spawn', async () => {
  const replaced = agentSession({
    processAlive: false,
    activity: { kind: 'exited', at: 2, exitCode: 0 },
    agentSession: {
      sessionId: SESSION_ID,
      executionId: 'old-execution',
      system: 'manual',
      workspaceId: WORKSPACE_ID,
      workspaceRoot: PROJECT_ROOT,
      workId: SESSION_ID,
      role: 'review-guide',
      displayName: 'Review guide',
    },
  })
  const harness = makeHarness({ sessions: [replaced] })
  const result = await harness.service.startRun(startInput())

  assert.ok(result.ok)
  assert.deepEqual(harness.kills, [SESSION_ID], 'the retained record is disposed, or the spawn would reattach nothing')
  assert.equal(harness.spawns.length, 1)
  // Disposing the dead pty fires its exit AFTER the replacement started. The run
  // that just began must survive it — that is what execution ids are for.
  harness.exit({ agentId: SESSION_ID, executionId: 'old-execution', exitCode: 0 })
  assert.equal(harness.registry.status(REVIEW_ID)?.running, true, 'the replaced terminal cannot fail its successor')
  harness.exit({ agentId: SESSION_ID, executionId: executionIdOf(harness), exitCode: 0 })
  assert.equal(harness.registry.status(REVIEW_ID)?.phase, 'failed')
})

run('a suspended guide terminal is relaunched rather than pasted into', async () => {
  const harness = makeHarness({ sessions: [agentSession({ processAlive: false, suspended: true })] })
  await harness.service.startRun(startInput())
  assert.equal(harness.writes.length, 0, 'a suspended pty cannot receive a prompt')
  assert.equal(harness.spawns.length, 1)
})

run('asking sends the question to the guide terminal and records no run phase', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  const before = harness.events.length
  const asked = await harness.service.ask({
    reviewId: REVIEW_ID,
    projectRoot: PROJECT_ROOT,
    question: 'Why did the router move?',
    cli: 'claude-code',
  })

  assert.ok(asked.ok)
  assert.equal(asked.ok ? asked.guide.sessionId : null, SESSION_ID)
  assert.ok(harness.writes[0].data.includes('Why did the router move?'))
  assert.ok(harness.writes[0].data.includes(`Review: ${REVIEW_ID}`), 'the question carries its run coordinates')
  assert.equal(harness.events.length, before, 'a question is not a walkthrough run')
  assert.equal(harness.registry.status(REVIEW_ID)?.running, true, 'and it does not disturb one in flight')
})

run('asking with no guide running starts one', async () => {
  const harness = makeHarness()
  const asked = await harness.service.ask({
    reviewId: REVIEW_ID,
    projectRoot: PROJECT_ROOT,
    question: 'What is this change?',
    cli: 'claude-code',
  })
  assert.ok(asked.ok)
  assert.equal(harness.spawns.length, 1)
  assert.equal(harness.registry.status(REVIEW_ID), null, 'still no run: asking produces no walkthrough')
})

run('a start with no CLI anywhere to infer one fails visibly', async () => {
  const harness = makeHarness()
  const result = await harness.service.startRun({
    reviewId: REVIEW_ID,
    projectRoot: PROJECT_ROOT,
    depth: 'standard',
  })
  assert.deepEqual(result, { ok: false, error: 'Choose which agent CLI should run the review guide.' })
  assert.equal(harness.spawns.length, 0)
})

run('a start with no CLI reuses the one the project last ran an agent under', async () => {
  const harness = makeHarness({
    sessions: [agentSession({ sessionId: 'agent-7', agentId: 'agent-7', cli: 'codex', startedAt: 9 })],
  })
  const result = await harness.service.startRun({
    reviewId: REVIEW_ID,
    projectRoot: PROJECT_ROOT,
    depth: 'standard',
  })
  assert.ok(result.ok)
  assert.equal(harness.spawns[0].cli, 'codex')
})

run('an unaddressable review id never reaches the terminal runtime', async () => {
  const harness = makeHarness()
  const result = await harness.service.startRun(startInput({ reviewId: '../escape' }))
  assert.ok(!result.ok)
  assert.equal(harness.spawns.length, 0)
})

// The tests run from the repo root (npm run), so resolve repo files from cwd.
const skillPath = join(process.cwd(), 'resources', 'skills', REVIEW_GUIDE_SKILL_ID, 'SKILL.md')

run('the guide wording lives only in the skill, never in the join prompt', () => {
  const skill = readFileSync(skillPath, 'utf-8')
  const serviceSource = readFileSync(
    join(process.cwd(), 'src', 'main', 'review', 'guide-terminal-service.ts'),
    'utf-8'
  )

  // Sentences that carry the guide's craft and contract. Each must live in the
  // skill and nowhere else: a copy in the spawn prompt is a second source of
  // truth that can drift away from what the skill-driven agent reads.
  const wording = [
    'THE ONE RULE THAT OVERRIDES EVERYTHING',
    'STEPS — group the change for understanding:',
    'ANNOTATIONS — mark the lines worth pausing on:',
    'CHANGE MAP (optional)',
    'Depth: BRIEF.',
    'Depth: STANDARD.',
    'Depth: THOROUGH.',
  ]
  for (const phrase of wording) {
    assert.ok(skill.includes(phrase), `the skill carries the canonical wording: ${phrase}`)
    assert.ok(!serviceSource.includes(phrase), `the guide terminal service must not re-state: ${phrase}`)
  }
})

async function main(): Promise<void> {
  let failed = false
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed) process.exit(1)
  console.log('guide-terminal-service.test.ts: ok')
}

void main()
