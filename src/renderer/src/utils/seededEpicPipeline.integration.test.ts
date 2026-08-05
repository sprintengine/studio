/**
 * The seeded-epic pipeline, end to end (backlog epic `backlog-sourced-sprints`).
 *
 * Every piece of this epic has unit coverage of its own. What nothing covered is
 * the CHAIN — and the chain crosses a language boundary, which is exactly where a
 * fabricated fixture hides a break:
 *
 *   epic launch seeds children (T3, Python)
 *     -> one task per child carrying a backlogRef (T1, Python)
 *       -> module-level ownership serializes overlapping work (T2, Python)
 *         -> the projection carries all of it to the renderer (Python -> TS)
 *           -> each child's status follows ITS task, and lands with the sprint (T4, TS)
 *
 * So this test drives the REAL engine CLI against a real git project and a real
 * fixture epic, reads the REAL projection the engine writes, and feeds it to the
 * REAL renderer refresh tick. Nothing between the epic file and the child's new
 * status is stubbed. The one exception is named in UNCOVERED at the bottom.
 *
 * Run: npm run test:renderer:seeded-epic-pipeline
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type {
  BacklogItemLinkPayload,
  BacklogItemStatusPayload,
  BacklogObjectRecordPayload,
  BacklogObjectStorePayload,
} from '../../../shared/electron-api'
import { buildSprintEngineRunLink } from '../../../shared/backlog/sprintengine-links'
import type { SprintEngineState, Workspace } from '../types/workspace'
import {
  refreshSprintEngineWorkspaceProjection,
  type SprintEngineProjectionRefreshPorts,
} from './sprintengineProjectionRefresh'
import { isLandedSprintEngineRun } from './sprintengineBacklogLinks'

const repoRoot = process.cwd()
const legacyStoreFixture = join(repoRoot, 'tests', 'fixtures', 'legacy-run-store')

// The engine as the app and every agent terminal invoke it. The bash wrapper picks
// the repo-local .venv; Windows has no wrapper, so the tool module is run directly
// (mirroring `swarm_command` in tests/sprintengine_tool/helpers.py).
const engineCommand: readonly string[] =
  process.platform === 'win32'
    ? ['python', join(repoRoot, 'scripts', 'sprintengine_tool.py')]
    : [join(repoRoot, 'scripts', 'sprintengine')]

// --- the fixture epic ---------------------------------------------------------
//
// Four children, shaped to exercise every edge the graph can carry:
//   checkout-total  -> src/checkout       ]- modules OVERLAP (containment)
//   checkout-tax    -> src/checkout/tax   ]
//   mailer          -> src/mailer          - disjoint from both
//   docs-pricing    -> docs                - disjoint, but authored `dependsOn`
const EPIC_PATH = 'backlog/epics/delivery.md'
const CHILD_TOTAL = 'backlog/checkout-total.md'
const CHILD_TAX = 'backlog/checkout-tax.md'
const CHILD_MAILER = 'backlog/mailer-templates.md'
const CHILD_DOCS = 'backlog/docs-pricing.md'
const CHILDREN = [CHILD_TOTAL, CHILD_TAX, CHILD_MAILER, CHILD_DOCS] as const

type Json = Record<string, unknown>

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function runEngine(cwd: string, statePath: string, args: string[]): string {
  const [command, ...prefix] = engineCommand
  return execFileSync(command, [...prefix, '--state', statePath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The engine CLI, as an agent or the app calls it. Throws with the tool's own message. */
function engine(cwd: string, statePath: string, ...args: string[]): Json {
  return JSON.parse(runEngine(cwd, statePath, args)) as Json
}

/** A CLI call expected to be refused; returns the refusal text (stdout + stderr). */
function engineRefusal(cwd: string, statePath: string, ...args: string[]): string {
  try {
    runEngine(cwd, statePath, args)
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  throw new assert.AssertionError({ message: `engine ${args.join(' ')} was expected to be refused` })
}

function write(root: string, relativePath: string, body: string): void {
  const absolute = join(root, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, body, 'utf8')
}

/** A child item's title: its first `# Heading`, which is what the task takes. */
function itemTitle(root: string, relativePath: string): string {
  const heading = readFileSync(join(root, relativePath), 'utf8')
    .split('\n')
    .find((line) => line.startsWith('# '))
  assert.ok(heading, `${relativePath} has no title heading`)
  return heading.slice(2).trim()
}

function makeGitProject(root: string): void {
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Sprint Engine Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'checkout', '-q', '-b', 'main')
  write(root, 'README.md', 'seed\n')
}

function makeFixtureEpic(root: string): void {
  write(root, EPIC_PATH, '---\ntype: epic\n---\n\n# Delivery\n\nThe epic.\n')
  write(root, CHILD_TOTAL, '---\nepic: delivery\nstatus: ready\n---\n\n# Checkout total\n')
  write(root, CHILD_TAX, '---\nepic: delivery\nstatus: idea\n---\n\n# Checkout tax\n')
  write(root, CHILD_MAILER, '---\nepic: delivery\nstatus: ready\n---\n\n# Mailer templates\n')
  // The authored dependency axis: frontmatter the coordinator reproduces verbatim.
  write(
    root,
    CHILD_DOCS,
    `---\nepic: delivery\nstatus: ready\ndependsOn:\n  - ${CHILD_TOTAL}\n---\n\n# Docs pricing\n`,
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'seed the epic')
}

