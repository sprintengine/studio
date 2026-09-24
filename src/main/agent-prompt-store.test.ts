import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AGENT_PROMPTS_DIR_NAME, createAgentPromptStore } from './agent-prompt-store'
import { MAX_LIVE_PEEK_PROMPTS } from './conversation-peek/service'
import { MAX_AGENT_PROMPT_LENGTH } from './agent-state'
import { test } from 'vitest'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sprintengine-agent-prompts-'))
}

const owner = { workspaceId: 'ws-1', agentId: 'agent-1', cli: 'codex', sessionId: 'session-1' }

test('prompts appended for an agent come back from a new store over the same directory', async () => {
  const dir = await scratch()
  const store = createAgentPromptStore({ resolveUserDataDir: () => dir })
  await store.append(owner, { text: 'Port voice dictation', at: 1 })
  await store.append(owner, { text: 'Now the settings page', at: 2 })

  const restarted = createAgentPromptStore({ resolveUserDataDir: () => dir })
  assert.deepEqual(await restarted.read(owner), [
    { text: 'Port voice dictation', at: 1 },
    { text: 'Now the settings page', at: 2 },
  ])
  assert.equal(await restarted.read({ workspaceId: 'ws-1', agentId: 'someone-else' }), null)
})

test('an agent is found by any of its recent sessions', async () => {
  const dir = await scratch()
  const store = createAgentPromptStore({ resolveUserDataDir: () => dir })
  await store.append(owner, { text: 'first', at: 1 })
  await store.append({ ...owner, sessionId: 'session-2' }, { text: 'after a resume', at: 2 })

  const restarted = createAgentPromptStore({ resolveUserDataDir: () => dir })
  const found = await restarted.findBySessionId('session-1')
  assert.deepEqual(found, {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    cli: 'codex',
    prompts: [
      { text: 'first', at: 1 },
      { text: 'after a resume', at: 2 },
    ],
  })
  assert.equal((await restarted.findBySessionId('session-2'))?.agentId, 'agent-1')
  assert.equal(await restarted.findBySessionId('session-unknown'), null)
})

test('files are private and hold no more than the peek can show', async () => {
  const dir = await scratch()
  const store = createAgentPromptStore({ resolveUserDataDir: () => dir })
  await store.append(owner, { text: 'x'.repeat(MAX_AGENT_PROMPT_LENGTH * 3), at: 0 })
  for (let index = 1; index < MAX_LIVE_PEEK_PROMPTS + 20; index += 1) {
    await store.append(owner, { text: `prompt ${index}`, at: index })
  }
  const prompts = (await store.read(owner)) ?? []
  assert.equal(prompts.length, MAX_LIVE_PEEK_PROMPTS)
  assert.equal(prompts[0]?.text.length, MAX_AGENT_PROMPT_LENGTH, 'the first prompt is kept, capped')
  assert.equal(prompts.at(-1)?.text, `prompt ${MAX_LIVE_PEEK_PROMPTS + 19}`)

  if (process.platform !== 'win32') {
    const directory = join(dir, AGENT_PROMPTS_DIR_NAME)
    const [file] = await readdir(directory)
    assert.ok(file)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600)
  }
})

test('the least recently written agents are evicted past the limit', async () => {
  const dir = await scratch()
  let now = 0
  const store = createAgentPromptStore({ resolveUserDataDir: () => dir, maxFiles: 3, now: () => (now += 1) })
  for (const agentId of ['a', 'b', 'c', 'd']) {
    await store.append({ workspaceId: 'ws', agentId }, { text: `hello ${agentId}`, at: 1 })
  }
  assert.equal((await readdir(join(dir, AGENT_PROMPTS_DIR_NAME))).length, 3)
  assert.equal(await store.read({ workspaceId: 'ws', agentId: 'a' }), null, 'the oldest agent went')
  assert.ok(await store.read({ workspaceId: 'ws', agentId: 'd' }))
})

test('merging a session list keeps the stored history and adds only what is new', async () => {
  const dir = await scratch()
  const store = createAgentPromptStore({ resolveUserDataDir: () => dir })
  await store.append(owner, { text: 'from yesterday', at: 1 })
  const merged = await store.merge(owner, [
    { text: 'from yesterday', at: 1 },
    { text: 'from today', at: 5 },
  ])
  assert.deepEqual(merged, [
    { text: 'from yesterday', at: 1 },
    { text: 'from today', at: 5 },
  ])
  assert.deepEqual(await store.read(owner), merged)
})

test('a corrupt or foreign file is ignored, not trusted', async () => {
  const dir = await scratch()
  const directory = join(dir, AGENT_PROMPTS_DIR_NAME)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'garbage.json'), '{ not json')
  await writeFile(
    join(directory, 'foreign.json'),
    JSON.stringify({ version: 2, workspaceId: 'ws-1', agentId: 'agent-1', sessionIds: ['session-1'], prompts: [] }),
  )
  const warnings: string[] = []
  const store = createAgentPromptStore({
    resolveUserDataDir: () => dir,
    logDiagnostic: (diagnostic) => warnings.push(diagnostic.title),
  })
  assert.equal(await store.findBySessionId('session-1'), null)
  assert.ok(warnings.includes('Agent prompt parse failed'))
  // Appending still works beside them.
  await store.append(owner, { text: 'still fine', at: 1 })
  assert.deepEqual(await store.read(owner), [{ text: 'still fine', at: 1 }])
  assert.match(
    await readFile(join(directory, 'garbage.json'), 'utf8'),
    /not json/,
    'nothing it cannot read is rewritten',
  )
})

test('ids that could name a path are refused', async () => {
  const dir = await scratch()
  const store = createAgentPromptStore({ resolveUserDataDir: () => dir })
  assert.deepEqual(await store.append({ workspaceId: '', agentId: 'a' }, { text: 'x', at: 1 }), [])
  assert.equal(await store.read({ workspaceId: 'ws', agentId: 'a\0b' }), null)
  // A hostile id becomes a hash, never a path segment.
  await store.append({ workspaceId: '../../etc', agentId: 'passwd' }, { text: 'x', at: 1 })
  const names = await readdir(join(dir, AGENT_PROMPTS_DIR_NAME))
  assert.ok(
    names.every((name) => /^[0-9a-f]{32}\.json$/.test(name)),
    names.join(','),
  )
})
