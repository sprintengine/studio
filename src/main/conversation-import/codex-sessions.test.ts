import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { codexToolCall, codexToolOutput, readCodexSession, scanCodexSessions } from './codex-sessions'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const CWD = '/Users/dev/acme-app'

function meta(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-09-02T09:00:00Z',
    type: 'session_meta',
    payload: { id, cwd: CWD, originator: 'codex-tui', source: 'cli', timestamp: '2026-09-02T09:00:00Z', ...extra },
  }
}

function item(type: string, payload: Record<string, unknown>, at = '2026-09-02T09:00:01Z'): Record<string, unknown> {
  return { timestamp: at, type, payload }
}

const userText = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })

function rollout(id: string, prompts: 'events' | 'model'): Array<Record<string, unknown>> {
  const promptRecords = (text: string, at: string) =>
    prompts === 'events'
      ? [
          item('response_item', userText(text), at),
          item(
            'event_msg',
            { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } },
            at,
          ),
        ]
      : [item('response_item', userText(text), at)]
  return [
    meta(id),
    item('response_item', {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<permissions instructions>' }],
    }),
    item('response_item', userText('<environment_context>\n  <cwd>/Users/dev/acme-app</cwd>')),
    item('response_item', userText('# AGENTS.md instructions for /Users/dev/acme-app')),
    ...promptRecords('Add a health check endpoint', '2026-09-02T09:00:02Z'),
    item('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Find the router.' }] }),
    item('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Looking at the routes.' }],
    }),
    item('response_item', {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call_1',
      arguments: JSON.stringify({ cmd: 'rg health', workdir: CWD }),
    }),
    item('response_item', {
      type: 'function_call_output',
      call_id: 'call_1',
      output: JSON.stringify({ output: 'src/routes.ts', metadata: { exit_code: 0 } }),
    }),
    item('response_item', {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'call_2',
      input: '*** Begin Patch\n*** Update File: src/routes.ts\n@@\n+health\n*** End Patch',
    }),
    item('response_item', { type: 'custom_tool_call_output', call_id: 'call_2', output: 'Success.' }),
    item('compacted', { message: '' }),
    ...promptRecords('Now add a test', '2026-09-02T09:05:00Z'),
  ]
}

async function fixture(): Promise<{ home: string; file: string }> {
  const home = await mkdtemp(join(tmpdir(), 'sprintengine-codex-import-'))
  roots.add(home)
  const day = join(home, 'sessions', '2026', '09', '02')
  await mkdir(day, { recursive: true })
  const write = (name: string, records: Array<Record<string, unknown>>) =>
    writeFile(join(day, name), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const file = join(day, 'rollout-2026-09-02T09-00-00-thread-a.jsonl')
  await write('rollout-2026-09-02T09-00-00-thread-a.jsonl', rollout('thread-a', 'events'))
  // Not a person's session: this app's own chat, a subagent Codex spawned, a `codex exec`.
  await write('rollout-2026-09-02T09-01-00-thread-b.jsonl', [
    meta('thread-b', { originator: 'sprintengine_studio' }),
    item('response_item', userText('hi')),
  ])
  await write('rollout-2026-09-02T09-02-00-thread-c.jsonl', [
    meta('thread-c', { source: { subagent: { thread_spawn: { depth: 1 } } } }),
    item('response_item', userText('hi')),
  ])
  await write('rollout-2026-09-02T09-03-00-thread-d.jsonl', [
    meta('thread-d', { source: 'exec' }),
    item('response_item', userText('hi')),
  ])
  await writeFile(
    join(home, 'session_index.jsonl'),
    `${JSON.stringify({ id: 'thread-a', thread_name: 'Health check endpoint', updated_at: '2026-09-02T09:05:00Z' })}\n`,
  )
  return { home, file }
}

test('the scan lists the sessions a person ran, titled from the session index', async () => {
  const { home, file } = await fixture()
  const sessions = await scanCodexSessions(home)
  assert.equal(sessions.length, 1)
  assert.deepEqual(
    { ...sessions[0], updatedAt: 0 },
    {
      source: 'codex',
      sessionId: 'thread-a',
      path: file,
      folderPath: CWD,
      title: 'Health check endpoint',
      firstPrompt: 'Add a health check endpoint',
      startedAt: Date.parse('2026-09-02T09:00:00Z'),
      updatedAt: 0,
    },
  )
})

test('a session reads back with the person’s own messages, not the context Codex injects', async () => {
  const { file } = await fixture()
  const history = await readCodexSession(file, 0)
  const messages = history.events.filter((entry) => entry.type === 'user_message').map((entry) => entry.payload.text)
  assert.deepEqual(messages, ['Add a health check endpoint', 'Now add a test'])
  assert.deepEqual(
    history.events.map((entry) => entry.type),
    [
      'user_message',
      'turn_started',
      'reasoning_delta',
      'content_delta',
      'tool_started',
      'tool_output',
      'tool_started',
      'tool_output',
      'context_compacted',
      'turn_completed',
      'user_message',
      'turn_started',
      'turn_completed',
    ],
  )
  const [command, patch] = history.events.filter((entry) => entry.type === 'tool_started')
  assert.deepEqual(command?.payload.input, { command: 'rg health', cwd: CWD })
  assert.equal(command?.payload.kind, 'command')
  assert.equal(patch?.payload.kind, 'file_edit')
  assert.equal((patch?.payload.input as { path?: string }).path, 'src/routes.ts')
  const outputs = history.events.filter((entry) => entry.type === 'tool_output')
  assert.deepEqual(
    outputs.map((entry) => [entry.payload.output, entry.payload.exitCode]),
    [
      ['src/routes.ts', 0],
      ['Success.', undefined],
    ],
  )
})

test('a Codex that records no message events has its messages read from the model’s copy', async () => {
  const { home } = await fixture()
  const day = join(home, 'sessions', '2026', '09', '02')
  const file = join(day, 'rollout-2026-09-02T09-04-00-thread-e.jsonl')
  await writeFile(
    file,
    `${rollout('thread-e', 'model')
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  )
  const history = await readCodexSession(file, 0)
  const messages = history.events.filter((entry) => entry.type === 'user_message').map((entry) => entry.payload.text)
  assert.deepEqual(messages, ['Add a health check endpoint', 'Now add a test'])
  assert.ok((await scanCodexSessions(home)).some((session) => session.sessionId === 'thread-e'))
})

test('a failed command is a failed step', () => {
  assert.deepEqual(codexToolOutput(JSON.stringify({ output: 'boom', metadata: { exit_code: 2 } })), {
    output: 'boom',
    status: 'error',
    isError: true,
    exitCode: 2,
  })
  assert.deepEqual(codexToolCall({ type: 'function_call', name: 'shell', arguments: '{"command":["ls","-la"]}' }), {
    name: 'Bash',
    kind: 'command',
    input: { command: 'ls -la' },
  })
})
