import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch'
import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import { runGitCommand } from '../git-utils'
import { WRITE_UP_ONLY_INSTRUCTION } from './actions/spawn-agent'
import { AutomationsEngine } from './engine'
import { RunWorktreeUnavailableError, createLocalAutomationExecutor, defaultCreateRunWorktree, type LocalAutomationExecutorOptions } from './executor-local'
import { AutomationsStore } from './store'

// The containment an unattended (`bypass`) automation run is supposed to
// have — a per-run worktree, a per-run branch, and a pull request nobody merges
// automatically — is a property of the run, not of the permission preset. These
// drive the REAL engine into the REAL executor and read the agent's working
// directory off the launch request, the recorded run, and the PR opener's call
// log, on each of the three start paths (schedule due-run, "Run now", trigger
// event) and on every way a run can end up without a worktree.

function workspace(id: string, folderPath: string | null, mode: Workspace['mode']): Workspace {
  return {
    id,
    name: id,
    mode,
    folderPath,
    templateId: 'standard-test',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  } as Workspace
}

function snapshot(workspaces: Workspace[]): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      workspaces,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [
        {
          id: 'primary',
          kind: 'primary',
          workspaceIds: workspaces.map((entry) => entry.id),
          activeWorkspaceId: workspaces[0]?.id ?? null,
          bounds: null,
          isMaximized: false,
          displayId: null,
          createdAt: 0,
          lastFocusedAt: 0,
        },
      ],
    },
  }
}

type PullRequestCall = { worktreePath: string; branch: string }

// Engine + executor wired together. `worktree` chooses how the run's isolation
// resolves: 'created' is the happy path, and the two failure modes are the ones
// the executor must keep apart in the run record.
type WorktreeOutcome = 'created' | 'not-a-git-repository' | 'creation-failed'

function harness(
  root: string,
  options: { triggerKind?: string; worktree?: WorktreeOutcome } = {}
) {
  const workspaces: Workspace[] = []
  const launches: AgentLaunchRequest[] = []
  const pullRequests: PullRequestCall[] = []
  // Workspace creation is a main-process port since MC-2158, not a renderer
  // request. It honours the mode the executor asks for: the default launch
  // route resolves an `automations-host` workspace, and a 'standard' stand-in
  // would never satisfy it.
  const createWorkspace: LocalAutomationExecutorOptions['createWorkspace'] = (input) => {
    const created = workspace('ws-host', input.folderPath ?? null, input.mode ?? 'standard')
    workspaces.push(created)
    return { ok: true, result: { workspace: created as never, windowId: 'primary', folderPath: input.folderPath ?? null, reused: false } }
  }

  // Agent launch is a main-process port since MC-2159, not a renderer request;
  // this stub stands in for the AgentLaunchService so the launch stays
  // observable at the same level of detail.
  const launchAgent = async (request: AgentLaunchRequest): Promise<AgentLaunchResult> => {
    launches.push(request)
    const target = workspaces.find((candidate) => candidate.id === request.workspaceId)
    if (!target) return { ok: false, code: 'unknown_workspace', message: 'unknown workspace' }
    const agentId = `agent-${launches.length}`
    target.agents[agentId] = { id: agentId, name: request.name ?? agentId, cli: request.cli ?? 'codex' } as Workspace['agents'][string]
    return {
      ok: true,
      workspaceId: request.workspaceId,
      agentId,
      sessionId: `session-${agentId}`,
      cli: request.cli ?? 'claude-code',
      executionId: `session-${agentId}`,
    }
  }

  const executor = createLocalAutomationExecutor({
    createWorkspace,
    launchAgent,
    getWorkspaceSyncSnapshot: () => snapshot(workspaces),
    sleep: async () => undefined,
    createRunWorktree: async (input) => {
      if (options.worktree === 'not-a-git-repository') {
        throw new RunWorktreeUnavailableError('not_a_git_repository', 'Choose a folder inside a Git repository.')
      }
      if (options.worktree === 'creation-failed') {
        throw new RunWorktreeUnavailableError('worktree_creation_failed', 'fatal: could not create work tree dir')
      }
      return { worktreePath: join(root, '.sprintengine/automations/worktrees', input.runId), branch: `automations/${input.runId}` }
    },
  })

  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-host', folderPath: root }],
    now: () => Date.parse('2026-07-30T02:00:00.000Z'),
    createRunId: () => 'run-1',
    runAutomation: executor,
    openRunPullRequest: async (input) => {
      pullRequests.push({ worktreePath: input.worktreePath, branch: input.branch })
      return { ok: true, url: 'https://example.invalid/pr/1', created: true }
    },
    ...(options.triggerKind
      ? { triggerProviders: [{ kind: options.triggerKind, configSchema: {}, subscribe: () => () => undefined }] }
      : {}),
  })

  return { engine, launches, pullRequests }
}

function scheduledDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'nightly-sweep',
    name: 'Nightly sweep',
    status: 'enabled',
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
    action: { kind: 'spawn-agent', config: { prompt: 'Sweep the repo.' } },
    nextRunAt: '2026-07-30T01:00:00.000Z',
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-07-29T09:00:00.000Z',
    updatedAt: '2026-07-29T09:00:00.000Z',
    ...overrides,
  } as AutomationDefinition
}

async function withStore(definition: AutomationDefinition): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-containment-'))
  const store = new AutomationsStore(root)
  const config = definition.action.config as Record<string, unknown>
  const created = await store.createDefinition({
    ...definition,
    action: { ...definition.action, config: { ...config, folderPath: root } },
  })
  assert.equal(created.ok, true, 'the definition is written to the store')
  return root
}

type StartPath = 'schedule' | 'run-now' | 'trigger'

type DispatchResult = {
  root: string
  launches: AgentLaunchRequest[]
  pullRequests: PullRequestCall[]
  run: AutomationRun
  engine: AutomationsEngine
}

// Drive one start path as far as it gets: a launch, or a run that never
// launched. Returns the run as it was recorded on disk, because that record —
// not the in-memory result — is what a person or a later reader actually sees.
async function dispatch(
  path: StartPath,
  definition: AutomationDefinition,
  worktree: WorktreeOutcome,
  existingRoot?: string
): Promise<DispatchResult> {
  const shaped = path === 'trigger'
    ? { ...definition, trigger: { kind: 'test-event', config: {} }, nextRunAt: null } as AutomationDefinition
    : path === 'run-now'
      ? { ...definition, nextRunAt: '2026-07-31T01:00:00.000Z' } as AutomationDefinition
      : definition
  const root = existingRoot ?? await withStore(shaped)
  const { engine, launches, pullRequests } = harness(root, {
    worktree,
    ...(path === 'trigger' ? { triggerKind: 'test-event' } : {}),
  })

  if (path === 'schedule') await engine.tick()
  if (path === 'run-now') {
    const result = await engine.runNow({ workspaceRoot: root, automationId: 'nightly-sweep' })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  if (path === 'trigger') {
    const delivered = await engine.deliverTriggerEvent({
      workspaceRoot: root,
      automationId: 'nightly-sweep',
      workspaceId: 'ws-host',
      event: { id: 'event-1', occurredAt: '2026-07-30T02:00:00.000Z', payload: {} },
    })
    assert.equal(delivered.ok, true, JSON.stringify(delivered))
  }

  const runs = await new AutomationsStore(root).listRuns('nightly-sweep')
  assert.equal(runs.ok, true, `${path}: the run history is readable`)
  assert.equal(runs.ok && runs.values.length, 1, `${path}: the run is recorded exactly once`)
  return { root, launches, pullRequests, run: (runs.ok ? runs.values[0] : undefined)!, engine }
}

// Drive one start path to a launch, then finalize the run as the agent-state
// frames would. Returns what the run actually got.
async function runToFinalize(
  path: StartPath,
  definition: AutomationDefinition,
  worktree: WorktreeOutcome
): Promise<{ root: string; launch: AgentLaunchRequest; pullRequests: PullRequestCall[]; run: AutomationRun }> {
  const { root, launches, pullRequests, engine } = await dispatch(path, definition, worktree)
  assert.equal(launches.length, 1, `the ${path} path fires exactly one launch`)
  const finalized = await engine.finalizeRun({
    workspaceRoot: root,
    automationId: 'nightly-sweep',
    runId: 'run-1',
    outcome: 'completed',
    workspaceId: 'ws-host',
  })
  assert.equal(finalized.ok, true, JSON.stringify(finalized))
  return { root, launch: launches[0]!, pullRequests, run: (finalized.ok ? finalized.run : undefined)! }
}

// The claimed containment, on every start path: the agent's cwd is the run's own
// worktree (never the user's checkout), the run carries its own branch, and the
// finalize opens a PR from that branch.
async function assertContainmentHoldsWhenTheWorktreeIsCreated(): Promise<void> {
  for (const path of ['schedule', 'run-now', 'trigger'] as const) {
    const { root, launch, pullRequests, run } = await runToFinalize(path, scheduledDefinition(), 'created')
    assert.equal(launch.permissionPreset, 'bypass', `${path}: launches unattended`)
    assert.equal(
      launch.worktreePath,
      join(root, '.sprintengine/automations/worktrees', 'run-1'),
      `${path}: the agent runs in the run's own worktree, not the user's checkout`
    )
    assert.equal(run.branch, 'automations/run-1', `${path}: the run carries its own branch`)
    assert.equal(run.isolation, 'worktree', `${path}: the record says the run was contained`)
    assert.deepEqual(
      pullRequests,
      [{ worktreePath: join(root, '.sprintengine/automations/worktrees', 'run-1'), branch: 'automations/run-1' }],
      `${path}: the finalize opens a PR from the run's branch`
    )
    await rm(root, { recursive: true, force: true })
  }
}

// A definition that opts out of isolation (`runInWorktree: false`, a switch the
// Automations editor offers) still launches on the unattended default: the agent
// runs with permissions bypassed directly in the user's checkout, the run has no
// branch, and the finalize opens no PR. That is the user's call to make — but
// the record has to say so, so an uncontained run is not read as a contained one
// later. Same on every start path.
async function assertOptOutRunsInTheCheckoutAndTheRecordSaysSo(): Promise<void> {
  for (const path of ['schedule', 'run-now', 'trigger'] as const) {
    const { root, launch, pullRequests, run } = await runToFinalize(
      path,
      scheduledDefinition({ runInWorktree: false }),
      'created'
    )
    assert.equal(launch.permissionPreset, 'bypass', `${path}: opting out still launches unattended`)
    assert.equal(launch.worktreePath, undefined, `${path}: the agent runs in the user's checkout`)
    assert.equal(run.status, 'completed', `${path}: an opt-out run still completes`)
    assert.equal(run.branch, undefined, `${path}: the run has no branch of its own`)
    assert.equal(run.pullRequestUrl, undefined, `${path}: the run has no pull request`)
    assert.equal(
      run.isolation,
      'workspace-checkout',
      `${path}: the record distinguishes this run from a contained one without re-reading the definition`
    )
    assert.match(
      run.summary ?? '',
      /workspace checkout \(no branch, no pull request\)/,
      `${path}: the run says in words where it ran`
    )
    assert.deepEqual(pullRequests, [], `${path}: the finalize opens no pull request`)
    await rm(root, { recursive: true, force: true })
  }
}

// The case nobody opted into: the run asked for isolation and could not get it.
// It must fail rather than fall back — no launch at all — and the blocked reason
// must say which of the two causes it was, because a folder that is not a git
// repository needs a different answer from a worktree that failed to create.
async function assertRunFailsClosedWhenTheWorktreeCannotBeCreated(): Promise<void> {
  const causes = [
    { worktree: 'not-a-git-repository' as const, expected: /is not a git repository/ },
    { worktree: 'creation-failed' as const, expected: /worktree creation failed: fatal: could not create work tree dir/ },
  ]
  for (const path of ['schedule', 'run-now', 'trigger'] as const) {
    for (const cause of causes) {
      const { root, launches, pullRequests, run } = await dispatch(path, scheduledDefinition(), cause.worktree)
      assert.deepEqual(launches, [], `${path}/${cause.worktree}: no agent is launched into the user's checkout`)
      assert.equal(run.status, 'blocked', `${path}/${cause.worktree}: the run fails closed`)
      assert.match(run.blockedReason ?? '', cause.expected, `${path}/${cause.worktree}: the cause is legible`)
      assert.doesNotMatch(
        run.blockedReason ?? '',
        cause.worktree === 'not-a-git-repository' ? /worktree creation failed/ : /is not a git repository/,
        `${path}/${cause.worktree}: the two causes do not read the same`
      )
      assert.equal(run.isolation, undefined, `${path}/${cause.worktree}: a run that never launched claims no isolation`)
      assert.equal(run.branch, undefined, `${path}/${cause.worktree}: no branch`)
      assert.deepEqual(pullRequests, [], `${path}/${cause.worktree}: no pull request`)
      await rm(root, { recursive: true, force: true })
    }
  }
}

// The classification above is only worth having if the real creator produces it,
// so exercise `defaultCreateRunWorktree` against real folders: one that is not a
// repository at all, and one where `git worktree add` genuinely fails because
// the run's branch is already checked out.
async function assertRealWorktreeFailuresAreClassified(): Promise<void> {
  const plainFolder = await realpath(await mkdtemp(join(tmpdir(), 'multicode-containment-plain-')))
  try {
    await assert.rejects(
      defaultCreateRunWorktree({ workspaceRoot: plainFolder, runId: 'run-1' }),
      (error: unknown) =>
        error instanceof RunWorktreeUnavailableError && error.reason === 'not_a_git_repository',
      'a folder outside a git repository is classified as such'
    )
  } finally {
    await rm(plainFolder, { recursive: true, force: true })
  }

  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'multicode-containment-repo-')))
  try {
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'Test'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      assert.ok((await runGitCommand(repoRoot, args)).ok, `git ${args.join(' ')}`)
    }
    await writeFile(join(repoRoot, 'seed.txt'), 'seed\n', 'utf8')
    assert.ok((await runGitCommand(repoRoot, ['add', 'seed.txt'])).ok)
    assert.ok((await runGitCommand(repoRoot, ['commit', '-qm', 'seed'])).ok)

    const created = await defaultCreateRunWorktree({ workspaceRoot: repoRoot, runId: 'run-1' })
    assert.equal(created.branch, 'automations/run-1', 'the happy path still returns the run branch')
    await assert.rejects(
      defaultCreateRunWorktree({ workspaceRoot: repoRoot, runId: 'run-1' }),
      (error: unknown) =>
        error instanceof RunWorktreeUnavailableError && error.reason === 'worktree_creation_failed',
      'a real worktree failure inside a repository is classified separately'
    )
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
}