/**
 * Launch the run the way the desktop epic launch does: a root source with
 * `planKind: epic` and a bundle whose child entries are marked as children.
 * Worktree mode, because that is where module ownership is load-bearing and where
 * "landed" means a merged branch rather than a finished run.
 */
function launchEpicRun(
  root: string,
  statePath: string,
  children: readonly string[],
  intake: 'direct' | 'planned' = 'planned',
): Json {
  return engine(
    root,
    statePath,
    'init',
    '--name', 'delivery',
    '--goal', 'Deliver the epic',
    // The walk below plays the COORDINATOR sequencing the children, so it asks for
    // the planning intake by name. An epic source otherwise defaults to `direct`
    // (MC-2128), where the engine mints the same graph itself and no gate exists;
    // `testDirectEpicImportPipeline` walks that path.
    '--intake', intake,
    '--use-worktrees', 'true',
    '--agent', 'developer:developer-1',
    '--agent', 'developer:developer-2',
    '--agent', 'developer:developer-3',
    '--source-json', JSON.stringify({
      kind: 'markdown', origin: 'reference', path: EPIC_PATH, planKind: 'epic',
    }),
    '--source-bundle-json', JSON.stringify([
      ...children.map((path) => ({ kind: 'generic_context', origin: 'reference', path, epicChild: true })),
      // A mockup rides the same bundle and is deliberately NOT a child.
      { kind: 'html_mockup', origin: 'reference', path: 'backlog/mockups/checkout.html' },
    ]),
  )
}

type ProjectionTask = {
  id: string
  title: string
  status: string
  description?: string
  acceptanceCriteria?: string[]
  ownedPaths?: string[]
  dependsOn?: string[]
  backlogRef?: { projectRelativePath: string; displayKey?: string }
}

function projection(root: string, statePath: string): Json & { tasks: ProjectionTask[]; run: Json } {
  return engine(root, statePath, 'projection') as Json & { tasks: ProjectionTask[]; run: Json }
}

function taskById(tasks: ProjectionTask[], id: string): ProjectionTask {
  const found = tasks.find((task) => task.id === id)
  assert.ok(found, `projection is missing task ${id}`)
  return found
}

// --- the renderer side --------------------------------------------------------

/**
 * The Backlog object store an epic launch leaves behind, built with the SAME
 * shared link builder both launch writers use (`buildSprintEngineRunLink`), so the
 * links the tick reads here are the links the product writes.
 */
function launchedStore(input: {
  runRelativePath: string
  childStatuses: Record<string, BacklogItemStatusPayload>
}): BacklogObjectStorePayload {
  const epicRecord: BacklogObjectRecordPayload = {
    id: 'epic',
    source: { type: 'file', relativePath: EPIC_PATH },
    metadata: {},
    // The launching item's own link: run-level, `active`, no priorStatus.
    links: [buildSprintEngineRunLink({ teamSlug: 'delivery', runRelativePath: input.runRelativePath })],
  }
  return {
    schemaVersion: 1,
    items: [
      epicRecord,
      ...CHILDREN.map((relativePath): BacklogObjectRecordPayload => ({
        id: relativePath,
        source: { type: 'file', relativePath },
        status: input.childStatuses[relativePath],
        metadata: {},
        links: [buildSprintEngineRunLink({
          teamSlug: 'delivery',
          runRelativePath: input.runRelativePath,
          status: 'pending',
          priorStatus: input.childStatuses[relativePath],
        })],
      })),
    ],
  }
}

type BacklogWrite = {
  relativePath: string
  link: BacklogItemLinkPayload
  status?: BacklogItemStatusPayload
}

function workspaceFor(root: string, statePath: string): Workspace {
  return {
    id: 'workspace-1',
    name: 'Delivery',
    folderPath: root,
    mode: 'sprintengine',
    agents: {},
    layoutModel: null,
    sprintEngineContext: { statePath, teamSlug: 'delivery', teamName: 'Delivery' },
    sprintEngineState: null,
  } as unknown as Workspace
}

/**
 * One real projection-refresh tick against the run's real projection on disk.
 * Returns every Backlog write it performed — the child status propagation, observed
 * at the seam that actually performs it.
 */
