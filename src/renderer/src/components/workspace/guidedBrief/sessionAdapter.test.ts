import assert from 'node:assert/strict'
import type { TerminalSpawnMetadata } from '../../../../../shared/electron-api'
import { buildGuidedBriefSpecialistStartupPrompt } from '../../../specialists/specialistActions'
import {
  containsGuidedBriefMarker,
  createGuidedBriefSessionId,
  startGuidedBriefSpecialistSession,
  type GuidedBriefTerminalApi,
} from './sessionAdapter'

function createTerminalApi(): GuidedBriefTerminalApi & {
  spawned: Array<{ sessionId: string; prompt?: string; cwd?: string; metadata?: TerminalSpawnMetadata }>
  killed: string[]
  dataHandlerCount: () => number
  emitData: (sessionId: string, chunk: string) => void
} {
  const dataHandlers = new Map<string, (chunk: string) => void>()
  const exitHandlers = new Map<string, (code: number) => void>()
  const errorHandlers = new Map<string, (message: string) => void>()
  const spawned: Array<{ sessionId: string; prompt?: string; cwd?: string; metadata?: TerminalSpawnMetadata }> = []
  const killed: string[] = []

  return {
    spawned,
    killed,
    dataHandlerCount: () => dataHandlers.size,
    emitData(sessionId, chunk) {
      dataHandlers.get(sessionId)?.(chunk)
    },
    async terminalSpawn(sessionId, _cols, _rows, cwd, _resume, _statePath, _cli, initialPrompt, _cliRuntimes, _shellOnly, metadata) {
      spawned.push({ sessionId, prompt: initialPrompt, cwd, metadata })
      return { ok: true, sessionId }
    },
    async terminalKill(sessionId) {
      killed.push(sessionId)
    },
    onTerminalData(sessionId, cb) {
      dataHandlers.set(sessionId, cb)
      return () => dataHandlers.delete(sessionId)
    },
    onTerminalExit(sessionId, cb) {
      exitHandlers.set(sessionId, cb)
      return () => exitHandlers.delete(sessionId)
    },
    onTerminalError(sessionId, cb) {
      errorHandlers.set(sessionId, cb)
      return () => errorHandlers.delete(sessionId)
    },
  }
}

const strategistPrompt = buildGuidedBriefSpecialistStartupPrompt({
  kind: 'strategist',
  ideaSeedPath: 'product/idea-seed.md',
  requirementsPath: 'product/requirements.md',
})
assert.match(strategistPrompt, /souls get product/, 'strategist prompt requires product Soul')
assert.match(strategistPrompt, /product\/idea-seed\.md/, 'strategist prompt reads idea seed')
assert.match(strategistPrompt, /product\/requirements\.md/, 'strategist prompt writes requirements')
assert.match(
  strategistPrompt,
  /2-4 concrete multiple-choice options/,
  'strategist prompt requires concrete multiple-choice interview options',
)
assert.match(strategistPrompt, /\nBRIEF_READY\n/, 'strategist prompt emits BRIEF_READY marker')

const designerPrompt = buildGuidedBriefSpecialistStartupPrompt({
  kind: 'designer',
  acceptedBriefSnapshotPath: 'product/.versions/brief.md',
  acceptedArchitecturePlanPath: 'product/.versions/architecture.md',
  mockupPath: 'mockups/app.html',
})
assert.match(designerPrompt, /souls get frontend/, 'designer prompt requires frontend Soul')
assert.match(designerPrompt, /product\/\.versions\/architecture\.md/, 'designer prompt reads accepted architecture snapshot when available')
assert.match(designerPrompt, /product\/ui-direction\.md/, 'designer prompt writes UI direction')
assert.match(designerPrompt, /mockups\/app\.html/, 'designer prompt writes mockup HTML')
assert.match(designerPrompt, /\nMOCKUP_SET_READY\n/, 'designer prompt emits MOCKUP_SET_READY marker')

const architectPrompt = buildGuidedBriefSpecialistStartupPrompt({
  kind: 'architect',
  acceptedBriefSnapshotPath: 'product/.versions/brief.md',
  architecturePlanPath: 'architecture/plan.md',
})
assert.match(architectPrompt, /souls get architect/, 'architect prompt requires architect Soul')
assert.match(architectPrompt, /product\/\.versions\/brief\.md/, 'architect prompt reads accepted brief snapshot')
assert.match(architectPrompt, /architecture\/plan\.md/, 'architect prompt writes architecture plan')
assert.match(architectPrompt, /one question at a time/, 'architect prompt includes the shared interview protocol')
assert.match(
  architectPrompt,
  /recommended option first and clearly labeled "Recommended"/,
  'architect prompt labels the recommended multiple-choice option',
)
assert.match(architectPrompt, /\nARCHITECTURE_PLAN_READY\n/, 'architect prompt emits ARCHITECTURE_PLAN_READY marker')

