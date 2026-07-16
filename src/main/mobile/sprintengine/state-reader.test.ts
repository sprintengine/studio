import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { validateSprintEngineStatePath } from './state-path'
import {
  assertKnownActiveSprintEngineAgent,
  findReadySprintEngineTask,
  findSprintEngineArtifact,
  readRawSprintEngineState,
} from './state-reader'

void main()

async function main(): Promise<void> {
  await assertProjectionIsPreferredForState()
  await assertProjectionIsRequired()
  await assertMalformedProjectionFails()
  await assertFindReadyTaskAcceptsProjectionReadyStatus()
  await assertFindReadyTaskBlocksWhenDependencyNotDone()
  await assertFindReadyTaskRejectsAlreadyOwnedTask()
  await assertFindReadyTaskRejectsRoleMismatch()
  await assertFindArtifactReadsFromProjection()
  await assertActiveAgentResolvedViaProjectionWorkers()
  await assertIdleAgentResolvedViaProjectionWorkersWithoutRunYamlPayload()
}

async function writeFixture(state: {
  stateContent?: string
  projection?: Record<string, unknown> | null
}): Promise<{ teamDirectory: string; statePath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'mobile-state-reader-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  await writeFile(statePath, state.stateContent ?? '{}', 'utf8')
  if (state.projection !== null && state.projection !== undefined) {
    await writeFile(join(teamDirectory, 'projection.json'), JSON.stringify(state.projection), 'utf8')
  }
  return { teamDirectory, statePath }
}

async function assertProjectionIsPreferredForState(): Promise<void> {
  const projection = {
    tasks: [
      { id: 'T1', role: 'developer', status: 'done', stateStatus: 'done', dependsOn: [] },
      { id: 'T2', role: 'frontend', status: 'ready', stateStatus: 'todo', dependsOn: ['T1'] },
    ],
    artifacts: [{ id: 'A1', path: 'docs/notes.md', status: 'approved' }],
    workers: { 'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' } },
  }
  const { statePath } = await writeFixture({
    // run.yaml graph mirror says T2 still has T1 as todo; projection wins
    stateContent: JSON.stringify({
      tasks: [
        { id: 'T1', role: 'developer', status: 'todo', dependsOn: [] },
        { id: 'T2', role: 'frontend', status: 'todo', dependsOn: ['T1'] },
      ],
      artifacts: [],
      sprintEngineAgents: {},
    }),
    projection,
  })
  const validated = validateSprintEngineStatePath(statePath)
  const raw = await readRawSprintEngineState(validated)
  assert.equal(Array.isArray(raw.tasks), true)
  assert.equal(raw.tasks?.length, 2)
  assert.equal(raw.artifacts?.length, 1)
  assert.deepEqual(Object.keys(raw.sprintEngineAgents ?? {}), ['developer-1'])
}

async function assertProjectionIsRequired(): Promise<void> {
  const { statePath } = await writeFixture({
    stateContent: JSON.stringify({
      tasks: [{ id: 'T1', role: 'developer', status: 'todo', dependsOn: [] }],
      artifacts: [{ id: 'A1', path: 'docs/notes.md' }],
      sprintEngineAgents: { 'developer-1': { role: 'developer', status: 'idle' } },
    }),
    projection: null,
  })
  const validated = validateSprintEngineStatePath(statePath)
  await assert.rejects(
    () => readRawSprintEngineState(validated),
    (error: Error) => error.message.includes('projection.json'),
  )
}

async function assertMalformedProjectionFails(): Promise<void> {
  const { teamDirectory, statePath } = await writeFixture({
    stateContent: JSON.stringify({
      tasks: [{ id: 'T1', role: 'developer', status: 'todo', dependsOn: [] }],
      artifacts: [],
      sprintEngineAgents: {},
    }),
    projection: null,
  })
  await writeFile(join(teamDirectory, 'projection.json'), '{"tasks":', 'utf8')
  const validated = validateSprintEngineStatePath(statePath)

  await assert.rejects(
    () => readRawSprintEngineState(validated),
    (error: Error) => error.message.includes('projection.json'),
  )
}

async function assertFindReadyTaskAcceptsProjectionReadyStatus(): Promise<void> {
  // Projection writes board column into `status` ("ready") and the semantic
  // value into `stateStatus` ("todo"). The reader must still consider this
  // task ready to start for the requested role.
  const projection = {
    tasks: [
      { id: 'T1', role: 'developer', status: 'done', stateStatus: 'done', dependsOn: [] },
      { id: 'T2', role: 'frontend', status: 'ready', stateStatus: 'todo', dependsOn: ['T1'] },
    ],
    artifacts: [],
    workers: {},
  }
  const { statePath } = await writeFixture({ projection })
  const validated = validateSprintEngineStatePath(statePath)
  const task = await findReadySprintEngineTask(validated, 'T2', 'frontend')
  assert.equal(task.id, 'T2')
  assert.equal(task.status, 'todo')
  assert.equal(task.ownerAgentId, null)
}