async function tick(input: {
  root: string
  statePath: string
  store: BacklogObjectStorePayload
}): Promise<{ writes: BacklogWrite[]; state: SprintEngineState }> {
  const writes: BacklogWrite[] = []
  const applied: SprintEngineState[] = []
  const diagnostics: string[] = []
  const ports: SprintEngineProjectionRefreshPorts = {
    // The real projection the engine just wrote, read through the real CLI.
    readSprintEngineProjection: async () => ({
      ok: true,
      data: projection(input.root, input.statePath),
      token: undefined,
    }),
    setSprintEngineState: (_workspaceId, state) => {
      if (state) applied.push(state)
    },
    applySprintEngineAutomationEvent: () => {},
    readBacklogObjectStore: async () => ({ ok: true, store: input.store }),
    addOrUpdateBacklogLink: async (args) => {
      writes.push({
        relativePath: args.relativePath,
        link: args.link,
        status: args.status as BacklogItemStatusPayload | undefined,
      })
      return { ok: true, store: input.store }
    },
    publishDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic.message)
    },
    tearDownCompletedRunAgents: async () => {},
    setCompletionTeardownAt: () => {},
    now: () => 1000,
  }

  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspaceFor(input.root, input.statePath),
    tokens: new Map(),
    cause: 'manual',
    force: true,
    ports,
  })
  assert.equal(result.status, 'changed', `projection tick failed: ${JSON.stringify(result)}`)
  assert.deepEqual(diagnostics, [], 'a healthy tick raises no diagnostics')
  assert.ok(applied[0], 'the tick applied no state')
  return { writes, state: applied[0] }
}

/** Fold a tick's writes into the store, the way the Backlog service would. */
function applyWrites(store: BacklogObjectStorePayload, writes: BacklogWrite[]): BacklogObjectStorePayload {
  const next: BacklogObjectStorePayload = JSON.parse(JSON.stringify(store))
  for (const write of writes) {
    const record = next.items.find((item) => item.source.relativePath === write.relativePath)
    if (!record) continue
    record.links = (record.links ?? []).map((link) => (link.id === write.link.id ? write.link : link))
    if (write.status) record.status = write.status
  }
  return next
}

function childWrites(writes: BacklogWrite[]): BacklogWrite[] {
  return writes.filter((write) => write.relativePath !== EPIC_PATH)
}

function writeFor(writes: BacklogWrite[], relativePath: string): BacklogWrite | undefined {
  return writes.find((write) => write.relativePath === relativePath)
}

// --- the walk -----------------------------------------------------------------

