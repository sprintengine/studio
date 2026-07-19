import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewBrief, ReviewChangeSet } from '../../shared/review'
import type { ReviewChangeSetReadResult } from '../../shared/electron-api'
import {
  CompanionValidationError,
  type CompanionAgentHandle,
  type CompanionAgentService,
  type CompanionRunStructuredOptions,
} from '../companion-agent-service'
import { GUIDE_SYSTEM_PROMPT, REVIEW_BRIEF_SCHEMA_DOC } from './guide-prompt'
import {
  ReviewBriefRunService,
  type BriefRunEvent,
  type ReviewBriefRunServiceDeps,
} from './brief-run-service'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const tempDirs: string[] = []
function makeWorkspaceRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brief-run-'))
  tempDirs.push(dir)
  return dir
}

const WORKSPACE_ID = 'ws_test'

// A fixture changeset: two non-binary files with hunks, so anchors have a real
// line extent to sit inside. Hand-built (checkBriefMatchesChangeSet assumes the
// changeset already passed its own validator).
function fixtureChangeSet(): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id: 'cs_fixture',
    source: { kind: 'patch', label: 'fixture' },
    title: 'fixture',
    baseRef: '(patch)',
    headSha: 'abc123def456',
    files: [
      {
        path: 'src/store.ts',
        status: 'modified',
        binary: false,
        additions: 3,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 5,
            lines: [
              { kind: 'context', text: 'export const store = {' },
              { kind: 'add', text: '  next: 1,' },
              { kind: 'context', text: '}' },
            ],
          },
        ],
      },
      {
        path: 'src/view.tsx',
        status: 'added',
        binary: false,
        additions: 2,
        deletions: 0,
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: 'add', text: 'export const View = () => null' },
              { kind: 'add', text: '' },
            ],
          },
        ],
      },
    ],
    stats: { files: 2, additions: 5, deletions: 1 },
    fetchedAt: '2026-07-18T00:00:00Z',
  }
}

function validBrief(): ReviewBrief {
  return {
    schemaVersion: 1,
    changeSetId: 'cs_fixture',
    headSha: 'abc123def456',
    generatedAt: '2026-07-18T00:00:00Z',
    overview: {
      intent: 'Add a next counter to the store and a view that reads it.',
      blastRadius: 'Touches the store shape and one new view component.',
      readingGuide: 'Read the store first, then the view that consumes it.',
      complexity: 'low',
    },
    steps: [
      {
        id: 'step-store',
        order: 0,
        title: 'Store foundation',
        narrative: 'The store gains a next field; the view later reads it.',
        files: [{ path: 'src/store.ts', why: 'introduces the next field', readingNote: 'read-closely' }],
        annotations: [
          {
            id: 'ann-1',
            path: 'src/store.ts',
            anchor: { side: 'new', startLine: 1, endLine: 2 },
            kind: 'explain',
            title: 'New field',
            summary: 'The store now carries a next counter.',
            hoverTip: 'This is where the counter enters the store shape.',
          },
        ],
      },
      {
        id: 'step-view',
        order: 1,
        title: 'View surface',
        narrative: 'A new component renders against the store.',
        files: [{ path: 'src/view.tsx', why: 'new component consuming the store', readingNote: 'mechanical-skim' }],
        annotations: [],
      },
    ],
    knowledgeRefs: [{ note: 'multicode/conversation-agents', reason: 'the guide runs on the companion surface' }],
    coverage: { assignedPaths: ['src/store.ts', 'src/view.tsx'], unassignedPaths: [] },
  }
}

// A brief that drops a changed file from every step and from unassignedPaths —
// checkBriefMatchesChangeSet rejects the silent drop.
function coverageGapBrief(): ReviewBrief {
  const brief = validBrief()
  brief.steps = [brief.steps[0]]
  brief.coverage = { assignedPaths: ['src/store.ts'], unassignedPaths: [] }
  return brief
}

