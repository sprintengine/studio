import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SprintRunSummary, SprintRunsChangedEvent } from '../shared/sprintengine/runSummary'
import type { BriefRunEvent } from '../main/review/brief-run-service'
import type { ReviewBrief, ReviewChangeSet } from '../shared/review'
import type { TerminalSessionSnapshot, TerminalSpawnResult } from '../shared/electron-api'
import type { TerminalSpawnPayload } from '../main/ipc/terminal-ipc'
import { installJsdomEnvironment, withInertPreloadFallback } from './jsdomEnvironment'

// ── Seam: the review/main boundary (T6 → T7, items 1801/1805/1806) ────────────
//
// T6 gave the Sprints index a projection-write signal; T7 wired the Review
// module's three seams. Both landed in `src/main/app-services.ts`, in disjoint
// regions, and both are only useful across a boundary their own suites stop at:
//
//  * T6's suite proves the watch fires a sink it supplies itself. It cannot show
//    that the sink main actually installs invalidates the memo, nor that the
//    door's index hook — whose documented contract is event-driven invalidation
//    rather than polling — refetches on it.
//  * T7's suite proves the guide service releases its reap exemption when asked,
//    and the gateway suite proves the tools refuse while the module is off. What
//    connects them is the brief sink: a `review_submit_brief` that lands is what
//    asks. Neither side calls the other.
//
// So this suite composes the real halves and asserts the observable result: a
// projection written with no runtime op reaches a mounted door, and a brief
// landing through the real gateway tool releases the real guide's terminal.

const dom = installJsdomEnvironment()
const domWindow = dom.window as unknown as Record<string, unknown>