async function testSeededEpicPipeline(root: string): Promise<void> {
  const statePath = join(root, '.multi-code', 'sprintengine', 'delivery', 'run.yaml')
  const runRelativePath = '.multi-code/sprintengine/delivery/run.yaml'
  makeGitProject(root)
  makeFixtureEpic(root)

  // 1. SEEDING — the launch marks the epic's children as the work list, and the
  //    plan gate directs the coordinator to sequence them rather than re-author.
  const launched = launchEpicRun(root, statePath, CHILDREN)
  const planTask = launched.planTask as {
    description: string
    acceptanceCriteria: string[]
    implementationNotes: string[]
  }
  for (const child of CHILDREN) {
    assert.ok(
      planTask.description.includes(`Epic child item (Context): read \`${child}\``),
      `the plan gate does not enumerate ${child} as a child`,
    )
  }
  assert.ok(
    !planTask.description.includes('Epic child item (Context): read `backlog/mockups/checkout.html`'),
    'the mockup riding the bundle must stay reading material, not work',
  )
  const acceptance = planTask.acceptanceCriteria.join(' ')
  assert.ok(acceptance.includes('Exactly one task is minted per open child item'),
    'the gate must direct one task per child')
  assert.ok(acceptance.includes('no minted task declares a file path'),
    'the gate must direct modules, never files')

  // Child status has exactly ONE writer, and it is the app (steps 5-7 below).
  // A directive telling the planner to mint a task that writes `status:` into the
  // child items is a second writer racing it — and a wrong one, because an agent
  // writes at run COMPLETION, before the branch has merged, and an item that
  // already reads `completed` is then immune to both the landing pass and the
  // cancel restore. Asserted on the whole gate, not one phrase, so a reworded
  // instruction cannot slip back in.
  const gateText = [planTask.description, ...planTask.acceptanceCriteria, ...planTask.implementationNotes].join('\n')
  assert.ok(
    !/status:\s*completed/i.test(gateText),
    'the plan gate must not instruct an agent to write child item status; the run owns it',
  )

  // 2. MINTING — one task per child, each pointing at its item, each declaring
  //    modules. This is the coordinator's output: the engine cannot infer modules,
  //    so the test plays the coordinator and the engine's rules are what is asserted.
  // Titles come from the items, read off the fixture files rather than retyped, so
  // "takes its title from the item" is asserted against the item and not against a
  // literal that could drift from it.
  engine(root, statePath, 'plan', 'add-task', '--task-id', 'T1', '--title', itemTitle(root, CHILD_TOTAL),
    '--role', 'developer', '--path', 'src/checkout', '--backlog-ref', CHILD_TOTAL, '--backlog-key', 'MC-2101')
  engine(root, statePath, 'plan', 'add-task', '--task-id', 'T2', '--title', itemTitle(root, CHILD_TAX),
    '--role', 'developer', '--path', 'src/checkout/tax', '--backlog-ref', CHILD_TAX)
  engine(root, statePath, 'plan', 'add-task', '--task-id', 'T3', '--title', itemTitle(root, CHILD_MAILER),
    '--role', 'developer', '--path', 'src/mailer', '--backlog-ref', CHILD_MAILER)
  engine(root, statePath, 'plan', 'add-task', '--task-id', 'T4', '--title', itemTitle(root, CHILD_DOCS),
    '--role', 'developer', '--path', 'docs', '--backlog-ref', CHILD_DOCS, '--depends-on', 'T1')

  // One task per item: a second task pointing at an already-delivered child is
  // refused, naming the task that already holds it. This is the invariant the
  // child -> task binding below depends on being able to resolve unambiguously.
  const duplicate = engineRefusal(root, statePath, 'plan', 'add-task', '--task-id', 'T5',
    '--title', 'Checkout total again', '--role', 'developer', '--path', 'src/other',
    '--backlog-ref', CHILD_TOTAL)
  assert.ok(duplicate.includes(CHILD_TOTAL) && duplicate.includes('T1'), duplicate)

  // Modules, never files: a path that resolves to an existing regular file is
  // refused with the directory it should have declared instead.
  const filePath = engineRefusal(root, statePath, 'plan', 'add-task', '--task-id', 'T6',
    '--title', 'A file', '--role', 'developer', '--path', 'README.md')
  assert.ok(filePath.includes('README.md') && filePath.includes('is a file'), filePath)

  // 3. GRAPH SHAPE — read back off the real projection, not off the write calls.
  const minted = projection(root, statePath).tasks
  assert.deepEqual(
    minted.filter((task) => task.id !== 'T0').map((task) => task.backlogRef?.projectRelativePath),
    [...CHILDREN],
    'exactly one task per child, each carrying its own item',
  )
  assert.equal(taskById(minted, 'T1').backlogRef?.displayKey, 'MC-2101', 'the human key rides the pointer')
  // Each card is titled from the item it points at, not from anything the planner
  // invented: read the title back off the file the task's own backlogRef names.
  for (const task of minted.filter((candidate) => candidate.backlogRef)) {
    assert.equal(
      task.title,
      itemTitle(root, task.backlogRef!.projectRelativePath),
      `${task.id} is not titled from ${task.backlogRef!.projectRelativePath}`,
    )
  }
  for (const id of ['T1', 'T2', 'T3', 'T4']) {
    const task = taskById(minted, id)
    assert.equal(task.description, '', `${id} must carry no description — the item is the spec`)
    assert.deepEqual(task.acceptanceCriteria, [], `${id} must carry no acceptance criteria`)
    assert.ok((task.ownedPaths ?? []).length > 0, `${id} declares no modules`)
    for (const owned of task.ownedPaths ?? []) {
      const resolved = join(root, owned)
      assert.ok(
        !existsSync(resolved) || statSync(resolved).isDirectory(),
        `${id} declares a file path rather than a module: ${owned}`,
      )
    }
  }
  // The authored `dependsOn` frontmatter, reproduced verbatim as a graph edge.
  assert.deepEqual(taskById(minted, 'T4').dependsOn, ['T1'], 'the authored dependency edge is missing')
  // The overlapping pair carries NO authored edge here, on purpose: the engine's
  // dispatch guard must hold the invariant even when the coordinator forgot it.
  assert.deepEqual(taskById(minted, 'T2').dependsOn, ['T0'],
    'the overlapping pair must carry only the plan gate, so the guard below is what is under test')

  // 4. OWNERSHIP AT DISPATCH — disjoint modules run together, overlapping ones
  //    never do, and the blocked task says which task holds which module.
  engine(root, statePath, 'task', 'status', '--task-id', 'T0', '--status', 'done', '--id', 'architect-1')
  const first = engine(root, statePath, 'task', 'next', '--role', 'developer', '--id', 'developer-1')
  assert.equal((first.task as Json).id, 'T1', 'the first ready task claims normally')
  // developer-2 skips the module-blocked T2 and takes the disjoint T3 instead:
  // a held module must not stall the queue behind it.
  const second = engine(root, statePath, 'task', 'next', '--role', 'developer', '--id', 'developer-2')
  assert.equal((second.task as Json).id, 'T3', 'disjoint modules must run concurrently')
  const blocked = engine(root, statePath, 'task', 'next', '--role', 'developer', '--id', 'developer-3')
  assert.equal(blocked.claimed, false, 'overlapping modules must never hold leases at the same time')
  assert.deepEqual(
    { taskId: (blocked.blocker as Json).taskId, module: (blocked.blocker as Json).module },
    { taskId: 'T1', module: 'src/checkout' },
    'the wait reason must name the task holding the module',
  )
  // The two axes are independent, and the projection shows both: T2 is `ready` and
  // held back only by its module, while T4 — whose `docs` module collides with
  // nothing — is not even ready, because the authored `dependsOn` edge gates it.
  // Without the edge T4 would have been claimed above instead of being refused.
  assert.deepEqual(
    projection(root, statePath).tasks
      .filter((task) => ['T2', 'T4'].includes(task.id))
      .map((task) => [task.id, task.status]),
    [['T2', 'ready'], ['T4', 'todo']],
    'the authored dependency edge must gate T4 while T1 is unfinished',
  )

  // 5. STATUS ON CLAIM — each child moves only as ITS task claims.
  const store0 = launchedStore({
    runRelativePath,
    childStatuses: {
      [CHILD_TOTAL]: 'ready', [CHILD_TAX]: 'idea', [CHILD_MAILER]: 'ready', [CHILD_DOCS]: 'ready',
    },
  })
  const claimTick = await tick({ root, statePath, store: store0 })
  assert.deepEqual(
    childWrites(claimTick.writes).map((write) => [write.relativePath, write.link.status, write.status]),
    [
      // Every child binds to its task (the Epic tab draws that edge even for an
      // unstarted child); only the two whose tasks claimed move status.
      [CHILD_TOTAL, 'active', 'in_progress'],
      [CHILD_TAX, 'pending', undefined],
      [CHILD_MAILER, 'active', 'in_progress'],
      [CHILD_DOCS, 'pending', undefined],
    ],
    'a child must move on its own task claiming, not on run start',
  )
  assert.deepEqual(
    childWrites(claimTick.writes).map((write) => write.link.target.taskId),
    ['T1', 'T2', 'T3', 'T4'],
    'each child binds to the task whose backlogRef names it',
  )
  assert.equal(writeFor(claimTick.writes, EPIC_PATH)?.status, undefined,
    'the epic derives its status from its children and is never written one')
  const store1 = applyWrites(store0, claimTick.writes)

  // 6. FINISHED BUT UNMERGED — every task done, the run complete, the branch still
  //    out. The children must stay in flight: there is no point completing an item
  //    that sits on a branch.
  const worktree = join(root, '.multi-code', 'sprintengine', 'delivery', 'worktree')
  const finish = (taskId: string, agentId: string, module: string): void => {
    write(worktree, `${module}/impl.ts`, `export const ${taskId} = true\n`)
    engine(root, statePath, 'task', 'publish', '--task-id', taskId, '--id', agentId,
      '--summary', `Implemented ${taskId}.`)
    engine(root, statePath, 'task', 'advance', '--task-id', taskId, '--id', agentId,
      '--phase', 'review', '--outcome', 'pass', '--summary', `Reviewed the ${taskId} diff.`)
  }
  finish('T1', 'developer-1', 'src/checkout')
  finish('T3', 'developer-2', 'src/mailer')
  // The module frees with the task that held it, and the dependency edge opens too.
  assert.equal((engine(root, statePath, 'task', 'next', '--role', 'developer',
    '--id', 'developer-3').task as Json).id, 'T2')
  finish('T2', 'developer-3', 'src/checkout/tax')
  assert.equal((engine(root, statePath, 'task', 'next', '--role', 'developer',
    '--id', 'developer-1').task as Json).id, 'T4')
  finish('T4', 'developer-1', 'docs')

  const unmergedTick = await tick({ root, statePath, store: store1 })
  assert.equal(isLandedSprintEngineRun(unmergedTick.state), false,
    'a completed run on an unmerged branch has not landed')
  for (const write of childWrites(unmergedTick.writes)) {
    assert.equal(write.link.status, 'active', `${write.relativePath} must stay in flight until the branch merges`)
    assert.notEqual(write.status, 'completed', `${write.relativePath} must not complete before the merge`)
  }
  // The two children whose tasks had not claimed on the earlier tick move now.
  assert.deepEqual(
    childWrites(unmergedTick.writes)
      .filter((write) => write.status !== undefined)
      .map((write) => [write.relativePath, write.status]),
    [[CHILD_TAX, 'in_progress'], [CHILD_DOCS, 'in_progress']],
  )
  const store2 = applyWrites(store1, unmergedTick.writes)

  // 7. LANDED — the branch actually merges (real git; the engine resolves it by
  //    branch ancestry, no GitHub involved) and every child completes.
  git(root, 'merge', '-q', '--no-ff', '-m', 'Merge the run branch', 'sprintengine/delivery')
  const prStatus = engine(root, statePath, 'vcs', 'pr-status')
  assert.equal(prStatus.pullRequestState, 'merged', 'the engine did not observe the merge')

  const landedTick = await tick({ root, statePath, store: store2 })
  assert.equal(isLandedSprintEngineRun(landedTick.state), true, 'a merged completed run has landed')
  assert.deepEqual(
    childWrites(landedTick.writes).map((write) => [write.relativePath, write.link.status, write.status]),
    [
      [CHILD_TOTAL, 'completed', 'completed'],
      [CHILD_TAX, 'completed', 'completed'],
      [CHILD_MAILER, 'completed', 'completed'],
      [CHILD_DOCS, 'completed', 'completed'],
    ],
    'merging the sprint completes every child',
  )
  assert.equal(writeFor(landedTick.writes, EPIC_PATH)?.status, undefined,
    'even on landing, the epic file is never written a status')
}