// A brief whose annotation carries a severity-like kind. validateReviewBrief's
// enum check rejects it (kinds are explanation-only), so no verdict slips in.
function severityKindBrief(): unknown {
  const brief = validBrief() as unknown as { steps: Array<{ annotations: Array<{ kind: string }> }> }
  brief.steps[0].annotations[0].kind = 'critical'
  return brief
}

// A brief that leaks an absolute home-directory path.
function homePathBrief(): ReviewBrief {
  const brief = validBrief()
  brief.overview.blastRadius = `Touches files under ${homedir()}/secret.`
  return brief
}

// A companion service stub whose runStructured replays scripted raw outputs
// through the caller's real validate fn, mirroring the companion's retry
// contract (attempt 0 + `retries` more). This exercises the service's validator
// wiring, persistence, and failure handling without a live agent.
type StubOptions = {
  scripted: Map<string, unknown[]>
  // When set for a workspace, runStructured hangs until the handle is
  // interrupted, then rejects — used to test interrupt behavior.
  hangUntilInterrupt?: Set<string>
  // When provided, each run's prompt is pushed here so a test can assert the
  // incremental-re-run prompt was chosen.
  capturedPrompts?: string[]
}

function makeStubCompanion(opts: StubOptions): {
  service: Pick<CompanionAgentService, 'attach'>
  attachedWorkspaces: string[]
} {
  const attachedWorkspaces: string[] = []
  const service: Pick<CompanionAgentService, 'attach'> = {
    attach(spec) {
      attachedWorkspaces.push(spec.workspaceId)
      const outputs = [...(opts.scripted.get(spec.workspaceId) ?? [])]
      let rejectHang: ((reason: unknown) => void) | null = null
      const handle: CompanionAgentHandle = {
        workspaceId: spec.workspaceId,
        agentId: spec.agentId,
        status: () => 'ready',
        onStatus: (cb) => {
          cb('ready')
          return () => {}
        },
        onEvent: () => () => {},
        send: async () => {},
        interrupt: () => {
          if (rejectHang) {
            rejectHang(new Error('interrupted'))
            rejectHang = null
          }
        },
        dispose: () => {},
        async runStructured<T>(runOpts: CompanionRunStructuredOptions<T>): Promise<T> {
          opts.capturedPrompts?.push(runOpts.prompt)
          if (opts.hangUntilInterrupt?.has(spec.workspaceId)) {
            runOpts.onPhase?.('running')
            await new Promise<never>((_resolve, reject) => {
              rejectHang = reject
            })
          }
          const maxRetries = Math.max(0, runOpts.retries ?? 1)
          let lastErrors: string[] = ['No scripted output.']
          for (let attempt = 0; ; attempt += 1) {
            runOpts.onPhase?.(attempt === 0 ? 'running' : 'retrying')
            const raw = outputs.shift()
            runOpts.onPhase?.('validating')
            if (raw !== undefined) {
              const result = runOpts.validate(raw)
              if (result.ok) return result.value
              lastErrors = result.errors.length > 0 ? result.errors : ['Validation failed.']
            } else {
              lastErrors = ['No scripted output.']
            }
            if (attempt >= maxRetries) throw new CompanionValidationError(lastErrors)
          }
        },
      }
      return handle
    },
  }
  return { service, attachedWorkspaces }
}

function makeDeps(
  companion: Pick<CompanionAgentService, 'attach'>,
  changeset: ReviewChangeSet | null,
  events: BriefRunEvent[]
): ReviewBriefRunServiceDeps {
  return {
    companionAgents: companion,
    changeSets: {
      read: async (): Promise<ReviewChangeSetReadResult> => ({ ok: true, changeset }),
    },
    emit: (event) => events.push(event),
  }
}

function briefPath(root: string): string {
  return join(root, '.multi-code', 'review', WORKSPACE_ID, 'brief.json')
}

