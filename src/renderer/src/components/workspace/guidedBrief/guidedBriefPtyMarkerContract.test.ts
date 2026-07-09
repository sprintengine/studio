import assert from 'node:assert/strict'

import {
  containsGuidedBriefMarker,
  startGuidedBriefSpecialistSession,
  type GuidedBriefTerminalApi,
} from './sessionAdapter'
import type { GuidedInterviewState } from './interviewProtocol'

// Layer 2 of the Design Wizard verification harness (MC-1506), PTY transport.
// The stage-signal regression net for the raw-terminal stream, which — unlike the
// clean conversation content_delta stream (covered in
// conversationSessionAdapter.test.ts) — carries ANSI, cursor repaints, and CR
// overwrites. These fixtures prove the readiness marker survives (or correctly
// ignores) the messy cases a real CLI produces. The marker is only the
// re-validation trigger; the readiness gate itself is the stageReadiness truth
// table. Lives in its own file (not sessionAdapter.test.ts) to stay decoupled
// from the concurrently evolving prompt-contract suite.

const DESIGN_SYSTEM_MARKER = 'DESIGN_SYSTEM_READY'

// --- Pure marker detection over adversarial PTY bytes -------------------------

// marker mid-TUI-repaint: the marker arrives wrapped in ANSI color codes and a
// Claude Code `⏺` glyph, after a spinner has been redrawing its status line with
// CR overwrites. Stripping ANSI + collapsing CR overwrites + trimming prompt
// chrome must still resolve the marker line.
assert.equal(
  containsGuidedBriefMarker(
    '\x1b[2K\rBuilding tokens \x1b[33m⠋\x1b[0m\r\x1b[2K\rBuilding tokens \x1b[33m⠙\x1b[0m\r\x1b[32m⏺\x1b[0m DESIGN_SYSTEM_READY\x1b[0m\n',
    DESIGN_SYSTEM_MARKER,
  ),
  true,
  'marker survives ANSI + glyph wrapping after CR spinner repaints',
)

// A spinner mid-redraw (no completed marker line yet) must not read as ready.
assert.equal(
  containsGuidedBriefMarker('\x1b[2K\rBuilding tokens \x1b[33m⠙\x1b[0m\r', DESIGN_SYSTEM_MARKER),
  false,
  'an in-flight spinner line is not a marker',
)

// marker quoted in prose: a marker is a line equal to the token, never a
// substring inside a sentence.
assert.equal(
  containsGuidedBriefMarker("I'll emit DESIGN_SYSTEM_READY once the bundle lints clean.\n", DESIGN_SYSTEM_MARKER),
  false,
  'the marker quoted inside prose must never flip the stage',
)
assert.equal(
  containsGuidedBriefMarker('Run node scripts/lint.mjs before DESIGN_SYSTEM_READY_LATER fires.\n', DESIGN_SYSTEM_MARKER),
  false,
  'a marker substring inside another token must not match',
)

// --- Adversarial sequences through the PTY adapter's lifecycle ----------------

function createTerminalApi(): GuidedBriefTerminalApi & {
  emitData: (sessionId: string, chunk: string) => void
  emitExit: (sessionId: string, code: number) => void
} {
  const dataHandlers = new Map<string, (chunk: string) => void>()
  const exitHandlers = new Map<string, (code: number) => void>()
  return {
    emitData(sessionId, chunk) {
      dataHandlers.get(sessionId)?.(chunk)
    },
    emitExit(sessionId, code) {
      exitHandlers.get(sessionId)?.(code)
    },
    async terminalSpawn(sessionId): Promise<{ ok: true; sessionId: string }> {
      return { ok: true, sessionId }
    },
    async terminalKill() {},
    onTerminalReplay() {
      return () => {}
    },
    onTerminalData(sessionId, cb) {
      dataHandlers.set(sessionId, cb)
      return () => dataHandlers.delete(sessionId)
    },
    onTerminalExit(sessionId, cb) {
      exitHandlers.set(sessionId, cb)
      return () => exitHandlers.delete(sessionId)
    },
    onTerminalError() {
      return () => {}
    },
  }
}

async function startDesignSystemSession(
  api: ReturnType<typeof createTerminalApi>,
  handlers: {
    onMarker?: (marker: string) => void
    onLifecycle?: (state: string) => void
    onInterview?: (state: GuidedInterviewState) => void
  },
): Promise<string> {
  const started = await startGuidedBriefSpecialistSession(
    {
      kind: 'designer',
      workspaceRoot: '/workspace',
      cli: 'claude-code',
      designSystem: { bundleDirectoryPath: 'design-system', ideaSeedPath: '.guided-brief/idea-seed.md' },
    },
    { terminalApi: api, ...handlers },
  )
  if (!started.ok) {
    assert.fail(`design-system PTY session failed to start: ${started.message}`)
  }
  return started.session.sessionId
}

// marker split across chunks + repeated: exactly one flip, single-shot.
{
  const api = createTerminalApi()
  const markers: string[] = []
  const lifecycles: string[] = []
  const id = await startDesignSystemSession(api, {
    onMarker: (marker) => markers.push(marker),
    onLifecycle: (state) => lifecycles.push(state),
  })
  api.emitData(id, '\x1b[32m⏺\x1b[0m DESIGN_SYS')
  assert.deepEqual(markers, [], 'a half-arrived marker must not flip')
  api.emitData(id, 'TEM_READY\x1b[0m\n')
  assert.deepEqual(markers, [DESIGN_SYSTEM_MARKER], 'the completed marker flips once, across chunk boundaries')
  assert.ok(lifecycles.includes('ready'), 'a completed marker moves the lifecycle to ready')
  api.emitData(id, '⏺ DESIGN_SYSTEM_READY\n')
  assert.deepEqual(markers, [DESIGN_SYSTEM_MARKER], 'marker detection is single-shot')
}

// crash mid-write: the process dies after a partial marker line. Exit without a
// completed marker is `exited`, never `ready` — silence after a crash cannot be
// mistaken for a finished bundle.
{
  const api = createTerminalApi()
  const markers: string[] = []
  const lifecycles: string[] = []
  const id = await startDesignSystemSession(api, {
    onMarker: (marker) => markers.push(marker),
    onLifecycle: (state) => lifecycles.push(state),
  })
  api.emitData(id, 'Authoring tokens…\nDESIGN_SYS')
  api.emitExit(id, 1)
  assert.deepEqual(markers, [], 'a torn-off partial marker never completes')
  assert.equal(lifecycles.at(-1), 'exited', 'a crash before the marker ends the lifecycle exited, not ready')
}

// question-pending vs readiness: a pending interview question is surfaced but is
// not a readiness signal — no marker fires while the agent waits on the user.
{
  const api = createTerminalApi()
  const markers: string[] = []
  const interviews: GuidedInterviewState[] = []
  const id = await startDesignSystemSession(api, {
    onMarker: (marker) => markers.push(marker),
    onInterview: (state) => interviews.push(state),
  })
  api.emitData(
    id,
    [
      'GUIDED_QUESTION_BEGIN',
      JSON.stringify({
        id: 'accent',
        question: 'Which accent hue anchors the system?',
        options: [
          { key: 'green', label: 'Forest green' },
          { key: 'blue', label: 'Slate blue' },
        ],
      }),
      'GUIDED_QUESTION_END',
      '',
    ].join('\n'),
  )
  assert.equal(interviews.at(-1)?.currentQuestion?.id, 'accent', 'the pending question is surfaced to the pane')
  assert.deepEqual(markers, [], 'a pending question is not a readiness signal — no marker fires')
}

console.log('guidedBriefPtyMarkerContract.test.ts: ok')