/**
 * Cancelling restores every non-completed child to the status it held before the
 * sprint — and never un-finishes one that already landed. Its own run, because
 * cancel is terminal.
 */
async function testCancelRestoresPriorStatus(root: string): Promise<void> {
  const statePath = join(root, '.multi-code', 'sprintengine', 'delivery', 'run.yaml')
  const runRelativePath = '.multi-code/sprintengine/delivery/run.yaml'
  makeGitProject(root)
  makeFixtureEpic(root)
  launchEpicRun(root, statePath, [CHILD_TOTAL, CHILD_TAX, CHILD_MAILER, CHILD_DOCS])
  engine(root, statePath, 'plan', 'add-task', '--task-id', 'T1', '--title', 'Checkout total',
    '--role', 'developer', '--path', 'src/checkout', '--backlog-ref', CHILD_TOTAL)
  engine(root, statePath, 'plan', 'add-task', '--task-id', 'T2', '--title', 'Checkout tax',
    '--role', 'developer', '--path', 'src/checkout/tax', '--backlog-ref', CHILD_TAX)
  engine(root, statePath, 'plan', 'add-task', '--task-id', 'T3', '--title', 'Mailer templates',
    '--role', 'developer', '--path', 'src/mailer', '--backlog-ref', CHILD_MAILER)
  engine(root, statePath, 'plan', 'add-task', '--task-id', 'T4', '--title', 'Docs pricing',
    '--role', 'developer', '--path', 'docs', '--backlog-ref', CHILD_DOCS)
  engine(root, statePath, 'task', 'status', '--task-id', 'T0', '--status', 'done', '--id', 'architect-1')
  // Three children start (checkout-total, mailer, docs); checkout-tax never does —
  // its module is held by checkout-total, so it is still `idea` when the cancel lands.
  for (const agentId of ['developer-1', 'developer-2', 'developer-3']) {
    engine(root, statePath, 'task', 'next', '--role', 'developer', '--id', agentId)
  }

  const store = launchedStore({
    runRelativePath,
    childStatuses: {
      [CHILD_TOTAL]: 'ready', [CHILD_TAX]: 'idea', [CHILD_MAILER]: 'ready', [CHILD_DOCS]: 'ready',
    },
  })
  const startTick = await tick({ root, statePath, store })
  assert.deepEqual(
    childWrites(startTick.writes).map((write) => [write.relativePath, write.status]),
    [[CHILD_TOTAL, 'in_progress'], [CHILD_TAX, undefined], [CHILD_MAILER, 'in_progress'], [CHILD_DOCS, 'in_progress']],
    'the module-blocked child must not have started',
  )
  const started = applyWrites(store, startTick.writes)
  // One child reached `completed` before the cancel; it must not be un-finished.
  const finished = started.items.find((item) => item.source.relativePath === CHILD_MAILER)
  assert.ok(finished)
  finished.status = 'completed'

  engine(root, statePath, 'cancel', '--id', 'user')
  const canceled = await tick({ root, statePath, store: started })
  assert.deepEqual(
    childWrites(canceled.writes).map((write) => [write.relativePath, write.link.status, write.status]),
    [
      // Back to the status each held before the sprint — `ready`, not a blanket
      // default, and never `completed`.
      [CHILD_TOTAL, 'canceled', 'ready'],
      // Never moved (its task never claimed), so there is nothing to put back: the
      // restore is a repair, not a rewrite of every child on the epic.
      [CHILD_TAX, 'canceled', undefined],
      // Already completed: cancelling the rest of the sprint does not un-finish it.
      [CHILD_MAILER, 'canceled', undefined],
      [CHILD_DOCS, 'canceled', 'ready'],
    ],
    'cancel must put every non-completed child back where it started',
  )
  for (const write of childWrites(canceled.writes)) {
    assert.equal(write.link.priorStatus, undefined,
      'the restore target is consumed, so a later tick cannot restore a second time')
  }

  // A second tick against the restored store writes nothing: the restore is
  // idempotent, not a per-tick rewrite of the child's status.
  const settled = await tick({ root, statePath, store: applyWrites(started, canceled.writes) })
  assert.deepEqual(childWrites(settled.writes), [], 'a settled cancel writes nothing on the next tick')
}