// A definition stored before `autonomyDefault` was retired, whose author set it
// to `review_only`, must not quietly become a fixer. The intent moves to where
// the owner put it when the field was retired — the prompt — and nothing else
// about the record changes: it stays enabled, and neither the retired key nor
// the marker derived from it is written back.
async function assertLegacyReviewOnlyDefinitionKeepsItsIntent(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-containment-legacy-'))
  const definitionsDirectory = join(root, '.sprintengine', 'automations', 'definitions')
  await mkdir(definitionsDirectory, { recursive: true })
  const definitionPath = join(definitionsDirectory, 'nightly-sweep.json')
  const legacy = {
    ...scheduledDefinition(),
    action: { kind: 'spawn-agent', config: { prompt: 'Sweep the repo.', folderPath: root } },
    autonomyDefault: 'review_only',
  }
  await writeFile(definitionPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

  const { launches, run } = await dispatch('schedule', scheduledDefinition(), 'created', root)
  assert.equal(launches.length, 1, 'the legacy definition still runs')
  assert.ok(
    launches[0]!.prompt?.includes(WRITE_UP_ONLY_INSTRUCTION),
    `the launch prompt carries the write-up-only instruction, got: ${launches[0]!.prompt}`
  )
  assert.equal(run.status, 'running', 'the legacy run launched normally')

  const store = new AutomationsStore(root)
  const loaded = await store.getDefinition('nightly-sweep')
  assert.equal(loaded.ok, true, 'the legacy definition loads')
  assert.equal(loaded.ok && loaded.value.status, 'enabled', 'a legacy definition loads enabled, never auto-paused')

  // The run itself rewrote the definition (lastRunAt/lastRunId/nextRunAt), so
  // this is the write-back the retired field must not survive.
  const onDisk = JSON.parse(await readFile(definitionPath, 'utf8')) as Record<string, unknown>
  assert.equal(Object.hasOwn(onDisk, 'autonomyDefault'), false, 'the retired key is never written back')
  assert.equal(Object.hasOwn(onDisk, 'legacyWriteUpOnly'), false, 'nor is the marker derived from it')
  assert.equal(onDisk.lastRunId, 'run-1', 'the write that dropped it is a real one')
  await rm(root, { recursive: true, force: true })
}

async function main(): Promise<void> {
  await assertContainmentHoldsWhenTheWorktreeIsCreated()
  await assertOptOutRunsInTheCheckoutAndTheRecordSaysSo()
  await assertRunFailsClosedWhenTheWorktreeCannotBeCreated()
  await assertRealWorktreeFailuresAreClassified()
  await assertLegacyReviewOnlyDefinitionKeepsItsIntent()
  console.log('automations unattended containment tests passed')
}

void main()
