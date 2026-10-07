import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { ConversationEvent, ConversationRevertInput } from '../shared/conversation-runtime'
import type { ProjectRepositories } from '../shared/project-repositories'
import { ConversationCheckpoints } from './conversation-checkpoints'
import { ConversationRuntime } from './conversation-runtime'
import { runGitCommand } from './git-utils'
import { prefixPatch, ProjectCheckpoints } from './project-checkpoints'
import { clearProjectRepositoriesCache } from './project-repositories'
import type { MockAdapterTurnInput } from './providers/conversation-provider-adapter'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommand(cwd, args)
  assert.ok(result.ok, result.message ?? result.stderr)
  return result.stdout
}

async function repository(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true })
  await git(root, ['init'])
  await git(root, ['config', 'user.name', 'Developer'])
  await git(root, ['config', 'user.email', 'dev@example.com'])
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text)
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'Initial files'])
}

let directory: string
let acme: string
let checkpoints: ProjectCheckpoints
const key = () => ({ workspaceRoot: acme, workspaceId: 'workspace', agentId: 'agent' })

beforeEach(async () => {
  clearProjectRepositoriesCache()
  directory = await mkdtemp(join(tmpdir(), 'project-checkpoints-'))
  acme = join(directory, 'acme')
  await repository(join(acme, 'api'), { 'user.ts': 'export type User = { id: string }\n' })
  await repository(join(acme, 'web'), { 'page.tsx': 'export const Page = () => null\n' })
  await mkdir(join(acme, 'notes'))
  checkpoints = new ProjectCheckpoints()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A turn that edits a file in api and adds one in web, captured before and after. */
async function turn(turnSeq = 1): Promise<void> {
  assert.equal((await checkpoints.capture(key(), turnSeq, 'pre')).ok, true)
  await writeFile(join(acme, 'api', 'user.ts'), 'export type User = { id: string; name: string }\n')
  await writeFile(join(acme, 'web', 'name.tsx'), 'export const Name = () => null\n')
  assert.equal((await checkpoints.capture(key(), turnSeq, 'post')).ok, true)
}

async function previewThenRevert(input: Omit<ConversationRevertInput, 'confirmed' | 'files'>) {
  const preview = await checkpoints.revert(input)
  if (!preview.ok) return preview
  return checkpoints.revert({ ...input, confirmed: true, files: preview.files.map((file) => file.path) })
}

test('a folder of several repositories has checkpoints, scoped to the folder itself', async () => {
  assert.equal(await checkpoints.available(acme), true)
  assert.equal(await checkpoints.fileScope(acme), await realpath(acme))
  assert.equal(await new ConversationCheckpoints().available(acme), false, 'which the plain checkpoints lack')
})

test("a turn's diff lists every member's files under the member, with the member's numbers", async () => {
  await turn()
  const result = await checkpoints.getTurnDiff({ key: key(), turnSeq: 1 })
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.deepEqual(
    result.diff.files.map((file) => [file.path, file.status, file.addedLines, file.removedLines]),
    [
      ['api/user.ts', 'modified', 1, 1],
      ['web/name.tsx', 'added', 1, 0],
    ],
  )
})

test("one file's diff is read from its member, and its patch names it as the project does", async () => {
  await turn()
  const result = await checkpoints.getTurnDiff({ key: key(), turnSeq: 1, path: 'api/user.ts' })
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.match(result.patch ?? '', /^diff --git a\/api\/user\.ts b\/api\/user\.ts$/mu)
  assert.match(result.patch ?? '', /^--- a\/api\/user\.ts$/mu)
  assert.match(result.patch ?? '', /^\+\+\+ b\/api\/user\.ts$/mu)
  assert.equal(result.original, 'export type User = { id: string }\n')
  assert.equal(result.modified, 'export type User = { id: string; name: string }\n')
  const outside = await checkpoints.getTurnDiff({ key: key(), turnSeq: 1, path: 'notes/todo.md' })
  assert.equal(outside.ok, false)
})

test('revert restores every member it previewed, and undo puts them back', async () => {
  await turn()
  const preview = await checkpoints.revert({ key: key(), turnSeq: 1 })
  assert.ok(preview.ok)
  assert.equal(preview.reverted, false)
  assert.deepEqual(
    preview.files.map((file) => file.path),
    ['api/user.ts', 'web/name.tsx'],
  )
  const reverted = await previewThenRevert({ key: key(), turnSeq: 1 })
  assert.ok(reverted.ok, reverted.ok ? '' : reverted.message)
  assert.equal(reverted.reverted, true)
  assert.equal(await readFile(join(acme, 'api', 'user.ts'), 'utf8'), 'export type User = { id: string }\n')
  await assert.rejects(stat(join(acme, 'web', 'name.tsx')), 'the added file is removed')

  const undone = await previewThenRevert({ key: key(), turnSeq: 1, undo: true })
  assert.ok(undone.ok, undone.ok ? '' : undone.message)
  assert.equal(
    await readFile(join(acme, 'api', 'user.ts'), 'utf8'),
    'export type User = { id: string; name: string }\n',
  )
  assert.equal(await readFile(join(acme, 'web', 'name.tsx'), 'utf8'), 'export const Name = () => null\n')
})

test('a revert whose list moved since the dialog showed it changes no member', async () => {
  await turn()
  const preview = await checkpoints.revert({ key: key(), turnSeq: 1 })
  assert.ok(preview.ok)
  // Only api's file was shown; web's was not, so nothing may be touched.
  const result = await checkpoints.revert({ key: key(), turnSeq: 1, confirmed: true, files: ['api/user.ts'] })
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.changed, true)
  assert.equal(
    await readFile(join(acme, 'api', 'user.ts'), 'utf8'),
    'export type User = { id: string; name: string }\n',
    'api was not reverted on its own',
  )
  const outside = await checkpoints.revert({
    key: key(),
    turnSeq: 1,
    confirmed: true,
    files: ['api/user.ts', 'web/name.tsx', 'notes/todo.md'],
  })
  assert.equal(!outside.ok && outside.changed, true, 'a path in no member is drift too')
})

test('a member that fails part way stops the revert and says which members were already restored', async () => {
  await turn()
  const original = ConversationCheckpoints.prototype.revert
  const failing = vi.spyOn(ConversationCheckpoints.prototype, 'revert').mockImplementation(async function (
    this: ConversationCheckpoints,
    input,
  ) {
    if (input.confirmed && input.key.workspaceRoot.endsWith('web')) return { ok: false, message: 'disk full' }
    return original.call(this, input)
  })
  try {
    const result = await previewThenRevert({ key: key(), turnSeq: 1 })
    assert.equal(result.ok, false)
    assert.match(
      !result.ok ? result.message : '',
      /^web: disk full\. The revert stopped there; api was already restored/u,
    )
    assert.equal(await readFile(join(acme, 'api', 'user.ts'), 'utf8'), 'export type User = { id: string }\n')
  } finally {
    failing.mockRestore()
  }
})

test('a member cloned during the turn has no checkpoint for it and is left out, not failed', async () => {
  assert.equal((await checkpoints.capture(key(), 1, 'pre')).ok, true)
  await repository(join(acme, 'infra'), { 'main.tf': 'terraform {}\n' })
  clearProjectRepositoriesCache()
  await writeFile(join(acme, 'api', 'user.ts'), 'export type User = { id: number }\n')
  await writeFile(join(acme, 'infra', 'main.tf'), 'terraform { required_version = ">= 1" }\n')
  assert.equal((await checkpoints.capture(key(), 1, 'post')).ok, true)
  const diff = await checkpoints.getTurnDiff({ key: key(), turnSeq: 1 })
  assert.ok(diff.ok)
  assert.deepEqual(
    diff.diff.files.map((file) => file.path),
    ['api/user.ts'],
  )
  const preview = await checkpoints.revert({ key: key(), turnSeq: 1 })
  assert.ok(preview.ok, preview.ok ? '' : preview.message)
  assert.deepEqual(
    preview.files.map((file) => file.path),
    ['api/user.ts'],
  )
})

test('a turn with no checkpoint in any member says so', async () => {
  const diff = await checkpoints.getTurnDiff({ key: key(), turnSeq: 7 })
  assert.equal(diff.ok, false)
  const revert = await checkpoints.revert({ key: key(), turnSeq: 7 })
  assert.equal(revert.ok, false)
  const undo = await checkpoints.revert({ key: key(), turnSeq: 7, undo: true })
  assert.deepEqual(undo, { ok: false, message: 'There is no revert to undo for this turn.' })
})

test("deleting the conversation removes its checkpoints from every member, and no one else's", async () => {
  await turn()
  const other = { ...key(), agentId: 'other' }
  assert.equal((await checkpoints.capture(other, 1, 'pre')).ok, true)
  await checkpoints.deleteConversation(key())
  for (const member of ['api', 'web']) {
    const refs = (
      await git(join(acme, member), ['for-each-ref', '--format=%(refname)', 'refs/sprintengine/checkpoints/'])
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.equal(refs.length, 1, `${member} keeps only the other conversation's checkpoint`)
  }
})

test('a repository goes straight through, with its own paths', async () => {
  const api = join(acme, 'api')
  const single = { workspaceRoot: api, workspaceId: 'workspace', agentId: 'agent' }
  assert.equal((await checkpoints.capture(single, 1, 'pre')).ok, true)
  await writeFile(join(api, 'user.ts'), 'export type User = { id: bigint }\n')
  assert.equal((await checkpoints.capture(single, 1, 'post')).ok, true)
  const diff = await checkpoints.getTurnDiff({ key: single, turnSeq: 1 })
  assert.ok(diff.ok)
  assert.deepEqual(
    diff.diff.files.map((file) => file.path),
    ['user.ts'],
  )
})

test('a project over the repository cap is not checkpointed', async () => {
  const truncated = (folder: string): ProjectRepositories => ({
    root: folder,
    source: { kind: 'children' },
    repositories: [{ path: join(folder, 'api'), relativePath: 'api', name: 'api' }],
    truncated: true,
  })
  const capped = new ProjectCheckpoints(new ConversationCheckpoints(), truncated)
  assert.equal(await capped.available(acme), false)
})

test("a member's patch headers are rewritten to the project's paths, spaces and quotes included", () => {
  const patch = [
    'diff --git a/src/a b.ts b/src/a b.ts',
    'index 1..2 100644',
    '--- a/src/a b.ts',
    '+++ b/src/a b.ts',
    '@@ -1 +1 @@',
    '-a/old',
    '+b/new',
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    '--- "a/caf\\303\\251.ts"',
    '+++ "b/caf\\303\\251.ts"',
  ].join('\n')
  assert.equal(
    prefixPatch(patch, 'web'),
    [
      'diff --git a/web/src/a b.ts b/web/src/a b.ts',
      'index 1..2 100644',
      '--- a/web/src/a b.ts',
      '+++ b/web/src/a b.ts',
      '@@ -1 +1 @@',
      '-a/old',
      '+b/new',
      'diff --git "a/web/caf\\303\\251.ts" "b/web/caf\\303\\251.ts"',
      '--- "a/web/caf\\303\\251.ts"',
      '+++ "b/web/caf\\303\\251.ts"',
    ].join('\n'),
  )
})

test("a chat in the project folder gets the card's numbers and diff across its members", async () => {
  const adapter = {
    ...createMockConversationProvider(),
    async *sendTurn(input: MockAdapterTurnInput): AsyncIterable<ConversationEvent> {
      const envelope = {
        id: '',
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        createdAt: 0,
      }
      yield {
        ...envelope,
        type: 'tool_started',
        payload: { turnId: input.turnId, tool: 'Write', toolCallId: input.turnId, input: { path: 'api/user.ts' } },
      }
      await writeFile(join(acme, 'api', 'user.ts'), 'export type User = { id: string; name: string }\n')
      await writeFile(join(acme, 'web', 'name.tsx'), 'export const Name = () => null\n')
      yield { ...envelope, type: 'turn_completed', payload: { turnId: input.turnId } }
    },
  }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    const started = await runtime.startSession({ ...key(), providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.equal(started.session.capabilities?.checkpoints, true)
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'add a name' })
    const replay = await runtime.readTranscript(key())
    assert.ok(replay.ok)
    const complete = replay.events.find((event) => event.type === 'turn_completed')!
    assert.equal(complete.payload?.checkpointAvailable, true)
    assert.deepEqual(complete.payload?.checkpointSummary, { files: 2, addedLines: 2, removedLines: 1 })
    const diff = await runtime.getTurnDiff({ key: key(), turnSeq: Number(complete.payload?.checkpointTurnSeq) })
    assert.ok(diff.ok)
    assert.deepEqual(
      diff.diff.files.map((file) => file.path),
      ['api/user.ts', 'web/name.tsx'],
    )
  } finally {
    await runtime.shutdown()
  }
})