/**
 * A run store written BEFORE this epic — real, captured from a shipped run, with
 * file-level `ownedPaths` and no `backlogRef` anywhere — still loads, dispatches
 * and commits. No migration step, and `schemaVersion` is untouched.
 *
 * The only edit made to the captured store is fixture surgery so it has something
 * left to dispatch: one already-done task is moved back to `todo` and the run to
 * `executing`. Its `ownedPaths` are asserted byte-identical to the captured file.
 */
function testPreChangeRunStoreStillWorks(root: string): void {
  const teamSlug = 'mobile-relay-traffic-efficiency2'
  makeGitProject(root)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'seed')

  const teamDir = join(root, '.multi-code', 'sprintengine', teamSlug)
  mkdirSync(dirname(teamDir), { recursive: true })
  cpSync(legacyStoreFixture, teamDir, { recursive: true })
  rmSync(join(teamDir, 'README.md'))
  const statePath = join(teamDir, 'run.yaml')

  const capturedTaskPath = join(teamDir, 'tasks', 'done', '0002-T1.json')
  const captured = JSON.parse(readFileSync(capturedTaskPath, 'utf8')) as Json
  const capturedOwnedPaths = captured.ownedPaths as string[]
  assert.ok(
    capturedOwnedPaths.some((path) => path.endsWith('.ts')),
    'the fixture no longer carries file-level ownedPaths, so it proves nothing',
  )
  assert.equal('backlogRef' in captured, false, 'the fixture predates backlogRef')

  const raw = readFileSync(statePath, 'utf8')
  const schemaLine = raw.split('\n').find((line) => line.startsWith('schemaVersion:'))
  writeFileSync(statePath, raw.replace(/^status: completed$/m, 'status: executing'), 'utf8')
  mkdirSync(join(teamDir, 'tasks', 'todo'), { recursive: true })
  writeFileSync(
    join(teamDir, 'tasks', 'todo', '0002-T1.json'),
    JSON.stringify({ ...captured, status: 'todo', ownerAgentId: null, lease: undefined, phases: undefined }, null, 2),
    'utf8',
  )
  rmSync(capturedTaskPath)
  git(root, 'worktree', 'add', '-q', join(teamDir, 'worktree'), '-b', `sprintengine/${teamSlug}`)

  // Loads, with its file-level paths intact. A v4 store is MIGRATED on read
  // (`MIGRATABLE_RUN_SCHEMA_VERSION = 4`) and the migration is persisted, so both
  // the projection and the file carry the current version afterwards. The
  // migration promise is that the store keeps working — dispatching and committing
  // below — not that its bytes are frozen.
  const loaded = projection(root, statePath)
  assert.equal((loaded.run as Json).schemaVersion, 5)
  assert.equal(schemaLine, 'schemaVersion: 4', 'the fixture must start pre-migration to prove anything')
  assert.equal(
    readFileSync(statePath, 'utf8').split('\n').find((line) => line.startsWith('schemaVersion:')),
    'schemaVersion: 5',
    'a pre-change store is migrated forward on load',
  )
  assert.deepEqual(taskById(loaded.tasks, 'T1').ownedPaths, capturedOwnedPaths,
    'a pre-change store\'s file-level ownedPaths must survive the read verbatim')

  // Dispatches.
  const claim = engine(root, statePath, 'task', 'next', '--role', 'developer', '--id', 'developer-1')
  assert.equal(claim.claimed, true, `a pre-change store failed to dispatch: ${JSON.stringify(claim)}`)
  assert.equal((claim.task as Json).id, 'T1')

  // And commits. Since MC-2127 the store's file-level entries no longer LIMIT the
  // commit: scope is what the task changed, minus whatever a live sibling claims.
  // T1 is the only task running, so its own file and the sibling beside it both
  // land — the migration promise is that a pre-change store loses nothing, and it
  // now gains the path the old contract would have silently dropped.
  const worktree = join(teamDir, 'worktree')
  write(worktree, 'src/main/mobile/sprintengine/snapshot.ts', 'export const snapshot = 1\n')
  write(worktree, 'src/main/mobile/other/stray.ts', 'export const stray = 1\n')
  const committed = engine(root, statePath, 'vcs', 'commit', '--task-id', 'T1', '--id', 'developer-1')
  assert.equal(committed.committed, true, JSON.stringify(committed))
  assert.deepEqual(
    git(worktree, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(),
    ['src/main/mobile/other/stray.ts', 'src/main/mobile/sprintengine/snapshot.ts'],
    "a pre-change store's declared path still commits, and nothing beside it is dropped",
  )
  assert.equal(
    git(worktree, 'status', '--porcelain').trim(),
    '',
    'nothing is left uncommitted for the run to strand',
  )
}

