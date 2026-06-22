import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findSprintEngineRuntimeRoot } from './mcp-config-service'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'

// End-to-end self-heal validation (T3). Drives the REAL main-process auto-approval
// handler (createSprintEngineArtifactHandlers().reviewArtifact in auto-run mode)
// against a REAL on-disk run store and the REAL Python sprintengine.artifact.approve
// mutation — no mocked gate, no stubbed runMcpTool. Reproduces the original
// deadlock (a stale full-prefix draft duplicate + a bare-path ready_for_review
// real plan, both on the same gate task) and proves the fix self-heals under
// auto-approve: the real artifact approves on the first attempt, the gate task
// completes, and the stale duplicate ends superseded.

type SprintEngineArtifactSeed = {
  id: string
  kind: string
  title: string
  path: string
  status: string
  createdBy: string
  taskId: string
}

type SprintEngineTaskSeed = {
  id: string
  title: string
  role: string
  status: string
  ownerAgentId: string
  needsInput?: Record<string, unknown>
}

// The bundled runtime (worktree root with sprintengine_mcp + sprintengine_core)
// and its venv Python. The real path under test cannot be exercised without
// them, so fail loudly rather than silently degrading to a mock.
const runtimeRoot = findSprintEngineRuntimeRoot()
if (!runtimeRoot) {
  throw new Error('Sprint Engine runtime root not found (need sprintengine_mcp/ + sprintengine_core/). Run from the repo root.')
}

