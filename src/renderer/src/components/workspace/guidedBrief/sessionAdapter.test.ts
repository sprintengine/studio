import assert from 'node:assert/strict'
import type { TerminalSpawnMetadata } from '../../../../../shared/electron-api'
import { DESIGN_SYSTEM_ATTACHED_PROMPT_LINE } from '../../../../../shared/design-system/attach'
import {
  buildGuidedBriefSpecialistStartupPrompt,
  resolveDesignSystemAttachedPromptLine,
} from '../../../specialists/specialistActions'
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
  emitReplay: (sessionId: string, chunk: string) => void
} {
  const replayHandlers = new Map<string, (chunk: string) => void>()
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
    emitReplay(sessionId, chunk) {
      replayHandlers.get(sessionId)?.(chunk)
    },
    async terminalSpawn(sessionId, _cols, _rows, cwd, _resume, _statePath, _cli, initialPrompt, _cliRuntimes, _shellOnly, metadata) {
      spawned.push({ sessionId, prompt: initialPrompt, cwd, metadata })
      return { ok: true, sessionId }
    },
    async terminalKill(sessionId) {
      killed.push(sessionId)
    },
    onTerminalReplay(sessionId, cb) {
      replayHandlers.set(sessionId, cb)
      return () => replayHandlers.delete(sessionId)
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

// The design-system preset routes through the same designer kind but under a
// dedicated role prompt: no shared Soul fetch, bundle-directed authoring, the
// USAGE.md governance contract, and its own readiness marker.
const designSystemPrompt = buildGuidedBriefSpecialistStartupPrompt({
  kind: 'designer',
  designSystem: {
    bundleDirectoryPath: 'design-system',
    ideaSeedPath: '.guided-brief/idea-seed.md',
  },
})
assert.doesNotMatch(designSystemPrompt, /souls get/, 'design-system prompt replaces the shared designer Soul')
assert.match(designSystemPrompt, /\.guided-brief\/idea-seed\.md/, 'design-system prompt reads the design goal seed')
assert.match(designSystemPrompt, /design-system\/USAGE\.md/, 'design-system prompt binds the USAGE.md governance contract')
assert.match(designSystemPrompt, /tokens\.tokens\.json/, 'design-system prompt directs token authoring')
assert.match(designSystemPrompt, /scripts\/lint\.mjs/, 'design-system prompt requires the lint gate')
assert.match(designSystemPrompt, /scripts\/build-tokens\.mjs/, 'design-system prompt regenerates derived files via bundle scripts')
assert.match(designSystemPrompt, /one question at a time/, 'design-system prompt keeps the shared interview protocol')
assert.match(designSystemPrompt, /\nDESIGN_SYSTEM_READY\n/, 'design-system prompt emits its own marker')
assert.doesNotMatch(designSystemPrompt, /MOCKUP_SET_READY/, 'design-system prompt does not reuse the mockup marker')
assert.doesNotMatch(designSystemPrompt, /seeded/, 'blank-start design-system prompt carries no seeding instructions')

// Seed-from-existing-product: the prompt's opening move becomes a reviewed
// extraction of the named source — DTCG tokens marked as inferred via the
// vendor extension, copied glyphs, candidate components, both modes, and an
// interview that confirms the inferred semantics with the user.
const seededFolderPrompt = buildGuidedBriefSpecialistStartupPrompt({
  kind: 'designer',
  designSystem: {
    bundleDirectoryPath: 'design-system',
    ideaSeedPath: '.guided-brief/idea-seed.md',
    seedSource: { kind: 'source-folder', path: '/repo/my-app' },
  },
})
assert.match(seededFolderPrompt, /\/repo\/my-app/, 'seeded prompt names the source path')
assert.match(seededFolderPrompt, /:root/, 'seeded prompt targets CSS custom-property blocks')
assert.match(
  seededFolderPrompt,
  /"seeded": true/,
  'seeded prompt marks inferred semantics in the vendor extension for review',
)
assert.match(
  seededFolderPrompt,
  /\$extensions\["com\.multicode"\]/,
  'seeded prompt uses the bundle token metadata convention',
)
assert.match(
  seededFolderPrompt,
  /both light and dark mode values/,
  'seeded prompt requires both mode sets',
)
assert.match(seededFolderPrompt, /glyphs\//, 'seeded prompt copies source glyphs into the bundle')
assert.match(seededFolderPrompt, /candidate components/, 'seeded prompt drafts candidate components')
assert.match(
  seededFolderPrompt,
  /walking the user through the inferred semantics/,
  'seeded prompt confirms inferred semantics with the user',
)
assert.match(
  seededFolderPrompt,
  /not a silent import/,
  'seeded prompt frames extraction as reviewed, not magic import',
)
assert.doesNotMatch(seededFolderPrompt, /Multicode brand reference/, 'folder seeding does not mention the demo source')

// Attached-design-system injection (T9): the mockup designer's prompt carries
// the conform line when and only when the caller resolved design-system/ as
// present; the authoring studio never gets it (it owns that directory).
const designerWithAttachedBundle = buildGuidedBriefSpecialistStartupPrompt({
  kind: 'designer',
  designSystemAttached: true,
})
assert.ok(
  designerWithAttachedBundle.includes(DESIGN_SYSTEM_ATTACHED_PROMPT_LINE),
  'attached bundle injects the conform line into the mockup designer prompt',
)
const designerWithoutAttachedBundle = buildGuidedBriefSpecialistStartupPrompt({ kind: 'designer' })
assert.ok(
  !designerWithoutAttachedBundle.includes(DESIGN_SYSTEM_ATTACHED_PROMPT_LINE),
  'no attached bundle, no conform line',
)
assert.ok(
  !designSystemPrompt.includes(DESIGN_SYSTEM_ATTACHED_PROMPT_LINE),
  'the design-system authoring prompt never carries the consumer conform line',
)

// The launch-time predicate resolves once per launch: line when and only when
// design-system/ exists under the execution root; failures resolve to absent.
assert.equal(await resolveDesignSystemAttachedPromptLine(null, async () => true), null)
assert.equal(await resolveDesignSystemAttachedPromptLine('  ', async () => true), null)
assert.equal(await resolveDesignSystemAttachedPromptLine('/repo', async () => false), null)
assert.equal(
  await resolveDesignSystemAttachedPromptLine('/repo', async (path) => path.endsWith('design-system')),
  DESIGN_SYSTEM_ATTACHED_PROMPT_LINE,
)
assert.equal(
  await resolveDesignSystemAttachedPromptLine('/repo', async () => {
    throw new Error('fs unavailable')
  }),
  null,
  'a failed existence check resolves to no line, never a crash',
)

const seededDemoPrompt = buildGuidedBriefSpecialistStartupPrompt({
  kind: 'designer',
  designSystem: {
    bundleDirectoryPath: 'design-system',
    ideaSeedPath: '.guided-brief/idea-seed.md',
    seedSource: { kind: 'brand-demo', path: '/app/knowledge/brand' },
  },
})
assert.match(seededDemoPrompt, /\/app\/knowledge\/brand/, 'demo seeding names the resolved demo path')
assert.match(seededDemoPrompt, /Multicode brand reference/, 'demo seeding frames the built-in source')
assert.match(seededDemoPrompt, /design-tokens\.md/, 'demo seeding points at the brand token tables')
assert.match(seededDemoPrompt, /glyph-system\.md/, 'demo seeding points at the brand glyph language')

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
    cli: 'claude-code',
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
    cli: 'claude-code',
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
  assert.equal(
    api.spawned[0]?.metadata?.cliPermissionPreset,
    'bypass',
    'guided brief strategist sessions request bypass-all CLI permissions (no per-tool prompts mid-interview)',
  )

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
    cli: 'claude-code',
  },
  { terminalApi: architectApi },
)
assert.equal(architectResult.ok, true, 'architect session starts')
if (architectResult.ok) {
  assert.equal(architectApi.spawned[0]?.sessionId, 'persisted-architect-id')
  assert.match(architectApi.spawned[0]?.prompt ?? '', /souls get architect/, 'architect session sends architecture startup prompt')
  assert.equal(architectResult.session.markerDetection.artifactPath, 'architecture/plan.md')
  assert.equal(
    architectApi.spawned[0]?.metadata?.cliPermissionPreset,
    'bypass',
    'guided brief architect sessions request bypass-all CLI permissions',
  )
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
    'bypass',
    'guided brief designer sessions request bypass-all CLI permissions (every specialist gets the same preset)',
  )
  assert.equal(reattachResult.session.sessionId, 'persisted-designer-id', 'session exposes the persisted id back to the hook')
}