// --- what this test does NOT cover --------------------------------------------
//
// Named rather than quietly implied, because "the pipeline is covered" would
// otherwise read as covering these too:
//
//  - THE COORDINATOR'S JUDGEMENT. Which modules a child touches, and which pairs
//    it decides to serialize, is an LLM's inference from the item text. The test
//    plays the coordinator (minting the tasks a correct one would) and asserts the
//    plan-gate DIRECTIVE that instructs it plus the engine invariants that hold
//    whatever it does — including, deliberately, when it omits the ordering edge.
//    Whether a live planner obeys the directive is not automatable here.
//  - THE TWO SURFACES. The Epic tab and the task timeline render this data; T8
//    owns their visual review.
//  - THE DESKTOP LAUNCH WRITER. `NewWorkspacePanel` fans the child links out in
//    React; this test builds the same links through the shared builder both
//    writers call. The main-process writer is covered by
//    `src/main/mobile/sprintengine/command.test.ts`.
//  - A GITHUB PULL REQUEST. Landing is exercised through a real `git merge` and the
//    engine's branch-ancestry detection, which is the same signal a merged PR
//    produces. The `gh pr view` arm needs a live GitHub repo.

/**
 * The same epic, launched the way the app now launches one by default (MC-2128):
 * the engine imports the graph at init and no planning agent runs.
 *
 * The walk above proves the coordinator-planned path still works. This proves the
 * engine reaches the same place for free — one task per OPEN child, titled from
 * the item, carrying its pointer, with the authored dependency edge reproduced —
 * and that everything downstream of the graph (dispatch, and the app's one-way
 * child status propagation) is indifferent to which path minted it.
 */
