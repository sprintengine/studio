import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { ConversationCheckpoints } from './conversation-checkpoints'
import { runGitCommand } from './git-utils'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import type { ConversationEvent } from '../shared/conversation-runtime'

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommand(cwd, args)
  assert.ok(result.ok, result.message ?? result.stderr)
  return result.stdout
}
async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-checkpoints-'))
  const root = join(directory, 'repository')
  await mkdir(root)
  await git(root, ['init'])
  await git(root, ['config', 'user.name', 'Developer'])
  await git(root, ['config', 'user.email', 'dev@example.com'])
  await writeFile(join(root, 'existing.txt'), 'original\n')
  await writeFile(join(root, 'deleted.txt'), 'keep\n')
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n.sprintengine/\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'Initial files'])
  return { root, directory, key: { workspaceRoot: root, workspaceId: 'workspace', agentId: 'agent' } }
}

test('revert locks all conversations sharing files until the transaction settles', async () => {
  const f = await repository()
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = ConversationCheckpoints.prototype.revert
  const delayed = vi.spyOn(ConversationCheckpoints.prototype, 'revert').mockImplementation(async function (
    this: ConversationCheckpoints,
    input,
  ) {
    entered()
    await gate
    return original.call(this, input)
  })
  try {
    const a = await runtime.startSession({ ...f.key, providerId: adapter.id, modelId: adapter.listModels()[0] })
    const b = await runtime.startSession({
      ...f.key,
      agentId: 'other',
      providerId: adapter.id,
      modelId: adapter.listModels()[0],
    })
    assert.ok(a.ok && b.ok)
    assert.ok((await new ConversationCheckpoints().capture(f.key, 1, 'pre')).ok)
    const reverting = runtime.revertToTurn({ key: f.key, turnSeq: 1, confirmed: true })
    await running
    assert.equal((await runtime.sendTurn({ sessionId: a.session.sessionId, message: 'edit' })).ok, false)
    assert.equal((await runtime.sendTurn({ sessionId: b.session.sessionId, message: 'edit' })).ok, false)
    assert.equal((await runtime.deleteTranscript(f.key)).ok, false)
    assert.equal((await runtime.revertToTurn({ key: f.key, turnSeq: 1, confirmed: true })).ok, false)
    assert.equal(
      (
        await runtime.startSession({
          ...f.key,
          agentId: 'third',
          providerId: adapter.id,
          modelId: adapter.listModels()[0],
        })
      ).ok,
      false,
    )
    release()
    assert.ok((await reverting).ok)
  } finally {
    release()
    delayed.mockRestore()
    await runtime.shutdown()
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('reverting a closed conversation persists markers and the next-send file-state notice', async () => {
  const f = await repository()
  let lastMessage = ''
  const adapter = {
    ...createMockConversationProvider(),
    sendTurn(input: Parameters<ReturnType<typeof createMockConversationProvider>['sendTurn']>[0]) {
      lastMessage = input.message
      return [
        {
          id: '',
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          providerId: input.providerId,
          modelId: input.modelId,
          createdAt: 0,
          type: 'turn_completed' as const,
          payload: { turnId: input.turnId },
        },
      ]
    },
  }
  const initial = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    assert.ok((await initial.startSession({ ...f.key, providerId: adapter.id, modelId: adapter.listModels()[0] })).ok)
    await initial.shutdown()
    assert.ok((await new ConversationCheckpoints().capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'changed\n')
    assert.ok((await runtime.revertToTurn({ key: f.key, turnSeq: 1, confirmed: true })).ok)
    const transcript = await runtime.readTranscript(f.key, { all: true })
    assert.ok(transcript.ok)
    assert.equal(transcript.events.at(-1)?.payload?.revertedAfterSeq, 1)
    const opened = await runtime.startSession({ ...f.key, providerId: adapter.id, modelId: adapter.listModels()[0] })
    assert.ok(opened.ok)
    await runtime.sendTurn({ sessionId: opened.session.sessionId, message: 'continue' })
    assert.match(lastMessage, /Files were reverted/)
  } finally {
    await initial.shutdown()
    await runtime.shutdown()
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('capture preserves the user branch, staging bytes and mtime, status and stash', async () => {
  const f = await repository()
  try {
    await writeFile(join(f.root, 'existing.txt'), 'staged\n')
    await git(f.root, ['add', 'existing.txt'])
    await writeFile(join(f.root, 'existing.txt'), 'unstaged\n')
    await writeFile(join(f.root, 'untracked.txt'), 'new\n')
    const indexPath = join(f.root, '.git', 'index')
    const index = await readFile(indexPath)
    const modified = (await stat(indexPath)).mtimeMs
    const before = await Promise.all([
      git(f.root, ['status', '--porcelain=v1']),
      git(f.root, ['rev-parse', 'HEAD']),
      git(f.root, ['stash', 'list']),
    ])
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    assert.deepEqual(await readFile(indexPath), index)
    assert.equal((await stat(indexPath)).mtimeMs, modified)
    assert.deepEqual(
      await Promise.all([
        git(f.root, ['status', '--porcelain=v1']),
        git(f.root, ['rev-parse', 'HEAD']),
        git(f.root, ['stash', 'list']),
      ]),
      before,
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('new staged files remain captured when their names match ignore rules', async () => {
  const f = await repository()
  try {
    await writeFile(join(f.root, 'ignored.txt'), 'tracked before\n')
    await git(f.root, ['add', '-f', 'ignored.txt'])
    const index = await readFile(join(f.root, '.git', 'index'))
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'ignored.txt'), 'tracked after\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.deepEqual(await readFile(join(f.root, '.git', 'index')), index)
    const diff = await checkpoints.getTurnDiff({ key: f.key, turnSeq: 1, path: 'ignored.txt' })
    assert.ok(diff.ok)
    assert.equal(diff.original, 'tracked before\n')
    assert.equal(diff.modified, 'tracked after\n')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('revert restores modified/deleted files, removes later files, and can undo without touching ignored files', async () => {
  const f = await repository()
  try {
    const checkpoints = new ConversationCheckpoints()
    await writeFile(join(f.root, 'ignored.txt'), 'private ignored content')
    assert.ok((await checkpoints.capture(f.key, 3, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'after\nsecond\n')
    await rm(join(f.root, 'deleted.txt'))
    await writeFile(join(f.root, 'created.txt'), 'created\n')
    assert.ok((await checkpoints.capture(f.key, 3, 'post')).ok)
    const diff = await checkpoints.getTurnDiff({ key: f.key, turnSeq: 3, path: 'existing.txt' })
    assert.ok(diff.ok)
    assert.equal(diff.diff.files.length, 3)
    assert.ok(diff.patch?.includes('+second'))
    const preview = await checkpoints.revert({ key: f.key, turnSeq: 3 })
    assert.ok(preview.ok && !preview.reverted)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'after\nsecond\n')
    const reverted = await checkpoints.revert({ key: f.key, turnSeq: 3, confirmed: true })
    assert.ok(reverted.ok && reverted.reverted)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'original\n')
    assert.equal(await readFile(join(f.root, 'deleted.txt'), 'utf8'), 'keep\n')
    await assert.rejects(stat(join(f.root, 'created.txt')), { code: 'ENOENT' })
    assert.equal(await readFile(join(f.root, 'ignored.txt'), 'utf8'), 'private ignored content')
    const undo = await checkpoints.revert({ key: f.key, turnSeq: 3, confirmed: true, undo: true })
    assert.ok(undo.ok)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'after\nsecond\n')
    assert.equal(await readFile(join(f.root, 'created.txt'), 'utf8'), 'created\n')
    await assert.rejects(stat(join(f.root, 'deleted.txt')), { code: 'ENOENT' })
    await checkpoints.deleteConversation(f.key)
    assert.equal(
      (await git(f.root, ['for-each-ref', '--format=%(refname)', 'refs/sprintengine/checkpoints/'])).trim(),
      '',
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('checkpoint capture supports linked worktrees and refuses oversized untracked payloads', async () => {
  const f = await repository()
  try {
    const root = join(f.directory, 'linked')
    await git(f.root, ['worktree', 'add', '-b', 'linked', root])
    const checkpoints = new ConversationCheckpoints()
    const key = { ...f.key, workspaceRoot: root }
    assert.ok(await checkpoints.available(root))
    assert.ok((await checkpoints.capture(key, 1, 'pre')).ok)
    await writeFile(join(root, 'existing.txt'), 'linked work\n')
    assert.ok((await checkpoints.capture(key, 1, 'post')).ok)
    assert.ok((await checkpoints.revert({ key, turnSeq: 1, confirmed: true })).ok)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'original\n')
    await writeFile(join(root, 'too-large.txt'), '12345')
    const limited = new ConversationCheckpoints({ bytes: 4, files: 100 })
    const result = await limited.capture(key, 2, 'pre')
    assert.ok(!result.ok && result.skipped)
    const countLimited = new ConversationCheckpoints({ bytes: 100, files: 0 })
    assert.equal((await countLimited.capture(key, 2, 'pre')).ok, false)
    await checkpoints.collectExpired(root, Date.now() + 31 * 24 * 60 * 60 * 1000)
    assert.equal(
      (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/sprintengine/checkpoints/'])).trim(),
      '',
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('runtime captures lazily around writes, reports totals, blocks active reverts and replays file-state notices', async () => {
  const f = await repository()
  let lastMessage = ''
  const adapter = {
    ...createMockConversationProvider(),
    async *sendTurn(
      input: import('./providers/conversation-provider-adapter').MockAdapterTurnInput,
    ): AsyncIterable<ConversationEvent> {
      lastMessage = input.message
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
        payload: {
          turnId: input.turnId,
          tool: 'Write',
          toolCallId: input.turnId,
          input: { path: 'existing.txt', content: 'changed\n' },
        },
      }
      const blocked = await runtime.revertToTurn({ key: f.key, turnSeq: 3, confirmed: true })
      assert.equal(blocked.ok, false)
      await writeFile(join(f.root, 'existing.txt'), 'changed\n')
      yield { ...envelope, type: 'turn_completed', payload: { turnId: input.turnId } }
    },
  }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    const started = await runtime.startSession({ ...f.key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.equal(started.session.capabilities?.checkpoints, true)
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'edit' })
    const replay = await runtime.readTranscript(f.key)
    assert.ok(replay.ok)
    const complete = replay.events.find((event) => event.type === 'turn_completed')!
    assert.equal(complete.payload?.checkpointAvailable, true, JSON.stringify(replay.events))
    assert.deepEqual(complete.payload?.checkpointSummary, { files: 1, addedLines: 1, removedLines: 1 })
    const turnSeq = Number(complete.payload?.checkpointTurnSeq)
    const diff = await runtime.getTurnDiff({ key: f.key, turnSeq, path: 'existing.txt' })
    assert.ok(diff.ok)
    assert.equal(diff.original, 'original\n')
    assert.equal(diff.modified, 'changed\n')
    const reverted = await runtime.revertToTurn({ key: f.key, turnSeq, confirmed: true })
    assert.ok(reverted.ok)
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'continue' })
    assert.match(lastMessage, /Files were reverted/)
  } finally {
    await runtime.shutdown()
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('revert restores work tree files only and leaves the index exactly as the user had it', async () => {
  const f = await repository()
  try {
    const checkpoints = new ConversationCheckpoints()
    await writeFile(join(f.root, 'existing.txt'), 'staged by user\n')
    await git(f.root, ['add', 'existing.txt'])
    await writeFile(join(f.root, 'existing.txt'), 'unstaged by user\n')
    await writeFile(join(f.root, 'notes.txt'), 'untracked by user\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'agent edit\n')
    await writeFile(join(f.root, 'notes.txt'), 'agent edit\n')
    await rm(join(f.root, 'deleted.txt'))
    await writeFile(join(f.root, 'created.txt'), 'agent file\n')
    await git(f.root, ['add', 'created.txt'])
    const index = await readFile(join(f.root, '.git', 'index'))
    const staged = await git(f.root, ['ls-files', '--stage'])
    const preview = await checkpoints.revert({ key: f.key, turnSeq: 1 })
    assert.ok(preview.ok)
    const reverted = await checkpoints.revert({ key: f.key, turnSeq: 1, confirmed: true })
    assert.ok(reverted.ok && reverted.reverted, JSON.stringify(reverted))
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'unstaged by user\n')
    assert.equal(await readFile(join(f.root, 'notes.txt'), 'utf8'), 'untracked by user\n')
    assert.equal(await readFile(join(f.root, 'deleted.txt'), 'utf8'), 'keep\n')
    await assert.rejects(stat(join(f.root, 'created.txt')), { code: 'ENOENT' })
    assert.deepEqual(await readFile(join(f.root, '.git', 'index')), index)
    assert.equal(await git(f.root, ['ls-files', '--stage']), staged)
    assert.match(await git(f.root, ['status', '--porcelain=v1']), /^\?\? notes\.txt$/mu)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
