import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { agentPathOf, createWorkspaceRecordingOutputs } from './recording-output'
import { readWebmDurationMs } from './webm-duration'

// Where a recording lands, on a real folder: the workspace's own sidecar,
// ignored by git, written as it arrives and finished with its length.

const RECORDED = new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'media-recorder-vp9-160x120.webm')))

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-recording-'))
  made.push(dir)
  return dir
}

test('a recording is written into the workspace sidecar, ignored by git, and finished with its length', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await outputs.create({ workspaceId: 'ws', stem: 'recording-localhost-5173-20261004-090507' })
  assert.ok(created.ok)
  const { output } = created
  assert.equal(output.workspacePath, '.sprintengine/browser/recordings/recording-localhost-5173-20261004-090507.webm')
  assert.equal(
    output.path,
    join(root, '.sprintengine', 'browser', 'recordings', 'recording-localhost-5173-20261004-090507.webm'),
  )
  assert.equal(readFileSync(join(root, '.sprintengine', 'browser', '.gitignore'), 'utf8'), '*\n')

  // Written as it arrives, under a name that says it is not done.
  await output.append(RECORDED.subarray(0, 4_000))
  await output.append(RECORDED.subarray(4_000))
  assert.equal(existsSync(output.path!), false)
  assert.deepEqual(readdirSync(join(root, '.sprintengine', 'browser', 'recordings')), [
    'recording-localhost-5173-20261004-090507.webm.part',
  ])

  const done = await output.finish(1_000)
  const saved = new Uint8Array(readFileSync(output.path!))
  assert.equal(done.bytes, saved.length)
  assert.equal(readWebmDurationMs(saved), 1_000)
  assert.deepEqual(readdirSync(join(root, '.sprintengine', 'browser', 'recordings')), [
    'recording-localhost-5173-20261004-090507.webm',
  ])
})

test('bytes this edit does not understand are kept as they came', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.ok(created.ok)
  await created.output.append(new Uint8Array([1, 2, 3]))
  assert.equal((await created.output.finish(500)).bytes, 3)
  assert.deepEqual([...readFileSync(created.output.path!)], [1, 2, 3])
})

test('a second recording in the same second takes the next free name', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const first = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  const second = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.ok(first.ok && second.ok)
  assert.equal(second.output.workspacePath, '.sprintengine/browser/recordings/recording-x-2.webm')
})

test('two recordings that start together never share a file', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await Promise.all([1, 2, 3].map(() => outputs.create({ workspaceId: 'ws', stem: 'recording-x' })))
  const names = created.map((result) => (result.ok ? result.output.workspacePath : result.code))
  assert.equal(new Set(names).size, 3, names.join(', '))
  assert.deepEqual(readdirSync(join(root, '.sprintengine', 'browser', 'recordings')).sort(), [
    'recording-x-2.webm.part',
    'recording-x-3.webm.part',
    'recording-x.webm.part',
  ])
})

test('a discarded recording leaves nothing behind', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.ok(created.ok)
  await created.output.append(new Uint8Array([1]))
  await created.output.discard()
  assert.deepEqual(readdirSync(join(root, '.sprintengine', 'browser', 'recordings')), [])
})

test('a workspace on an SSH machine is refused before anything is written, naming the machine', async () => {
  const outputs = createWorkspaceRecordingOutputs({
    resolveWorkspaceRoot: () => 'ssh://e1/home/dev/app',
    machineLabel: (id) => (id === 'e1' ? 'build-box' : null),
  })
  const refused = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.ok(!refused.ok)
  assert.equal(refused.code, 'recording_unavailable')
  assert.match(refused.message, /build-box/)
})

test('a workspace with no folder here is refused', async () => {
  const none = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => null })
  const refused = await none.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.equal(!refused.ok && refused.code, 'no_workspace_folder')
  const gone = createWorkspaceRecordingOutputs({
    resolveWorkspaceRoot: () => join(tmpdir(), 'se-recording-missing-folder'),
  })
  const alsoRefused = await gone.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.equal(!alsoRefused.ok && alsoRefused.code, 'no_workspace_folder')
})

test('a WSL workspace’s file is named for the agent by its Linux path', () => {
  assert.equal(
    agentPathOf('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app\\.sprintengine\\browser\\recordings\\r.webm'),
    '/home/dev/app/.sprintengine/browser/recordings/r.webm',
  )
  assert.equal(agentPathOf('/Users/dev/app/r.webm'), '/Users/dev/app/r.webm')
})

test("an agent's recording goes into the folder its chat works in, and the workspace's when that is not known", async () => {
  const root = workspace()
  const worktree = workspace()
  const asked: Array<{ workspaceId: string; agentId: string }> = []
  const outputs = createWorkspaceRecordingOutputs({
    resolveWorkspaceRoot: () => root,
    resolveAgentRoot: (agent) => {
      asked.push(agent)
      return agent.agentId === 'agent-1' ? worktree : null
    },
  })
  const inWorktree = await outputs.create({
    workspaceId: 'ws',
    stem: 'recording-x',
    agent: { workspaceId: 'ws', agentId: 'agent-1' },
  })
  assert.ok(inWorktree.ok)
  assert.equal(inWorktree.output.workspacePath, '.sprintengine/browser/recordings/recording-x.webm')
  assert.equal(inWorktree.output.path, join(worktree, '.sprintengine', 'browser', 'recordings', 'recording-x.webm'))
  const unknown = await outputs.create({
    workspaceId: 'ws',
    stem: 'recording-y',
    agent: { workspaceId: 'ws', agentId: 'agent-2' },
  })
  assert.ok(unknown.ok)
  assert.equal(unknown.output.path, join(root, '.sprintengine', 'browser', 'recordings', 'recording-y.webm'))
  const notAnAgent = await outputs.create({ workspaceId: 'ws', stem: 'recording-z' })
  assert.ok(notAnAgent.ok)
  assert.equal(notAnAgent.output.path, join(root, '.sprintengine', 'browser', 'recordings', 'recording-z.webm'))
  assert.deepEqual(asked, [
    { workspaceId: 'ws', agentId: 'agent-1' },
    { workspaceId: 'ws', agentId: 'agent-2' },
  ])
})