run('valid brief -> persisted + done', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []
  const { service } = makeStubCompanion({ scripted: new Map([[WORKSPACE_ID, [validBrief()]]]) })
  const svc = new ReviewBriefRunService(makeDeps(service, fixtureChangeSet(), events))

  const result = await svc.start({ workspaceId: WORKSPACE_ID, workspaceRoot: root, depth: 'standard' })

  assert.equal(result.ok, true)
  assert.ok(existsSync(briefPath(root)), 'brief.json persisted')
  const onDisk = JSON.parse(readFileSync(briefPath(root), 'utf-8'))
  assert.equal(onDisk.changeSetId, 'cs_fixture')
  const phases = events.map((e) => e.phase)
  assert.deepEqual(
    phases.filter((p) => p === 'reading' || p === 'writing' || p === 'done'),
    ['reading', 'writing', 'done']
  )
})

run('invalid then valid -> one retry, persisted', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []
  const { service } = makeStubCompanion({
    scripted: new Map([[WORKSPACE_ID, [coverageGapBrief(), validBrief()]]]),
  })
  const svc = new ReviewBriefRunService(makeDeps(service, fixtureChangeSet(), events))

  const result = await svc.start({ workspaceId: WORKSPACE_ID, workspaceRoot: root, depth: 'standard' })

  assert.equal(result.ok, true)
  assert.ok(existsSync(briefPath(root)), 'brief.json persisted after the retry')
  // The retry re-enters grouping with a detail marker.
  assert.ok(events.some((e) => e.phase === 'grouping' && e.detail === 'retrying'), 'retry emitted')
})

run('invalid twice -> failed carrying validator errors, no brief.json', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []
  const { service } = makeStubCompanion({
    scripted: new Map([[WORKSPACE_ID, [coverageGapBrief(), coverageGapBrief()]]]),
  })
  const svc = new ReviewBriefRunService(makeDeps(service, fixtureChangeSet(), events))

  const result = await svc.start({ workspaceId: WORKSPACE_ID, workspaceRoot: root, depth: 'standard' })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'validation')
    assert.ok(result.errors.length > 0, 'carries validator errors')
    assert.ok(result.errors.some((e) => /view\.tsx/.test(e)), 'names the dropped file')
  }
  assert.ok(!existsSync(briefPath(root)), 'no brief.json on double failure')
  assert.equal(events.at(-1)?.phase, 'failed')
})

run('severity-like annotation kind is rejected, triggers the retry path', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []
  const { service } = makeStubCompanion({
    scripted: new Map([[WORKSPACE_ID, [severityKindBrief(), validBrief()]]]),
  })
  const svc = new ReviewBriefRunService(makeDeps(service, fixtureChangeSet(), events))

  const result = await svc.start({ workspaceId: WORKSPACE_ID, workspaceRoot: root, depth: 'standard' })

  assert.equal(result.ok, true, 'the retry produced a valid brief')
  assert.ok(existsSync(briefPath(root)))
  assert.ok(events.some((e) => e.phase === 'grouping' && e.detail === 'retrying'), 'the bad kind forced a retry')
})

run('home-directory path in a brief is rejected and never persisted', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []
  const { service } = makeStubCompanion({
    scripted: new Map([[WORKSPACE_ID, [homePathBrief(), homePathBrief()]]]),
  })
  const svc = new ReviewBriefRunService(makeDeps(service, fixtureChangeSet(), events))

  const result = await svc.start({ workspaceId: WORKSPACE_ID, workspaceRoot: root, depth: 'standard' })

  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.some((e) => /home-directory/.test(e)), 'names the leak')
  assert.ok(!existsSync(briefPath(root)), 'a leaking brief is never written')
})

run('guide unavailable (no changeset ingested) fails visibly, no brief.json', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []
  const { service } = makeStubCompanion({ scripted: new Map() })
  const svc = new ReviewBriefRunService(makeDeps(service, null, events))

  const result = await svc.start({ workspaceId: WORKSPACE_ID, workspaceRoot: root, depth: 'brief' })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'guide-error')
  assert.ok(!existsSync(briefPath(root)))
})

