import assert from 'node:assert/strict'
import { buildGuidedBriefSpecialistStartupPrompt } from '../../../specialists/specialistActions'
import {
  containsGuidedBriefMarker,
  startGuidedBriefSpecialistSession,
  type GuidedBriefTerminalApi,
} from './sessionAdapter'

function createTerminalApi(): GuidedBriefTerminalApi & {
  spawned: Array<{ sessionId: string; prompt?: string; cwd?: string }>
  writes: string[]
  emitData: (sessionId: string, chunk: string) => void
} {
  const dataHandlers = new Map<string, (chunk: string) => void>()
  const exitHandlers = new Map<string, (code: number) => void>()
  const errorHandlers = new Map<string, (message: string) => void>()
  const spawned: Array<{ sessionId: string; prompt?: string; cwd?: string }> = []
  const writes: string[] = []

  return {
    spawned,
    writes,
    emitData(sessionId, chunk) {
      dataHandlers.get(sessionId)?.(chunk)
    },
    async terminalSpawn(sessionId, _cols, _rows, cwd, _resume, _statePath, _cli, initialPrompt) {
      spawned.push({ sessionId, prompt: initialPrompt, cwd })
      return { ok: true, sessionId }
    },
    async terminalWrite(_sessionId, data) {
      writes.push(data)
    },
    terminalWriteFast(_sessionId, data) {
      writes.push(data)
    },
    async terminalKill() {},
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
assert.match(strategistPrompt, /\nBRIEF_READY\n/, 'strategist prompt emits BRIEF_READY marker')

const designerPrompt = buildGuidedBriefSpecialistStartupPrompt({
  kind: 'designer',
  acceptedBriefSnapshotPath: 'product/.versions/brief.md',
  mockupPath: 'mockups/app.html',
})
assert.match(designerPrompt, /souls get frontend/, 'designer prompt requires frontend Soul')
assert.match(designerPrompt, /product\/\.versions\/brief\.md/, 'designer prompt reads accepted brief snapshot')
assert.match(designerPrompt, /product\/ui-direction\.md/, 'designer prompt writes UI direction')
assert.match(designerPrompt, /mockups\/app\.html/, 'designer prompt writes mockup HTML')
assert.match(designerPrompt, /\nMOCKUP_SET_READY\n/, 'designer prompt emits MOCKUP_SET_READY marker')

assert.equal(containsGuidedBriefMarker('working\nBRIEF_READY\n', 'BRIEF_READY'), true)
assert.equal(containsGuidedBriefMarker('working BRIEF_READY but not a marker line', 'BRIEF_READY'), false)

const api = createTerminalApi()
const lifecycles: string[] = []
const markers: string[] = []
const result = await startGuidedBriefSpecialistSession(
  {
    kind: 'strategist',
    workspaceRoot: '/workspace',
    sessionId: 'guided-brief-test',
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

  await result.session.sendMessage('Please tighten the MVP scope.')
  assert.match(api.writes[0] ?? '', /\x1b\[200~/, 'stdin uses bracketed paste')
  assert.match(api.writes[0] ?? '', /Please tighten the MVP scope\./, 'stdin includes user message')
}