assert.equal(containsGuidedBriefMarker('working\nBRIEF_READY\n', 'BRIEF_READY'), true)
assert.equal(containsGuidedBriefMarker('working BRIEF_READY but not a marker line', 'BRIEF_READY'), false)
// Claude Code prefixes assistant lines with "⏺ " and wraps text in ANSI. The
// marker still needs to match after both are stripped.
assert.equal(
  containsGuidedBriefMarker('\x1b[1m⏺\x1b[0m MOCKUP_SET_READY\n', 'MOCKUP_SET_READY'),
  true,
  'detects marker wrapped in ANSI + Claude Code prompt glyph',
)
// Codex boxes wrap lines in box-drawing characters at both ends.
assert.equal(
  containsGuidedBriefMarker('│ MOCKUP_SET_READY │\n', 'MOCKUP_SET_READY'),
  true,
  'detects marker wrapped in Codex box-drawing chrome',
)
// Substring matches must still be rejected so noisy logs do not flip the gate.
assert.equal(
  containsGuidedBriefMarker('see MOCKUP_SET_READY_LATER for details\n', 'MOCKUP_SET_READY'),
  false,
  'does not match a marker substring inside another token',
)

const generatedIdApi = createTerminalApi()
const generatedIdResult = await startGuidedBriefSpecialistSession(
  {
    kind: 'strategist',
    workspaceRoot: '/workspace',
    cli: 'claude',
  },
  {
    terminalApi: generatedIdApi,
  },
)

assert.equal(generatedIdResult.ok, true, 'session starts with generated ID')
if (generatedIdResult.ok) {
  assert.match(
    generatedIdResult.session.sessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'generated Guided brief session ID is a provider-compatible UUID',
  )
}

const api = createTerminalApi()
const lifecycles: string[] = []
const markers: string[] = []
const result = await startGuidedBriefSpecialistSession(
  {
    kind: 'strategist',
    workspaceRoot: '/workspace',
    sessionId: 'guided-brief-test',
    cli: 'claude',
  },
  {
    terminalApi: api,
    onLifecycle: (state) => lifecycles.push(state),
    onMarker: (marker) => markers.push(marker),
  },
)

assert.equal(result.ok, true, 'session starts')
if (result.ok) {
  assert.equal(api.spawned[0]?.sessionId, 'guided-brief-test')
  assert.equal(api.spawned[0]?.cwd, '/workspace')
  assert.match(api.spawned[0]?.prompt ?? '', /souls get product/, 'session sends startup prompt to real terminal spawn')
  assert.equal(result.session.markerDetection.artifactPath, 'product/requirements.md')

  api.emitData('guided-brief-test', 'drafting\nBRIEF_READY\n')
  assert.deepEqual(markers, ['BRIEF_READY'], 'adapter detects marker from real terminal output')
  assert.ok(lifecycles.includes('ready'), 'marker moves lifecycle to ready')

  // Cleanup contract: dispose() releases listeners only — it must not kill the
  // PTY. The renderer hook calls dispose() on every unmount (HMR / refresh /
  // stage transition), and the PTY needs to survive so the next mount can
  // reattach via the persisted sessionId. stop() is the explicit teardown the
  // flow calls only on stage completion or user-confirmed close.
  result.session.dispose()
  assert.deepEqual(api.killed, [], 'dispose() must not call terminalKill — PTY survives renderer remount')
  assert.equal(api.dataHandlerCount(), 0, 'dispose() releases the data listener')

  await result.session.stop()
  assert.deepEqual(api.killed, ['guided-brief-test'], 'stop() is the explicit kill path used on accept / close')
}

const architectApi = createTerminalApi()
const architectResult = await startGuidedBriefSpecialistSession(
  {
    kind: 'architect',
    workspaceRoot: '/workspace',
    acceptedBriefSnapshotPath: 'product/.versions/brief.md',
    sessionId: 'persisted-architect-id',
    cli: 'claude',
  },
  { terminalApi: architectApi },
)
assert.equal(architectResult.ok, true, 'architect session starts')
if (architectResult.ok) {
  assert.equal(architectApi.spawned[0]?.sessionId, 'persisted-architect-id')
  assert.match(architectApi.spawned[0]?.prompt ?? '', /souls get architect/, 'architect session sends architecture startup prompt')
  assert.equal(architectResult.session.markerDetection.artifactPath, 'architecture/plan.md')
}

// Reattach path: a hook that was given a persisted sessionId must reuse it
// verbatim so spawnTerminalFromIpc reattaches in main instead of spawning a
// fresh agent.
const reattachApi = createTerminalApi()
const reattachResult = await startGuidedBriefSpecialistSession(
  {
    kind: 'designer',
    workspaceRoot: '/workspace',
    acceptedBriefSnapshotPath: 'product/.versions/brief.md',
    sessionId: 'persisted-designer-id',
    cli: 'codex',
  },
  { terminalApi: reattachApi },
)
assert.equal(reattachResult.ok, true, 'reattach spawn returns ok')
if (reattachResult.ok) {
  assert.equal(reattachApi.spawned[0]?.sessionId, 'persisted-designer-id', 'persisted sessionId is reused, not regenerated')
  assert.equal(
    reattachApi.spawned[0]?.metadata?.cliPermissionPreset,
    'bypass_all',
    'guided brief designer sessions request bypass-all CLI permissions',
  )
  assert.equal(reattachResult.session.sessionId, 'persisted-designer-id', 'session exposes the persisted id back to the hook')
}

// Eager-persist contract: hooks call createGuidedBriefSessionId() to mint an
// id synchronously and persist it BEFORE terminalSpawn. The returned id must
// be a valid UUIDv4 so the same id can be passed back in on reattach.
const eagerId = createGuidedBriefSessionId()
assert.match(
  eagerId,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  'createGuidedBriefSessionId() returns a UUIDv4 the hook can persist eagerly',
)
assert.notEqual(eagerId, createGuidedBriefSessionId(), 'every call mints a fresh id')
