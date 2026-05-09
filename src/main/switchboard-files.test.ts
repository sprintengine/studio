import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  SWITCHBOARD_FOLDER_STATUSES,
  getSwitchboardFolderRelativePath,
  isSwitchboardTaskId,
} from '../shared/switchboard'
import {
  addSwitchboardComment,
  cancelSwitchboardTask,
  claimSwitchboardTask,
  createSwitchboardTask,
  initializeSwitchboard,
  moveSwitchboardTask,
  publishSwitchboardTask,
  promoteSwitchboardInboxTask,
  readAllSwitchboardTasks,
  updateSwitchboardTask,
} from './switchboard-files'

const execFileAsync = promisify(execFile)
const repoRoot = process.cwd()

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertInitializationCreatesFoldersAndLocks()
  await assertCreateReadPromoteCommentAndCancel()
  await assertClaimUsesReadyQueue()
  await assertMalformedFilesAreReported()
  await assertCliAndAdapterReadTheSameFiles()
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'multicode-switchboard-'))
}

async function assertInitializationCreatesFoldersAndLocks(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const result = await initializeSwitchboard({ workspaceRoot })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.folders.length, SWITCHBOARD_FOLDER_STATUSES.length)

  for (const status of SWITCHBOARD_FOLDER_STATUSES) {
    const lockPath = join(workspaceRoot, '.multi-code', 'switchboard', getSwitchboardFolderRelativePath(status), 'Lock')
    assert.equal(await readFile(lockPath, 'utf8'), '{\n  "locked": false\n}\n')
  }
}

async function assertCreateReadPromoteCommentAndCancel(): Promise<void> {
  const workspaceRoot = await createWorkspace()

  const inboxTask = await createSwitchboardTask({
    workspaceRoot,
    origin: 'watchtower',
    title: 'Review auth redirect handling',
    description: 'Watchtower found a likely redirect regression.',
    labels: ['Bug', ' Auth ', 'bug'],
  })
  assert.equal(inboxTask.ok, true)
  assert.equal(inboxTask.ok && inboxTask.record.location.folderStatus, 'inbox')
  assert.equal(inboxTask.ok && isSwitchboardTaskId(inboxTask.record.task.id), true)
  assert.equal(inboxTask.ok && basename(inboxTask.record.location.path), `${inboxTask.ok && inboxTask.record.task.id}.json`)
  assert.deepEqual(inboxTask.ok && inboxTask.record.task.labels, ['bug', 'auth'])

  const boardTask = await createSwitchboardTask({
    workspaceRoot,
    origin: 'board',
    title: 'Add dashboard smoke test',
  })
  assert.equal(boardTask.ok, true)
  assert.equal(boardTask.ok && boardTask.record.location.folderStatus, 'todo')

  const promoted = await promoteSwitchboardInboxTask({
    workspaceRoot,
    id: inboxTask.ok ? inboxTask.record.task.id : '',
  })
  assert.equal(promoted.ok, true)
  assert.equal(promoted.ok && promoted.record.location.folderStatus, 'todo')

  const moved = await moveSwitchboardTask({
    workspaceRoot,
    id: promoted.ok ? promoted.record.task.id : '',
    to: 'ready',
  })
  assert.equal(moved.ok, true)
  assert.equal(moved.ok && moved.record.location.folderStatus, 'ready')
  assert.equal(moved.ok && moved.record.task.state, 'ready')

  const commented = await addSwitchboardComment({
    workspaceRoot,
    id: moved.ok ? moved.record.task.id : '',
    body: 'Ready after product review.',
    author: { type: 'user', id: 'local-user', name: 'Local User' },
  })
  assert.equal(commented.ok, true)
  assert.equal(commented.ok && commented.record.task.comments.at(-1)?.body, 'Ready after product review.')

  const updated = await updateSwitchboardTask({
    workspaceRoot,
    id: moved.ok ? moved.record.task.id : '',
    updates: {
      title: 'Updated auth redirect task',
      labels: ['Bug', 'Regression', 'bug'],
    },
  })
  assert.equal(updated.ok, true)
  assert.equal(updated.ok && updated.record.task.title, 'Updated auth redirect task')
  assert.deepEqual(updated.ok && updated.record.task.labels, ['bug', 'regression'])

  const canceled = await cancelSwitchboardTask({
    workspaceRoot,
    id: moved.ok ? moved.record.task.id : '',
  })
  assert.equal(canceled.ok, true)
  assert.equal(canceled.ok && canceled.record.location.folderStatus, 'canceled')

  const readAll = await readAllSwitchboardTasks({ workspaceRoot })
  assert.equal(readAll.ok, true)
  assert.equal(readAll.ok && readAll.tasks.length, 2)
  assert.deepEqual(readAll.ok && readAll.problems, [])
}