async function testDirectEpicImportPipeline(root: string): Promise<void> {
  const statePath = join(root, '.multi-code', 'sprintengine', 'delivery', 'run.yaml')
  const runRelativePath = '.multi-code/sprintengine/delivery/run.yaml'
  makeGitProject(root)
  makeFixtureEpic(root)

  const launched = launchEpicRun(root, statePath, CHILDREN, 'direct')

  // No planning session: no gate task, no plan artifact, nothing for an agent to
  // be spawned against. This is the whole cost saving.
  assert.equal(launched.planTask, null, 'a direct run must mint no plan gate')
  assert.equal(launched.planArtifact, null, 'a direct run must mint no plan artifact')
  assert.equal(launched.intake, 'direct')

  // One task per OPEN child: the `idea` child is skipped, exactly as the planner
  // was told to skip it.
  const imported = projection(root, statePath).tasks
  assert.deepEqual(
    imported.map((task) => task.backlogRef?.projectRelativePath),
    [CHILD_TOTAL, CHILD_MAILER, CHILD_DOCS],
    'exactly one task per open child, in the epic order, skipping the idea',
  )
  for (const task of imported) {
    assert.equal(
      task.title,
      itemTitle(root, task.backlogRef!.projectRelativePath),
      `${task.id} is not titled from its item`,
    )
    assert.equal(task.description ?? '', '', `${task.id} must carry no description — the item is the spec`)
    assert.deepEqual(task.acceptanceCriteria ?? [], [], `${task.id} must carry no acceptance criteria`)
    // No declared modules: publish commits what the task changed (MC-2127).
    assert.deepEqual(task.ownedPaths ?? [], [], `${task.id} must declare no modules`)
  }

  // The authored `dependsOn` frontmatter, reproduced as a graph edge — the one
  // piece of the coordinator's job that was never judgement.
  const docsTask = imported.find((task) => task.backlogRef?.projectRelativePath === CHILD_DOCS)!
  const totalTask = imported.find((task) => task.backlogRef?.projectRelativePath === CHILD_TOTAL)!
  assert.deepEqual(docsTask.dependsOn, [totalTask.id], 'the authored dependency edge is missing')

  // The board opens claimable: no gate stands between init and the first worker.
  const first = engine(root, statePath, 'task', 'next', '--role', 'developer', '--id', 'developer-1')
  assert.equal(first.claimed, true, `the first worker must claim immediately: ${JSON.stringify(first)}`)
  assert.equal((first.task as Json).id, totalTask.id)

  // And the app's child status propagation is unchanged by the import path: the
  // claim above moves that child, and only that child.
  const store = launchedStore({
    runRelativePath,
    childStatuses: {
      [CHILD_TOTAL]: 'ready', [CHILD_TAX]: 'idea', [CHILD_MAILER]: 'ready', [CHILD_DOCS]: 'ready',
    },
  })
  const { writes } = await tick({ root, statePath, store })
  assert.equal(
    writeFor(writes, CHILD_TOTAL)?.status,
    'in_progress',
    'the claimed child moves to in_progress',
  )
  assert.equal(writeFor(writes, CHILD_MAILER)?.status, undefined, 'an unclaimed child must not move')
}

async function main(): Promise<void> {
  // Run from the repo root: the engine wrapper and the legacy fixture are both
  // resolved relative to it, and a wrong cwd would otherwise fail deep in a step.
  assert.ok(existsSync(engineCommand[engineCommand.length - 1]),
    `engine CLI not found at ${engineCommand.join(' ')} — run this from the repo root`)
  assert.ok(existsSync(legacyStoreFixture), `legacy run-store fixture missing at ${legacyStoreFixture}`)

  const scratch = mkdtempSync(join(tmpdir(), 'seeded-epic-pipeline-'))
  try {
    await testSeededEpicPipeline(join(scratch, 'pipeline'))
    await testDirectEpicImportPipeline(join(scratch, 'direct'))
    await testCancelRestoresPriorStatus(join(scratch, 'cancel'))
    testPreChangeRunStoreStillWorks(join(scratch, 'legacy'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log('seededEpicPipeline.integration.test.ts: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
