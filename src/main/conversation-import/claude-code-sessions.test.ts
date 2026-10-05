import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { claudePromptText, readClaudeCodeSession, scanClaudeCodeSessions } from './claude-code-sessions'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const CWD = '/Users/dev/acme-app'
const SESSION = '5f1c2a3e-0000-4000-8000-000000000001'

function base(extra: Record<string, unknown>, at: string): Record<string, unknown> {
  return { sessionId: SESSION, cwd: CWD, entrypoint: 'cli', isSidechain: false, timestamp: at, ...extra }
}

function sessionRecords(): Array<Record<string, unknown>> {
  return [
    base(
      { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local commands' } },
      '2026-09-01T10:00:00Z',
    ),
    base(
      { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Fix the flaky login test' } },
      '2026-09-01T10:00:01Z',
    ),
    { type: 'ai-title', sessionId: SESSION, aiTitle: 'Flaky login test' },
    base(
      {
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'thinking', thinking: 'Look at it.' }] },
      },
      '2026-09-01T10:00:02Z',
    ),
    base(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the test.' }] } },
      '2026-09-01T10:00:03Z',
    ),
    base(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      '2026-09-01T10:00:04Z',
    ),
    base(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Exit code 1\n1 failed', is_error: true }],
        },
        toolUseResult: { stdout: '', stderr: '1 failed', interrupted: false },
      },
      '2026-09-01T10:00:05Z',
    ),
    // A spawned agent's step, and a background task's report: neither is the conversation.
    base(
      {
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] },
      },
      '2026-09-01T10:00:06Z',
    ),
    base(
      {
        type: 'user',
        origin: { kind: 'task-notification' },
        promptSource: 'system',
        message: { role: 'user', content: '<task-notification>done</task-notification>' },
      },
      '2026-09-01T10:00:07Z',
    ),
    base(
      {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
        },
      },
      '2026-09-01T10:00:08Z',
    ),
    base(
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 9000 } },
      '2026-09-01T10:00:09Z',
    ),
    base(
      { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } },
      '2026-09-01T10:00:10Z',
    ),
  ]
}

async function fixture(): Promise<{ projects: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sprintengine-claude-import-'))
  roots.add(root)
  const projects = join(root, 'projects')
  const folder = join(projects, '-Users-dev-acme-app')
  await mkdir(join(folder, SESSION, 'subagents'), { recursive: true })
  const file = join(folder, `${SESSION}.jsonl`)
  await writeFile(
    file,
    `${sessionRecords()
      .map((record) => JSON.stringify(record))
      .join('\n')}\nnot json\n`,
  )
  await writeFile(
    join(folder, SESSION, 'subagents', 'agent-1.jsonl'),
    `${JSON.stringify(base({ type: 'user', message: { role: 'user', content: 'sub task' } }, '2026-09-01T10:00:00Z'))}\n`,
  )
  // A session the Agent SDK ran is a program's: this app's own chats among them.
  await writeFile(
    join(folder, 'aaaaaaaa-0000-4000-8000-000000000002.jsonl'),
    `${JSON.stringify({ ...base({ type: 'user', message: { role: 'user', content: 'hi' } }, '2026-09-02T10:00:00Z'), entrypoint: 'sdk-ts', sessionId: 'sdk' })}\n`,
  )
  // A session nobody typed into: the CLI opened and closed.
  await writeFile(
    join(folder, 'bbbbbbbb-0000-4000-8000-000000000003.jsonl'),
    `${JSON.stringify({ type: 'ai-title', aiTitle: 'Nothing' })}\n`,
  )
  await utimes(file, new Date('2026-09-01T10:00:10Z'), new Date('2026-09-01T10:00:10Z'))
  return { projects, file }
}

test('the scan lists the sessions a person typed into, with their folder and title', async () => {
  const { projects, file } = await fixture()
  const sessions = await scanClaudeCodeSessions(projects)
  assert.deepEqual(sessions, [
    {
      source: 'claude-code',
      sessionId: SESSION,
      path: file,
      folderPath: CWD,
      title: 'Flaky login test',
      firstPrompt: 'Fix the flaky login test',
      startedAt: Date.parse('2026-09-01T10:00:00Z'),
      updatedAt: Date.parse('2026-09-01T10:00:10Z'),
    },
  ])
})

test('a scan of a home with no sessions is empty, not an error', async () => {
  assert.deepEqual(await scanClaudeCodeSessions('/Users/dev/no-such-claude/projects'), [])
})

test('a session reads back as turns of the person’s messages, with the steps drawn as the live adapter draws them', async () => {
  const { file } = await fixture()
  const history = await readClaudeCodeSession(file, 0)
  assert.equal(history.title, 'Flaky login test')
  assert.equal(history.firstPrompt, 'Fix the flaky login test')
  assert.deepEqual(
    history.events.map((entry) => entry.type),
    [
      'user_message',
      'turn_started',
      'reasoning_delta',
      'content_delta',
      'tool_started',
      'tool_output',
      'turn_completed',
      'user_message',
      'turn_started',
      'context_compacted',
      'turn_completed',
    ],
  )
  const messages = history.events.filter((entry) => entry.type === 'user_message').map((entry) => entry.payload.text)
  assert.deepEqual(messages, ['Fix the flaky login test', '/compact'])
  const step = history.events.find((entry) => entry.type === 'tool_started')
  assert.equal(step?.payload.kind, 'command')
  assert.equal(step?.payload.toolUseId, 'toolu_1')
  assert.deepEqual(step?.payload.input, { command: 'npm test' })
  const result = history.events.find((entry) => entry.type === 'tool_output')
  assert.equal(result?.payload.status, 'error')
  assert.equal(result?.payload.exitCode, 1)
  assert.equal(result?.payload.turnId, 'turn_import_1')
  assert.equal(history.startedAt, Date.parse('2026-09-01T10:00:01Z'))
})

test('the person’s message is unwrapped from the tags the CLI puts around it', () => {
  assert.equal(claudePromptText('plain'), 'plain')
  assert.equal(
    claudePromptText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    'a\n\nb',
  )
  assert.equal(claudePromptText('<command-name>/review</command-name><command-args>12</command-args>'), '/review 12')
  assert.equal(claudePromptText('<bash-input>git status</bash-input>'), '!git status')
  assert.equal(claudePromptText('<local-command-stdout>ok</local-command-stdout>'), null)
  assert.equal(claudePromptText('[Request interrupted by user]'), null)
  assert.equal(claudePromptText('<system-reminder>note</system-reminder>\nkeep this'), 'keep this')
})