// Removed: the changes_requested "ready to start" case tested deleted gate
// machinery (MC-1542 single-owner tasks — changes_requested is no longer a task
// status and only `todo` tasks are startable).

async function assertFindReadyTaskBlocksWhenDependencyNotDone(): Promise<void> {
  const projection = {
    tasks: [
      { id: 'T1', role: 'developer', status: 'in_progress', stateStatus: 'in_progress', dependsOn: [] },
      { id: 'T2', role: 'frontend', status: 'todo', stateStatus: 'todo', dependsOn: ['T1'] },
    ],
    artifacts: [],
    workers: {},
  }
  const { statePath } = await writeFixture({ projection })
  const validated = validateSprintEngineStatePath(statePath)
  await assert.rejects(
    () => findReadySprintEngineTask(validated, 'T2', 'frontend'),
    (error: Error) => error.message.includes('blocked by dependency T1'),
  )
}

async function assertFindReadyTaskRejectsAlreadyOwnedTask(): Promise<void> {
  const projection = {
    tasks: [
      {
        id: 'T1',
        role: 'developer',
        status: 'in_progress',
        stateStatus: 'in_progress',
        ownerAgentId: 'developer-1',
        dependsOn: [],
      },
    ],
    artifacts: [],
    workers: {},
  }
  const { statePath } = await writeFixture({ projection })
  const validated = validateSprintEngineStatePath(statePath)
  await assert.rejects(
    () => findReadySprintEngineTask(validated, 'T1', 'developer'),
    (error: Error) => error.message.includes('already owned'),
  )
}

async function assertFindReadyTaskRejectsRoleMismatch(): Promise<void> {
  const projection = {
    tasks: [
      { id: 'T1', role: 'developer', status: 'ready', stateStatus: 'todo', dependsOn: [] },
    ],
    artifacts: [],
    workers: {},
  }
  const { statePath } = await writeFixture({ projection })
  const validated = validateSprintEngineStatePath(statePath)
  await assert.rejects(
    () => findReadySprintEngineTask(validated, 'T1', 'frontend'),
    (error: Error) => error.message.includes('does not match'),
  )
}

async function assertFindArtifactReadsFromProjection(): Promise<void> {
  const projection = {
    tasks: [],
    artifacts: [
      { id: 'A1', path: 'reviews/feedback.md', status: 'ready_for_review', kind: 'code_review' },
    ],
    workers: {},
  }
  const { statePath } = await writeFixture({ projection })
  const validated = validateSprintEngineStatePath(statePath)
  const artifact = await findSprintEngineArtifact(validated, 'A1')
  assert.equal(artifact.id, 'A1')
  assert.equal(artifact.path, 'reviews/feedback.md')
}

async function assertActiveAgentResolvedViaProjectionWorkers(): Promise<void> {
  const projection = {
    tasks: [
      { id: 'T1', role: 'developer', status: 'in_progress', stateStatus: 'in_progress', ownerAgentId: 'developer-1', dependsOn: [] },
    ],
    artifacts: [],
    workers: { 'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' } },
  }
  const { statePath } = await writeFixture({ projection })
  const validated = validateSprintEngineStatePath(statePath)
  // Active worker in the projection workers view: resolves without throwing.
  await assertKnownActiveSprintEngineAgent(validated, 'developer-1')

  // Done worker in the workers view: should reject.
  const doneFixture = await writeFixture({
    projection: {
      tasks: [],
      artifacts: [],
      workers: { 'developer-2': { role: 'developer', status: 'done', currentTaskId: null } },
    },
  })
  const doneValidated = validateSprintEngineStatePath(doneFixture.statePath)
  await assert.rejects(
    () => assertKnownActiveSprintEngineAgent(doneValidated, 'developer-2'),
    (error: Error) => error.message.includes('already done'),
  )

  // Worker missing from the workers view but owns an active task: resolves via task fallback.
  const taskFixture = await writeFixture({
    projection: {
      tasks: [
        { id: 'T2', role: 'frontend', status: 'in_progress', stateStatus: 'in_progress', ownerAgentId: 'frontend-7', dependsOn: [] },
      ],
      artifacts: [],
      workers: {},
    },
  })
  const taskValidated = validateSprintEngineStatePath(taskFixture.statePath)
  await assertKnownActiveSprintEngineAgent(taskValidated, 'frontend-7')
}

async function assertIdleAgentResolvedViaProjectionWorkersWithoutRunYamlPayload(): Promise<void> {
  const { statePath } = await writeFixture({
    stateContent: '{"tasks":',
    projection: {
      tasks: [],
      artifacts: [],
      workers: { 'developer-idle': { role: 'developer', status: 'idle', currentTaskId: null } },
    },
  })
  const validated = validateSprintEngineStatePath(statePath)
  await assertKnownActiveSprintEngineAgent(validated, 'developer-idle')
}

// eslint-disable-next-line no-console
console.log('state-reader.test.ts: ok')