async function assertMalformedFilesAreReported(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  await initializeSwitchboard({ workspaceRoot })

  const inboxPath = join(workspaceRoot, '.multi-code', 'switchboard', 'inbox')
  await mkdir(inboxPath, { recursive: true })
  await writeFile(join(inboxPath, '550e8400-e29b-41d4-a716-446655440000.json'), '{not-json', 'utf8')
  await writeFile(join(inboxPath, 'task_550e8400-e29b-41d4-a716-446655440001.json'), '{}', 'utf8')

  const result = await readAllSwitchboardTasks({ workspaceRoot })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.tasks.length, 0)
  assert.equal(result.ok && result.problems.length, 2)
  assert.equal(
    result.ok && result.problems.some((problem) => problem.message.includes('task_ prefix')),
    true
  )
}

async function assertClaimUsesReadyQueue(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const created = await createSwitchboardTask({
    workspaceRoot,
    origin: 'board',
    title: 'Implement compact task rows',
  })
  assert.equal(created.ok, true)

  const ready = await moveSwitchboardTask({
    workspaceRoot,
    id: created.ok ? created.record.task.id : '',
    to: 'ready',
  })
  assert.equal(ready.ok, true)

  const claimed = await claimSwitchboardTask({
    workspaceRoot,
    from: 'ready',
    owner: 'developer-1',
    sessionId: 'terminal-1',
  })
  assert.equal(claimed.ok, true)
  assert.equal(claimed.ok && claimed.record.location.folderStatus, 'in_progress')
  assert.equal(claimed.ok && claimed.record.task.claim?.owner, 'developer-1')

  const emptyClaim = await claimSwitchboardTask({
    workspaceRoot,
    from: 'ready',
    owner: 'developer-2',
  })
  assert.equal(emptyClaim.ok, false)
  assert.equal(!emptyClaim.ok && emptyClaim.message.includes('No eligible task'), true)

  const rejectedPublish = await publishSwitchboardTask({
    workspaceRoot,
    id: claimed.ok ? claimed.record.task.id : '',
    summary: 'Implemented without recording evidence.',
  })
  assert.equal(rejectedPublish.ok, false)
  assert.equal(!rejectedPublish.ok && rejectedPublish.message.includes('execution attempt'), true)
}

async function runSwitchboardCli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(join(repoRoot, 'scripts', 'switchboard'), args, {
    cwd: repoRoot,
  })
  return JSON.parse(stdout) as Record<string, unknown>
}

async function assertCliAndAdapterReadTheSameFiles(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  await runSwitchboardCli(['init', '--workspace', workspaceRoot])
  const cliCreated = await runSwitchboardCli([
    'create',
    '--workspace',
    workspaceRoot,
    '--title',
    'CLI-created task',
  ])
  const cliTaskId = cliCreated.id
  assert.equal(typeof cliTaskId, 'string')

  const adapterRead = await readAllSwitchboardTasks({ workspaceRoot })
  assert.equal(adapterRead.ok, true)
  assert.equal(
    adapterRead.ok && adapterRead.tasks.some((record) => record.task.id === cliTaskId && record.location.folderStatus === 'todo'),
    true
  )

  const adapterCreated = await createSwitchboardTask({
    workspaceRoot,
    origin: 'watchtower',
    title: 'Adapter-created inbox task',
  })
  assert.equal(adapterCreated.ok, true)
  const cliRead = await runSwitchboardCli(['read-all', '--workspace', workspaceRoot])
  const cliTasks = cliRead.tasks as Array<{ task: { id: string }; location: { folderStatus: string } }>
  assert.equal(
    cliTasks.some((record) => (
      adapterCreated.ok
      && record.task.id === adapterCreated.record.task.id
      && record.location.folderStatus === 'inbox'
    )),
    true
  )
}
