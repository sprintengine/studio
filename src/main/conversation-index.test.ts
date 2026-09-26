import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConversationIndex, conversationIndexTranscriptPath, firstMessageTitle } from './conversation-index'
import type { ConversationEvent } from '../shared/conversation-runtime'

async function fixture(
  run: (key: { workspaceRoot: string; workspaceId: string; agentId: string }, path: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-index-'))
  const key = { workspaceRoot: root, workspaceId: 'workspace', agentId: 'agent' }
  const path = conversationIndexTranscriptPath(key)
  await mkdir(join(root, '.sprintengine', 'conversations', 'workspace'), { recursive: true })
  try {
    await run(key, path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function event(
  seq: number,
  type: ConversationEvent['type'],
  payload: Record<string, unknown>,
  agentId = 'agent',
): ConversationEvent {
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId,
    providerId: 'provider',
    modelId: 'model',
    createdAt: seq * 1000,
    type,
    payload,
  }
}
const lines = (events: ConversationEvent[]) => `${events.map((value) => JSON.stringify(value)).join('\n')}\n`

test('missing, corrupt and old-version caches rebuild from authoritative events', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Build a useful chat' }),
        event(2, 'turn_completed', { turnId: 'turn' }),
      ]),
    )
    const index = new ConversationIndex(),
      cache = join(key.workspaceRoot, '.sprintengine', 'conversations', key.workspaceId, 'index.json')
    expect(await index.list(key)).toMatchObject([
      { agentId: 'agent', title: 'Build a useful chat', titleSource: 'first-message', turnCount: 1, lastSeq: 2 },
    ])
    for (const invalid of ['{broken', '{"version":0,"threads":[],"files":[]}']) {
      await writeFile(cache, invalid)
      expect((await index.list(key))[0]?.title).toBe('Build a useful chat')
    }
    expect(JSON.parse(await readFile(cache, 'utf8')).version).toBe(1)
  }))

test('user rename survives rebuild and always wins over a generated title', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { text: 'Initial title' }),
        event(2, 'session_updated', { conversationTitle: 'My title', titleSource: 'user' }),
        event(3, 'session_updated', { conversationTitle: 'Generated later', titleSource: 'generated' }),
      ]),
    )
    expect((await new ConversationIndex().list(key))[0]).toMatchObject({ title: 'My title', titleSource: 'user' })
    expect(firstMessageTitle('  one\n two  ')).toBe('one two')
    expect(firstMessageTitle('x'.repeat(100))).toHaveLength(60)
  }))

test('search joins split assistant deltas and returns a jumpable user-turn sequence', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Question' }),
        event(2, 'content_delta', { turnId: 'turn', text: 'The alpha ' }),
        event(3, 'content_delta', { turnId: 'turn', text: 'beta answer.' }),
      ]),
    )
    const batches: unknown[] = []
    expect(
      await new ConversationIndex().search(
        { ...key, query: 'ALPHA BETA' },
        { onBatch: (batch) => batches.push(batch) },
      ),
    ).toEqual([{ agentId: 'agent', seq: 1, turnId: 'turn', snippet: 'The alpha beta answer.' }])
    expect(batches).toHaveLength(1)
  }))

test('refresh creates the cache and a later append invalidates a stale cache', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 'one', text: 'First' })]))
    const index = new ConversationIndex()
    await index.refresh(key)
    expect(
      await stat(join(key.workspaceRoot, '.sprintengine', 'conversations', key.workspaceId, 'index.json')),
    ).toBeDefined()
    await appendFile(path, lines([event(2, 'user_message', { turnId: 'two', text: 'Second' })]))
    expect((await index.list(key))[0]?.turnCount).toBe(2)
  }))

test('search caps hits, emits bounded batches and honours cancellation', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines(
        Array.from({ length: 500 }, (_, index) =>
          event(index + 1, 'user_message', { turnId: `turn-${index}`, text: 'match' }),
        ),
      ),
    )
    const index = new ConversationIndex(),
      batches: number[] = []
    expect(
      await index.search({ ...key, query: 'match' }, { onBatch: (batch) => batches.push(batch.length) }),
    ).toHaveLength(200)
    expect(batches).toEqual(Array.from({ length: 10 }, () => 20))
    const controller = new AbortController()
    controller.abort()
    await expect(index.search({ ...key, query: 'match' }, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  }))

test('delete closes the transcript and removes only its log, detail directory and cache row', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { text: 'One' })]))
    const other = conversationIndexTranscriptPath({ ...key, agentId: 'other' })
    await writeFile(other, lines([event(1, 'user_message', { text: 'Other' }, 'other')]))
    const tools = path.replace(/\.jsonl$/, '.tools')
    await mkdir(tools)
    await writeFile(join(tools, 'tool.json'), '{}')
    const closed: string[] = [],
      index = new ConversationIndex({
        close: async (value) => {
          closed.push(value)
        },
      })
    await index.list(key)
    await index.delete(key)
    expect(closed).toEqual([path])
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(tools)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await index.list(key)).toMatchObject([{ agentId: 'other' }])
    expect(await readFile(other, 'utf8')).toContain('Other')
  }))

test('cancellation during a streamed batch stops without leaking a stream error', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines(
        Array.from({ length: 1000 }, (_, index) =>
          event(index + 1, 'user_message', { turnId: `turn-${index}`, text: `match ${'padding '.repeat(200)}` }),
        ),
      ),
    )
    const controller = new AbortController()
    await expect(
      new ConversationIndex().search(
        { ...key, query: 'match' },
        {
          signal: controller.signal,
          onBatch: () => controller.abort(),
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  }))

test('a symlink transcript is neither searched nor deleted through', async () =>
  fixture(async (key, path) => {
    const outside = join(key.workspaceRoot, 'private.jsonl')
    await writeFile(outside, lines([event(1, 'user_message', { text: 'private match' })]))
    await symlink(outside, path)
    const index = new ConversationIndex()
    expect(await index.search({ ...key, query: 'private' })).toEqual([])
    await expect(index.delete(key)).rejects.toThrow('symbolic link')
    expect(await readFile(outside, 'utf8')).toContain('private match')
  }))

test('coalesced delta sequence ranges survive index rebuild', async () =>
  fixture(async (key, path) => {
    const merged = {
      ...event(2, 'content_delta', { turnId: 'turn', text: 'ab' }),
      parts: [
        ['first', 2000, 1, 2],
        ['second', 3000, 1, 3],
      ],
    }
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Question' }),
        merged,
        event(4, 'turn_completed', { turnId: 'turn' }),
      ]),
    )
    expect((await new ConversationIndex().list(key))[0]?.lastSeq).toBe(4)
  }))