run('interrupting a run leaves the previous brief.json untouched', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []

  // First run persists a good brief.
  const first = makeStubCompanion({ scripted: new Map([[WORKSPACE_ID, [validBrief()]]]) })
  const svc1 = new ReviewBriefRunService(makeDeps(first.service, fixtureChangeSet(), events))
  await svc1.start({ workspaceId: WORKSPACE_ID, workspaceRoot: root, depth: 'standard' })
  const before = readFileSync(briefPath(root), 'utf-8')

  // Second run hangs; interrupt it mid-flight. The persisted brief must survive.
  const second = makeStubCompanion({
    scripted: new Map([[WORKSPACE_ID, [validBrief()]]]),
    hangUntilInterrupt: new Set([WORKSPACE_ID]),
  })
  const svc2 = new ReviewBriefRunService(makeDeps(second.service, fixtureChangeSet(), events))
  const pending = svc2.start({ workspaceId: WORKSPACE_ID, workspaceRoot: root, depth: 'standard' })
  // Let the run reach its hang, then interrupt.
  await new Promise((resolve) => setTimeout(resolve, 10))
  svc2.interrupt(WORKSPACE_ID)
  const result = await pending

  assert.equal(result.ok, false, 'interrupted run does not succeed')
  assert.equal(readFileSync(briefPath(root), 'utf-8'), before, 'previous brief.json is untouched')
})

run('a re-run with affectedStepIds reuses the previous brief and builds the incremental prompt', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []
  // Seed a previous walkthrough on disk (as a first run would have left it).
  mkdirSync(join(root, '.multi-code', 'review', WORKSPACE_ID), { recursive: true })
  writeFileSync(briefPath(root), JSON.stringify(validBrief(), null, 2), 'utf-8')

  const capturedPrompts: string[] = []
  const { service } = makeStubCompanion({ scripted: new Map([[WORKSPACE_ID, [validBrief()]]]), capturedPrompts })
  const svc = new ReviewBriefRunService(makeDeps(service, fixtureChangeSet(), events))

  const result = await svc.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    depth: 'standard',
    affectedStepIds: ['step-store'],
  })

  assert.equal(result.ok, true)
  const prompt = capturedPrompts.at(-1) ?? ''
  assert.match(prompt, /This is a REFRESH/, 'chose the incremental re-run prompt')
  assert.match(prompt, /step-store/, 'names the affected step id')
  assert.match(prompt, /Your previous ReviewBrief/, 'attaches the previous brief')
  // The unaffected step id must ride along verbatim for the guide to preserve.
  assert.match(prompt, /step-view/, 'carries the unaffected step so its id stays stable')
})

run('a re-run with no previous brief falls back to a full run', async () => {
  const root = makeWorkspaceRoot()
  const events: BriefRunEvent[] = []
  const capturedPrompts: string[] = []
  const { service } = makeStubCompanion({ scripted: new Map([[WORKSPACE_ID, [validBrief()]]]), capturedPrompts })
  const svc = new ReviewBriefRunService(makeDeps(service, fixtureChangeSet(), events))

  // affectedStepIds present but no brief.json on disk -> full run, not a crash.
  const result = await svc.start({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    depth: 'standard',
    affectedStepIds: ['step-store'],
  })

  assert.equal(result.ok, true)
  const prompt = capturedPrompts.at(-1) ?? ''
  assert.doesNotMatch(prompt, /This is a REFRESH/, 'fell back to the full-run prompt')
})

run('GUIDE_SYSTEM_PROMPT embeds the schema doc verbatim and forbids verdict language', () => {
  // The test runs from the repo root (npm run), so resolve the doc from cwd.
  const doc = readFileSync(join(process.cwd(), 'docs', 'review-brief-schema.md'), 'utf-8')
  assert.equal(REVIEW_BRIEF_SCHEMA_DOC, doc, 'embedded schema doc is verbatim (drift guard)')
  assert.ok(GUIDE_SYSTEM_PROMPT.includes(doc), 'system prompt embeds the schema doc')
  assert.ok(/never judge/i.test(GUIDE_SYSTEM_PROMPT), 'system prompt states the no-judgment rule')
  assert.ok(/narrator/i.test(GUIDE_SYSTEM_PROMPT), 'system prompt frames the guide as a narrator')
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
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  if (failed) process.exit(1)
  console.log('brief-run-service.test.ts: ok')
}

void main()