async function main(): Promise<void> {
  await testProjectionWriteReachesTheDoorWithNoRuntimeOp()
  await testBriefLandingReleasesTheGuideTerminal()
  await testDisabledReviewModuleRefusesEveryGatewayTool()
  console.log('all review/main seam tests passed')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- 1801: an engine write with no runtime op reaches the door ---------------

async function testProjectionWriteReachesTheDoorWithNoRuntimeOp(): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'multicode-seam-run-index-'))
  const { watchSprintRunProjections } = await import('../main/sprintengine-run-index')
  try {
    const { BrowserWindow, ipcMain } = await import('electron')
    const { invalidateSprintRunSummary, listSprintRuns } = await import('../main/sprintengine-run-index')
    const { registerSprintEngineIpc } = await import('../main/ipc/sprintengine-ipc')
    const { SPRINT_RUNS_CHANGED_CHANNEL } = await import('../shared/sprintengine/runSummary')
    const { SPRINT_ENGINE_RUN_SCHEMA_VERSION } = await import('../shared/sprintengine/store-schema')
    const { sprintEngineApi } = await import('../preload/api/sprintengine')

    const teamDirectory = join(projectRoot, '.multi-code', 'sprintengine', 'engine-run')
    mkdirSync(teamDirectory, { recursive: true })
    const statePath = join(teamDirectory, 'run.yaml')
    const projectionPath = join(teamDirectory, 'projection.json')
    writeFileSync(statePath, 'sprintengine: {}\n', 'utf8')
    const writeProjection = (status: string): void => {
      writeFileSync(
        projectionPath,
        `${JSON.stringify({
          run: { schemaVersion: SPRINT_ENGINE_RUN_SCHEMA_VERSION, name: 'engine-run', goal: 'g' },
          tasks: [{ id: 'T1', title: 'T1', role: 'developer', status }],
        })}\n`,
        'utf8',
      )
    }
    writeProjection('in_progress')

    // `notifySprintRunsChanged` as app-services installs it: drop the run's memo,
    // then push the runs-changed event to every open window. Copied rather than
    // imported because app-services builds the whole app; the point of the copy
    // is that BOTH halves are here — an invalidation the sink skipped would let
    // the refetch below read a stale memo and this test would fail.
    const notified: string[] = []
    const notifySprintRunsChanged = (changedStatePath: string): void => {
      notified.push(changedStatePath)
      invalidateSprintRunSummary(changedStatePath)
      const changed: SprintRunsChangedEvent = { statePath: changedStatePath }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(SPRINT_RUNS_CHANGED_CHANNEL, changed)
      }
    }
    watchSprintRunProjections(notifySprintRunsChanged)

    // The real index behind the real channel; no runtime op exists in this test
    // at all, which is exactly the condition item 1801 is about.
    const refuse = async (): Promise<{ ok: false; message: string }> => ({
      ok: false,
      message: 'This channel is not part of the run-index seam.',
    })
    registerSprintEngineIpc(ipcMain, {
      listRuns: async (payload: { roots: string[] }) => listSprintRuns(payload.roots),
      openArtifact: refuse,
      reviewArtifact: refuse,
      initializeSprintEngineState: refuse,
      updateTask: refuse,
      createTask: refuse,
      commentTask: refuse,
      resolveTaskInput: refuse,
      setTaskStatus: refuse,
      setRunnerMode: refuse,
      cancelRun: refuse,
      createPullRequest: refuse,
      mergePullRequest: refuse,
      refreshPullRequestStatus: refuse,
      setRoleRuntime: refuse,
      enableRole: refuse,
      readProjection: refuse,
      readRegistryRoles: refuse,
      readRegistryRole: refuse,
      summarizeFeedback: refuse,
      readTokenUsage: refuse,
    } as unknown as Parameters<typeof registerSprintEngineIpc>[1])

    domWindow.api = withInertPreloadFallback({ platform: 'darwin', ...sprintEngineApi })

    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')
    const { useSprintRunIndex } = await import(
      '../renderer/src/components/workspace/globalSurface/sprints/useSprintRunIndex'
    )

    useWorkspaceStore.setState({
      workspaces: [
        { id: 'w1', name: 'project', mode: 'standard', folderPath: projectRoot, agents: {}, openFiles: [], createdAt: 1 },
      ],
      activeWorkspaceId: 'w1',
    } as never)

    // The door's data source, mounted on its own. Every other part of the
    // surface is irrelevant here: the contract under test is that this hook
    // refetches when main says a run changed.
    let runs: SprintRunSummary[] = []
    let loads = 0
    function IndexProbe(): null {
      const index = useSprintRunIndex()
      runs = index.runs
      loads += 1
      return null
    }
    // Read through a call, never a narrowed local: the hook rewrites `runs` from
    // outside anything the compiler can see, so a direct comparison would be
    // narrowed against the value the last assertion pinned.
    const runtimeState = (): string | undefined => runs[0]?.runtimeState
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(IndexProbe))
    })
    await act(async () => {
      await delay(50)
    })
    assert.equal(runs.length, 1, 'the door lists the run from disk')
    assert.equal(runtimeState(), 'running', 'with the state the engine had written')
    const rendersBefore = loads

    // The engine advances the run on disk. Nothing calls into main; there is no
    // runtime op to piggyback on. Retried because arming an fs watch is
    // asynchronous, so the first write can precede the armed watcher.
    const deadline = Date.now() + 8000
    while (runtimeState() !== 'completed' && Date.now() < deadline) {
      writeProjection('done')
      await act(async () => {
        await delay(60)
      })
    }
    assert.ok(notified.includes(statePath), 'main saw the projection write and invalidated the run')
    assert.equal(
      runtimeState(),
      'completed',
      'and the door refetched on the event, showing what the engine wrote',
    )
    assert.ok(loads > rendersBefore, 'the refetch was event-driven, not a remount')

    await act(async () => {
      root.unmount()
    })
    console.log('ok - a projection write with no runtime op invalidates the index and reaches the door')
  } finally {
    watchSprintRunProjections(null)
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

// --- 1806: a landed brief gives the guide's terminal back to the reaper ------

async function testBriefLandingReleasesTheGuideTerminal(): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'multicode-seam-review-brief-'))
  try {
    const { createReviewGatewayTools } = await import('../main/review/gateway-tools')
    const {
      createReviewGuideTerminalService,
      recordGuideRunEvent,
      reviewGuideAgentId,
    } = await import('../main/review/guide-terminal-service')
    const { GuideRunRegistry } = await import('../main/review/guide-run-registry')
    const { reviewChangeSetDir } = await import('../main/review/changeset-service')

    const reviewId = 'review_seam'
    const guideAgentId = reviewGuideAgentId(reviewId)
    const reviewDir = reviewChangeSetDir(projectRoot, reviewId)
    mkdirSync(reviewDir, { recursive: true })
    writeFileSync(join(reviewDir, 'changeset.json'), `${JSON.stringify(changeSetFixture(projectRoot))}\n`, 'utf8')

    // The real guide service over a recording terminal runtime.
    const reapExempt: Array<{ sessionId: string; exempt: boolean }> = []
    const kills: string[] = []
    const sessions: TerminalSessionSnapshot[] = []
    const guideRuns = new GuideRunRegistry()
    const guideEvents: BriefRunEvent[] = []
    const guide = createReviewGuideTerminalService({
      listWorkspaces: () => [{ id: 'ws-app', folderPath: projectRoot, mode: 'standard' }],
      terminal: {
        list: () => sessions,
        spawn: async (payload: TerminalSpawnPayload): Promise<TerminalSpawnResult> => {
          sessions.push(guideSession(payload.sessionId, payload.agentId ?? ''))
          return { ok: true, sessionId: payload.sessionId }
        },
        write: () => {},
        kill: (sessionId: string) => kills.push(sessionId),
        setReapExempt: (sessionId: string, exempt: boolean) => reapExempt.push({ sessionId, exempt }),
        onAgentSessionExit: () => () => {},
      },
      resolveSkillInvocation: () => '/review-guide',
      emit: (event) => guideEvents.push(event),
      guideRuns,
      delay: async () => {},
    })

    // The gateway's brief sink as review-module builds it: record the run
    // event, then release the guide's terminal on a delivered brief.
    const emitted: BriefRunEvent[] = []
    const tools = createReviewGatewayTools({
      listOpenProjectRoots: () => [projectRoot],
      homeDir: () => homedir(),
      emitBriefRunEvent: (event) => {
        emitted.push(event)
        recordGuideRunEvent(event, guideRuns)
        if (event.phase === 'done') guide.clearReapExempt(event.workspaceId)
      },
    })

    const started = await guide.startRun({
      reviewId,
      projectRoot,
      depth: 'standard',
      cli: 'claude-code',
    })
    assert.equal(started.ok, true, 'the guide started')
    const guidePty = sessions.at(-1)?.sessionId ?? ''
    assert.notEqual(guidePty, guideAgentId, 'the pty id is not the agent id')
    assert.deepEqual(
      reapExempt,
      [{ sessionId: guidePty, exempt: true }],
      'and took its terminal out of the idle reaper’s reach for the run',
    )

    const submit = tools.find((registration) => registration.name === 'review_submit_brief')
    assert.ok(submit, 'the gateway registers review_submit_brief')
    const result = await submit.handler({ reviewId, projectRoot, brief: briefFixture() })
    assert.equal(
      (result.structuredContent as { ok?: boolean } | undefined)?.ok,
      true,
      'the brief landed through the real tool',
    )
    assert.ok(existsSync(join(reviewDir, 'brief.json')), 'and was written')
    assert.deepEqual(emitted, [{ workspaceId: reviewId, phase: 'done' }])

    assert.deepEqual(
      reapExempt.at(-1),
      { sessionId: guidePty, exempt: false },
      'the landed brief released the guide’s terminal back to the reaper',
    )
    assert.deepEqual(kills, [], 'released, not killed — the reviewer may still read the terminal')
    assert.equal(guideRuns.status(reviewId)?.phase, 'done', 'and the run is recorded as delivered')

    // The run is over. A later stop must not overwrite the delivered outcome.
    guide.stop(reviewId)
    assert.equal(guideRuns.status(reviewId)?.phase, 'done')
    console.log('ok - a brief landing through the gateway releases the guide’s reap exemption')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

// --- 1805: the module switch reaches the MCP surface ------------------------

async function testDisabledReviewModuleRefusesEveryGatewayTool(): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'multicode-seam-review-disabled-'))
  try {
    const { createReviewGatewayTools } = await import('../main/review/gateway-tools')
    const { createStudioGatewayTools } = await import(
      '../main/automation/studio-gateway-tools'
    )
    const { createMainKernel } = await import('../main/module-host/main-host')
    const { reviewChangeSetDir } = await import('../main/review/changeset-service')
    const { reviewModule } = await import('../main/modules/review-module')
    const { ipcMain } = await import('electron')

    const reviewId = 'review_seam'
    const reviewDir = reviewChangeSetDir(projectRoot, reviewId)
    mkdirSync(reviewDir, { recursive: true })
    writeFileSync(join(reviewDir, 'changeset.json'), `${JSON.stringify(changeSetFixture(projectRoot))}\n`, 'utf8')

    // Enablement as main resolves it: the set of enabled main-module ids, asked
    // per call under the id the CONTRIBUTION carries (MC-1855). The review
    // tools register through the module host under the review module's own
    // manifest id — the seam is that the id the gateway asks about is the one
    // the module declared, not a name hard-coded on both sides.
    const enabledModuleIds = new Set<string>([reviewModule.manifest.id])
    const asked: string[] = []
    const emitted: BriefRunEvent[] = []
    const kernel = createMainKernel(ipcMain, {
      resolveModuleManifest: (moduleId) =>
        moduleId === reviewModule.manifest.id ? reviewModule.manifest : undefined,
    })
    kernel.hostFor(reviewModule.manifest.id).registerMcpTools(
      createReviewGatewayTools({
        listOpenProjectRoots: () => [projectRoot],
        homeDir: () => homedir(),
        emitBriefRunEvent: (event) => emitted.push(event),
      })
    )
    const tools = createStudioGatewayTools({
      appTools: [],
      sprintEngineMcpHub: { callRunTool: async () => ({}) },
      resolveModuleTools: () => kernel.mcpToolRegistrations(),
      isModuleEnabled: (moduleId) => {
        asked.push(moduleId)
        return enabledModuleIds.has(moduleId)
      },
    })().filter((registration) => registration.name.startsWith('review_'))
    assert.equal(reviewModule.manifest.id, 'review', 'the gateway asks about the module that owns review')

    // The user switches Review off in Settings, mid-session.
    enabledModuleIds.delete('review')
    const calls: Array<[string, Record<string, unknown>]> = [
      ['review_list_pending', {}],
      ['review_get_changeset', { reviewId, projectRoot }],
      ['review_get_brief', { reviewId, projectRoot }],
      ['review_submit_brief', { reviewId, projectRoot, brief: briefFixture() }],
    ]
    assert.deepEqual(
      tools.map((registration) => registration.name),
      calls.map(([name]) => name),
      'registration is static: a disabled module still lists its tools',
    )
    for (const [name, args] of calls) {
      const registration = tools.find((candidate) => candidate.name === name)
      assert.ok(registration, `${name} is registered`)
      const refused = await registration.handler(args)
      assert.equal(refused.isError, true, `${name} refuses`)
      assert.equal(
        (refused.structuredContent as { error: { message: string } }).error.message,
        'The Review module is disabled. Enable it in Settings → Modules to use review tools.',
        `${name} answers with the ruling’s sentence`,
      )
    }
    assert.equal(existsSync(join(reviewDir, 'brief.json')), false, 'no brief was written on a disabled capability')
    assert.deepEqual(emitted, [], 'and nothing was announced to open windows')
    assert.equal(asked.length, calls.length, 'enablement is read per call, never captured at registration')
    assert.ok(
      asked.every((moduleId) => moduleId === reviewModule.manifest.id),
      'every check names the id the module registered under'
    )

    // Switching it back on works on the next call, not the next restart.
    enabledModuleIds.add('review')
    const listed = await tools[0].handler({})
    assert.notEqual(listed.isError, true, 'an enabled module answers normally again')
    console.log('ok - a disabled Review module refuses every gateway tool, by the module’s own id')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

// --- Fixtures ---------------------------------------------------------------

// The guide's pty id is minted per spawn (a UUID, because a Claude-harness CLI
// is launched with `--session-id <it>`); its AGENT id is the stable per-review
// one. The two are deliberately different.
function guideSession(sessionId: string, agentId: string): TerminalSessionSnapshot {
  return {
    sessionId,
    processAlive: true,
    kind: 'agent',
    workspaceId: 'ws-app',
    agentId,
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
  } as TerminalSessionSnapshot
}

// The ingested change set and the brief that answers it, in the same shapes the
// review gateway's own suite uses — the tools validate both, so a shape invented
// here would fail validation rather than exercise the seam.
function changeSetFixture(repoRoot: string): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id: 'cs_fixture',
    source: { kind: 'branch', repoRoot, baseRef: 'main', headRef: 'feature' },
    title: 'feature → main',
    baseRef: 'main',
    headSha: 'abc123def456',
    files: [
      {
        path: 'src/store.ts',
        status: 'modified',
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            lines: [
              { kind: 'context', text: 'export const store = {' },
              { kind: 'add', text: '  next: 1,' },
              { kind: 'context', text: '}' },
            ],
          },
        ],
      },
    ],
    stats: { files: 1, additions: 1, deletions: 0 },
    fetchedAt: '2026-07-26T12:00:00Z',
  }
}

function briefFixture(): ReviewBrief {
  return {
    schemaVersion: 1,
    changeSetId: 'cs_fixture',
    headSha: 'abc123def456',
    generatedAt: '2026-07-26T12:00:00Z',
    overview: {
      intent: 'Add a next counter to the store.',
      blastRadius: 'Touches the store shape alone.',
      readingGuide: 'Read the store.',
      complexity: 'low',
    },
    steps: [
      {
        id: 'step-store',
        order: 0,
        title: 'Store foundation',
        narrative: 'The store gains a next field.',
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
    ],
    knowledgeRefs: [],
    coverage: { assignedPaths: ['src/store.ts'], unassignedPaths: [] },
  }
}

main().catch((error) => {
  console.error('not ok - review/main seam')
  console.error(error)
  process.exit(1)
})
