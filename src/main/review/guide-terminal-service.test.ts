import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalSessionSnapshot, TerminalSpawnResult } from '../../shared/electron-api'
import type { TerminalSpawnPayload } from '../ipc/terminal-ipc'
import type { BriefRunEvent } from './brief-run-service'
import { createAgentControlPlane } from '../agent-control-plane'
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
// The project's Reviews host, where the guide's terminal belongs (MC-1911), and
// the standard workspace it used to land in.
const HOST_WORKSPACE_ID = 'ws-reviews-app'
const WORKSPACE_ID = 'ws-app'
const AGENT_ID = reviewGuideAgentId(REVIEW_ID)
// A pty id of the shape the service now mints: a UUID, because a Claude-harness
// CLI is launched with `--session-id <it>`. Deliberately NOT the agent id.
const PTY_ID = '11111111-2222-4333-8444-555555555555'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

const HOST_WORKSPACES = [
  { id: HOST_WORKSPACE_ID, folderPath: PROJECT_ROOT, mode: 'reviews-host' },
  { id: WORKSPACE_ID, folderPath: PROJECT_ROOT, mode: 'standard' },
]

function agentSession(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    sessionId: PTY_ID,
    processAlive: true,
    kind: 'agent',
    workspaceId: HOST_WORKSPACE_ID,
    agentId: AGENT_ID,
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
    fileChanges: [],
    activeSubagents: 0,
    contextUsage: null,
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
  let nextSpawn: TerminalSpawnResult = { ok: true, sessionId: PTY_ID }
  // `delay: async () => {}` so the paste-submit gap does not make tests sleep.
  const controlPlane = createAgentControlPlane({
    terminal: {
      list: () => sessions,
      write: (sessionId, data) => writes.push({ sessionId, data }),
      read: (sessionId) =>
        sessions.some((session) => session.sessionId === sessionId) ? '' : undefined,
    },
    delay: async () => {},
  })

  const service = createReviewGuideTerminalService({
    listWorkspaces: () => options.workspaces ?? HOST_WORKSPACES,
    terminal: {
      list: () => sessions,
      spawn: async (payload) => {
        spawns.push(payload)
        if (nextSpawn.ok) {
          sessions.push(agentSession({
            sessionId: payload.sessionId,
            ...(payload.agentId ? { agentId: payload.agentId } : {}),
            ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
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
      // The guide delivers prompts through the REAL control plane (MC-102) over
      // this fake terminal, so these tests keep asserting the bytes that reach a
      // pty while proving the guide owns no write path of its own.
      sendPrompt: async (sessionId, text) => {
        const result = await controlPlane.send({ sessionId }, text, { submit: true })
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      },
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

// The pty id a spawn actually minted. Read from the spawn rather than assumed:
// session ids are per-spawn now, so nothing outside the service knows one until
// it has been handed out.
function ptyIdOf(harness: Harness, index = 0): string {
  const sessionId = harness.spawns[index]?.sessionId
  assert.ok(sessionId, 'the spawn named a terminal session')
  return sessionId
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

run('a start spawns the guide in the project Reviews host, with the skill attached', async () => {
  const harness = makeHarness()
  const result = await harness.service.startRun(startInput())

  assert.ok(result.ok && !('joined' in result), 'the start reports a fresh guide')
  assert.deepEqual(result.ok && !('joined' in result) ? result.guide : null, {
    workspaceId: HOST_WORKSPACE_ID,
    agentId: AGENT_ID,
    sessionId: ptyIdOf(harness),
    cli: 'claude-code',
  })
  assert.equal(harness.spawns.length, 1)
  const spawn = harness.spawns[0]
  assert.equal(spawn.agentId, AGENT_ID, 'the agent id is stable per review, so a tab can reattach')
  assert.notEqual(spawn.sessionId, AGENT_ID, 'the pty id is NOT the agent id')
  assert.match(
    spawn.sessionId,
    UUID,
    'a Claude-harness CLI is launched with --session-id <it> and rejects anything but a UUID'
  )
  assert.equal(spawn.workspaceId, HOST_WORKSPACE_ID, 'the guide runs in the Reviews host, not among the project agents')
  assert.equal(spawn.cwd, PROJECT_ROOT, 'and still with the project as its cwd — it reads the change')
  assert.equal(spawn.kind, 'agent')
  assert.equal(spawn.agentName, 'Review guide')
  assert.equal(spawn.spawnSkillId, REVIEW_GUIDE_SKILL_ID)
  assert.ok(
    spawn.agentSession?.executionId.startsWith(`${AGENT_ID}#`),
    'a per-pty execution identity is what reports the exit'
  )
  // Run coordinates only: the craft lives in the skill.
  assert.ok(spawn.initialPrompt?.startsWith('/review-guide'), 'the CLI-native skill invocation leads')
  assert.ok(spawn.initialPrompt?.includes(`Review: ${REVIEW_ID}`))
  assert.ok(spawn.initialPrompt?.includes(`Project root: ${PROJECT_ROOT}`))
  assert.ok(spawn.initialPrompt?.includes('Depth: standard'))

  assert.equal(harness.registry.status(REVIEW_ID)?.running, true)
  assert.deepEqual(harness.events.map((event) => event.phase), ['reading', 'grouping'])
  assert.deepEqual(harness.reapExempt, [{ sessionId: ptyIdOf(harness), exempt: true }])
})

// The bug this identity split fixes (MC-1911): the guide's terminal key used to
// be `review-guide-<reviewId>`, which the plugin manifest renders straight into
// `--session-id` for every CLI declaring `sessionIdFromCaller`. Claude rejects a
// non-UUID id and exits, so the guide had never once run under claude-code,
// zai, kimi-claude, or grok — the reviewer got a bare shell prompt.
run('every spawn mints its own UUID rather than reusing a dead one', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  const first = ptyIdOf(harness)
  // The terminal died; the next start is a fresh launch, not a resume.
  harness.sessions.length = 0
  await harness.service.startRun(startInput())
  const second = ptyIdOf(harness, 1)

  assert.match(second, UUID)
  assert.notEqual(second, first, 'a CLI refuses a --session-id it has already consumed')
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

// Item 1807. A sprint-run workspace is rail-hidden (item 1767): the guide's tab
// would land in a sprint run's layout with no Projects row leading back to it.
run('a project open only as a sprint-run workspace is not somewhere the guide may spawn', async () => {
  const harness = makeHarness({
    workspaces: [{ id: 'ws-sprint', folderPath: PROJECT_ROOT, mode: 'sprintengine' }],
  })
  const result = await harness.service.startRun(startInput())

  assert.deepEqual(result, { ok: false, error: 'Open the project to run the guide.' })
  assert.equal(harness.spawns.length, 0, 'no guide tab is seeded into the sprint run')
})

// MC-1911. The reviewer's own workspace is not where a review guide belongs:
// its tab used to appear among their agents in whatever project was open.
run('the Reviews host outranks the project workspace, which stays the fallback', async () => {
  const hosted = makeHarness()
  await hosted.service.startRun(startInput())
  assert.equal(hosted.spawns[0].workspaceId, HOST_WORKSPACE_ID)

  // No host yet (a caller that predates one): the guide still runs, in the
  // standard workspace it always used, rather than refusing.
  const legacy = makeHarness({
    workspaces: [
      { id: 'ws-sprint', folderPath: PROJECT_ROOT, mode: 'sprintengine' },
      { id: WORKSPACE_ID, folderPath: PROJECT_ROOT, mode: 'standard' },
    ],
  })
  await legacy.service.startRun(startInput())
  assert.equal(legacy.spawns[0].workspaceId, WORKSPACE_ID)

  // Rail-visible but not standard (a review workspace on the same folder) is
  // still a workspace the reviewer can navigate back to, so it remains the
  // fallback the guide has always had.
  const fallback = makeHarness({
    workspaces: [
      { id: 'ws-automations', folderPath: PROJECT_ROOT, mode: 'automations-host' },
      { id: 'ws-review', folderPath: PROJECT_ROOT, mode: 'review' },
    ],
  })
  await fallback.service.startRun(startInput())
  assert.equal(fallback.spawns[0].workspaceId, 'ws-review')
})

// The renderer mints the host immediately before starting, so requiring it in
// this process's workspace-sync snapshot would lose a race it need not run.
run('a caller-named Reviews host is used before the snapshot has heard of it', async () => {
  const harness = makeHarness({
    workspaces: [{ id: WORKSPACE_ID, folderPath: PROJECT_ROOT, mode: 'standard' }],
  })
  await harness.service.startRun(startInput({ hostWorkspaceId: 'ws-reviews-fresh' }))
  assert.equal(harness.spawns[0].workspaceId, 'ws-reviews-fresh')
  assert.equal(harness.spawns[0].cli, 'claude-code')
})

run('a spawn failure fails the run and leaves no in-flight record behind', async () => {
  const harness = makeHarness()
  harness.spawnResult({ ok: false, sessionId: PTY_ID, message: 'claude was not found.', exitCode: 1 })
  const result = await harness.service.startRun(startInput())

  assert.deepEqual(result, { ok: false, error: 'claude was not found.' })
  assert.equal(harness.registry.status(REVIEW_ID)?.running, false)
  const failures = harness.events.filter((event) => event.phase === 'failed')
  assert.equal(failures.length, 1)

  // The failed launch's pty exit must not report a second failure.
  harness.exit({ agentId: AGENT_ID, executionId: executionIdOf(harness), exitCode: 1 })
  assert.equal(harness.events.filter((event) => event.phase === 'failed').length, 1)
})

run('a guide terminal that ends without a brief fails the run', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  harness.exit({ agentId: AGENT_ID, executionId: executionIdOf(harness), exitCode: 0 })

  const status = harness.registry.status(REVIEW_ID)
  assert.equal(status?.running, false)
  assert.equal(status?.phase, 'failed')
  assert.equal(
    status?.detail,
    'The guide session ended without delivering a walkthrough — its terminal has the details.'
  )
  assert.deepEqual(harness.reapExempt.at(-1), { sessionId: ptyIdOf(harness), exempt: false })
})

run('a delivered brief closes the run, so the terminal exiting afterwards says nothing', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  // What the Studio gateway does when review_submit_brief lands.
  recordGuideRunEvent({ workspaceId: REVIEW_ID, phase: 'done' }, harness.registry)
  harness.exit({ agentId: AGENT_ID, executionId: executionIdOf(harness), exitCode: 0 })

  const status = harness.registry.status(REVIEW_ID)
  assert.equal(status?.phase, 'done', 'the delivered brief is still the outcome of record')
  assert.equal(harness.events.filter((event) => event.phase === 'failed').length, 0)
})

// Item 1806. The run took the terminal out of the idle reaper's reach; a brief
// that lands is where it gives it back. Without this the reviewer who never
// opens the guide's terminal keeps one unsuspendable agent process per reviewed
// change for the rest of the app session.
run('a brief landing releases the reap exemption, as stop() and a process exit do', async () => {
  const delivered = makeHarness()
  await delivered.service.startRun(startInput())
  assert.deepEqual(delivered.reapExempt, [{ sessionId: ptyIdOf(delivered), exempt: true }])
  // What the Studio gateway's brief sink does when review_submit_brief lands.
  recordGuideRunEvent({ workspaceId: REVIEW_ID, phase: 'done' }, delivered.registry)
  delivered.service.clearReapExempt(REVIEW_ID)
  assert.deepEqual(delivered.reapExempt.at(-1), { sessionId: ptyIdOf(delivered), exempt: false })
  assert.deepEqual(delivered.kills, [], 'the terminal is released, not killed — the reviewer may still read it')

  // The run is over: stopping the terminal afterwards cannot overwrite the
  // delivered outcome with a failure.
  delivered.service.stop(REVIEW_ID)
  assert.equal(delivered.registry.status(REVIEW_ID)?.phase, 'done')

  const stopped = makeHarness()
  await stopped.service.startRun(startInput())
  stopped.service.stop(REVIEW_ID)
  assert.deepEqual(stopped.reapExempt.at(-1), { sessionId: ptyIdOf(stopped), exempt: false })

  const exited = makeHarness()
  await exited.service.startRun(startInput())
  exited.exit({ agentId: AGENT_ID, executionId: executionIdOf(exited), exitCode: 0 })
  assert.deepEqual(exited.reapExempt.at(-1), { sessionId: ptyIdOf(exited), exempt: false })
})

run('stopping the guide kills its terminal and names the reviewer as the reason', async () => {
  const harness = makeHarness()
  await harness.service.startRun(startInput())
  harness.service.stop(REVIEW_ID)

  assert.deepEqual(harness.kills, [ptyIdOf(harness)])
  const status = harness.registry.status(REVIEW_ID)
  assert.equal(status?.running, false)
  assert.equal(status?.detail, 'You stopped the guide.')

  // The kill's own exit event must not overwrite that with the watchdog message.
  harness.exit({ agentId: AGENT_ID, executionId: executionIdOf(harness), exitCode: 0 })
  assert.equal(harness.registry.status(REVIEW_ID)?.detail, 'You stopped the guide.')
})

run('a dead session under the guide id is disposed before a fresh spawn', async () => {
  const replaced = agentSession({
    processAlive: false,
    activity: { kind: 'exited', at: 2, exitCode: 0 },
    agentSession: {
      sessionId: PTY_ID,
      executionId: 'old-execution',
      system: 'manual',
      workspaceId: WORKSPACE_ID,
      workspaceRoot: PROJECT_ROOT,
      workId: AGENT_ID,
      role: 'review-guide',
      displayName: 'Review guide',
    },
  })
  const harness = makeHarness({ sessions: [replaced] })
  const result = await harness.service.startRun(startInput())

  assert.ok(result.ok)
  assert.deepEqual(
    harness.kills,
    [PTY_ID],
    'the retained record is disposed, so the guide is not listed twice'
  )
  assert.equal(harness.spawns.length, 1)
  // Disposing the dead pty fires its exit AFTER the replacement started. The run
  // that just began must survive it — that is what execution ids are for.
  harness.exit({ agentId: AGENT_ID, executionId: 'old-execution', exitCode: 0 })
  assert.equal(harness.registry.status(REVIEW_ID)?.running, true, 'the replaced terminal cannot fail its successor')
  harness.exit({ agentId: AGENT_ID, executionId: executionIdOf(harness), exitCode: 0 })
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
  assert.equal(asked.ok ? asked.guide.sessionId : null, ptyIdOf(harness))
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
const skillPath = join(process.cwd(), 'resources', 'studio-plugin', 'studio-skills', 'skills', REVIEW_GUIDE_SKILL_ID, 'SKILL.md')

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