function resolvePythonExecutable(root: string): string {
  const venvPython = process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

const pythonExecutable = resolvePythonExecutable(runtimeRoot)

function pythonPathFor(workspaceRoot: string): string {
  return [runtimeRoot, workspaceRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
}

// Seed a real on-disk run store (run.yaml + projection.json + artifacts/*) via the
// real store library, so the legacy duplicate state — which registration dedup now
// prevents creating through `artifact add` — exists exactly as a pre-fix run would
// have persisted it. Mirrors the Python tests' _seed_plan_artifact fixture.
const SEED_SCRIPT = [
  'import json, sys',
  'from pathlib import Path',
  'from sprintengine_core import store',
  'payload = json.load(sys.stdin)',
  'store.sync_state_to_store(Path(payload["teamDir"]), payload["state"], state_path=Path(payload["statePath"]))',
].join('\n')

function seedRealStore(args: {
  teamDir: string
  workspaceRoot: string
  statePath: string
  name: string
  tasks: SprintEngineTaskSeed[]
  artifacts: SprintEngineArtifactSeed[]
}): void {
  const state = {
    sprintengine: { name: args.name, goal: `Validation ${args.name}`, status: 'executing' },
    agents: {},
    events: [],
    roles: {},
    tasks: args.tasks,
    artifacts: args.artifacts.map((artifact) => ({
      ...artifact,
      fingerprint: null,
      reviewHistory: [{ action: 'created', actor: artifact.createdBy }],
    })),
  }
  const result = spawnSync(pythonExecutable, ['-c', SEED_SCRIPT], {
    cwd: args.workspaceRoot,
    env: { ...process.env, PYTHONPATH: pythonPathFor(args.workspaceRoot) },
    input: JSON.stringify({ teamDir: args.teamDir, statePath: args.statePath, state }),
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Seeding the real store failed: ${result.stderr || result.stdout || 'unknown error'}`)
  }
}

async function createWorkspace(team: string): Promise<{ workspaceRoot: string; teamDir: string; statePath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-dedup-'))
  const teamDir = join(workspaceRoot, '.multi-code', 'sprintengine', team)
  await mkdir(teamDir, { recursive: true })
  return { workspaceRoot, teamDir, statePath: join(teamDir, 'run.yaml') }
}

function realHandlers() {
  return createSprintEngineArtifactHandlers({
    getAuthenticatedUserId: () => 'user-test',
    openExternal: async () => {},
  })
}

async function readProjection(teamDir: string): Promise<{
  tasks: Array<{ id: string; status: string }>
  artifacts: Array<{ id: string; status: string }>
}> {
  return JSON.parse(await readFile(join(teamDir, 'projection.json'), 'utf-8'))
}

function taskStatus(projection: { tasks: Array<{ id: string; status: string }> }, id: string): string | undefined {
  return projection.tasks.find((task) => task.id === id)?.status
}

function artifactStatus(
  projection: { artifacts: Array<{ id: string; status: string }> },
  id: string
): string | undefined {
  return projection.artifacts.find((artifact) => artifact.id === id)?.status
}

// AC: stale full-prefix draft duplicate + bare-path ready real plan on one gate
// task -> auto-approve approves the real plan on the first attempt, the gate task
// completes, and the stale duplicate ends superseded.
async function testAutoApproveSelfHealsStaleSameFileDuplicate(): Promise<void> {
  const team = 'self-heal'
  const { workspaceRoot, teamDir, statePath } = await createWorkspace(team)
  await writeFile(join(teamDir, 'plan.md'), '# Plan\n', 'utf-8')
  seedRealStore({
    workspaceRoot,
    teamDir,
    statePath,
    name: team,
    tasks: [{
      id: 'T0',
      title: 'Architect plan',
      role: 'architect',
      status: 'needs_input',
      ownerAgentId: 'arch-1',
      needsInput: { artifactId: 'A2', kind: 'architect', reason: 'artifact_review', question: 'Plan ready for review.' },
    }],
    artifacts: [
      // Stale init placeholder, stored as the full-prefix path.
      { id: 'A1', kind: 'architect_plan', title: 'Architect Plan', path: `.multi-code/sprintengine/${team}/plan.md`, status: 'draft', createdBy: 'sprintengine', taskId: 'T0' },
      // Real plan, stored bare; resolves to the same file as A1.
      { id: 'A2', kind: 'architect_plan', title: 'Real Plan', path: 'plan.md', status: 'ready_for_review', createdBy: 'architect', taskId: 'T0' },
    ],
  })

  const before = await readProjection(teamDir)
  assert.equal(taskStatus(before, 'T0'), 'needs_input', 'precondition: gate task parked at needs_input')
  assert.equal(artifactStatus(before, 'A1'), 'draft', 'precondition: stale duplicate is a draft')
  assert.equal(artifactStatus(before, 'A2'), 'ready_for_review', 'precondition: real plan is ready')

  // Single real auto-run approval call — no propose -> reject -> cooldown loop.
  const result = await realHandlers().reviewArtifact({ statePath, artifactId: 'A2' }, 'approve', 'auto-run')
  assert.equal(result.ok, true, `auto-approve must succeed on the first attempt; got: ${JSON.stringify(result)}`)

  const after = await readProjection(teamDir)
  assert.equal(artifactStatus(after, 'A2'), 'approved', 'real plan A2 must end approved')
  assert.equal(taskStatus(after, 'T0'), 'done', 'gate task T0 must complete')
  assert.equal(artifactStatus(after, 'A1'), 'superseded', 'stale duplicate A1 must end superseded')
}

// Regression AC: a genuinely distinct pending approvable artifact (different
// resolved file, not ready) for the same task still blocks auto-approval, and the
// real store is left untouched (no fake success).
async function testAutoApproveStillBlockedByDistinctPendingSibling(): Promise<void> {
  const team = 'distinct-block'
  const { workspaceRoot, teamDir, statePath } = await createWorkspace(team)
  await writeFile(join(teamDir, 'plan.md'), '# Plan\n', 'utf-8')
  await writeFile(join(teamDir, 'plan-old.md'), '# Old\n', 'utf-8')
  seedRealStore({
    workspaceRoot,
    teamDir,
    statePath,
    name: team,
    tasks: [{
      id: 'T0',
      title: 'Architect plan',
      role: 'architect',
      status: 'needs_input',
      ownerAgentId: 'arch-1',
      needsInput: { artifactId: 'A2', kind: 'architect', reason: 'artifact_review', question: 'Plan ready for review.' },
    }],
    artifacts: [
      // Candidate real plan, ready for review.
      { id: 'A2', kind: 'architect_plan', title: 'Real Plan', path: 'plan.md', status: 'ready_for_review', createdBy: 'architect', taskId: 'T0' },
      // Distinct pending approvable sibling resolving to a DIFFERENT file; still a
      // legitimate review gate, so it must keep blocking auto-approval.
      { id: 'A3', kind: 'architect_plan', title: 'Other Plan', path: 'plan-old.md', status: 'draft', createdBy: 'architect', taskId: 'T0' },
    ],
  })

  const result = await realHandlers().reviewArtifact({ statePath, artifactId: 'A2' }, 'approve', 'auto-run')
  assert.equal(result.ok, false, 'auto-approve must be blocked by a distinct pending sibling')

  const after = await readProjection(teamDir)
  assert.equal(artifactStatus(after, 'A2'), 'ready_for_review', 'blocked candidate must not be approved')
  assert.equal(artifactStatus(after, 'A3'), 'draft', 'distinct pending sibling must be untouched')
  assert.equal(taskStatus(after, 'T0'), 'needs_input', 'gate task must stay parked when blocked')
}

async function main(): Promise<void> {
  await testAutoApproveSelfHealsStaleSameFileDuplicate()
  await testAutoApproveStillBlockedByDistinctPendingSibling()
  console.log('sprintengine-artifacts autoapprove-dedup tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