// Design-system designer session: same shared spawn path (bypass), but
// the readiness marker and watched artifact are the bundle's, not mockups'.
const designSystemApi = createTerminalApi()
const designSystemMarkers: string[] = []
const designSystemResult = await startGuidedBriefSpecialistSession(
  {
    kind: 'designer',
    workspaceRoot: '/workspace',
    cli: 'codex',
    designSystem: {
      bundleDirectoryPath: 'design-system',
      ideaSeedPath: '.guided-brief/idea-seed.md',
    },
  },
  {
    terminalApi: designSystemApi,
    onMarker: (marker) => designSystemMarkers.push(marker),
  },
)
assert.equal(designSystemResult.ok, true, 'design-system designer spawn returns ok')
if (designSystemResult.ok) {
  assert.equal(designSystemResult.session.markerDetection.marker, 'DESIGN_SYSTEM_READY')
  assert.equal(designSystemResult.session.markerDetection.watchPath, 'design-system')
  assert.equal(designSystemResult.session.markerDetection.artifactPath, 'design-system/design-system.json')
  assert.equal(
    designSystemApi.spawned[0]?.metadata?.cliPermissionPreset,
    'bypass',
    'design-system designer sessions keep the shared bypass-all spawn path',
  )
  designSystemApi.emitData(designSystemResult.session.sessionId, 'working\nDESIGN_SYSTEM_READY\n')
  assert.deepEqual(designSystemMarkers, ['DESIGN_SYSTEM_READY'], 'bundle marker is detected from terminal output')
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
