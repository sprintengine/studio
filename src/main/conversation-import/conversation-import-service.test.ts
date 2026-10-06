import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { ConversationImportTranscriptInput } from '../../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../../shared/launch-settings'
import type { WorkspaceCreateRequest } from '../workspace-registry-service'
import { createConversationImportService, type ConversationImportWorkspace } from './conversation-import-service'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const NOW = Date.parse('2026-09-10T12:00:00Z')

const jsonl = (records: Array<Record<string, unknown>>) =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`

function claudeSession(id: string, cwd: string, prompt: string): Array<Record<string, unknown>> {
  const common = { sessionId: id, cwd, entrypoint: 'cli' }
  return [
    { ...common, type: 'user', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: prompt } },
    {
      ...common,
      type: 'assistant',
      timestamp: '2026-09-01T10:00:05Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    },
  ]
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'sprintengine-import-service-'))
  roots.add(home)
  const app = join(home, 'code', 'app')
  const site = join(home, 'code', 'site')
  await mkdir(app, { recursive: true })
  await mkdir(site, { recursive: true })
  const projects = join(home, '.claude', 'projects', 'any')
  await mkdir(projects, { recursive: true })
  const write = async (path: string, records: Array<Record<string, unknown>>, at: string) => {
    await writeFile(path, jsonl(records))
    await utimes(path, new Date(at), new Date(at))
  }
  await write(
    join(projects, 'claude-1.jsonl'),
    claudeSession('claude-1', app, 'Fix the login bug'),
    '2026-09-01T10:00:05Z',
  )
  await write(
    join(projects, 'claude-2.jsonl'),
    claudeSession('claude-2', site, 'Write the docs'),
    '2026-09-03T10:00:05Z',
  )
  // A session a terminal agent here already runs, and one in a folder that is gone.
  await write(
    join(projects, 'claude-3.jsonl'),
    claudeSession('claude-3', app, 'Resumed already'),
    '2026-09-04T10:00:05Z',
  )
  await write(
    join(projects, 'claude-4.jsonl'),
    claudeSession('claude-4', join(home, 'gone'), 'Deleted folder'),
    '2026-09-05T10:00:05Z',
  )
  const day = join(home, '.codex', 'sessions', '2026', '09', '02')
  await mkdir(day, { recursive: true })
  await write(
    join(day, 'rollout-2026-09-02T09-00-00-codex-1.jsonl'),
    [
      { timestamp: '2026-09-02T09:00:00Z', type: 'session_meta', payload: { id: 'codex-1', cwd: app, source: 'cli' } },
      {
        timestamp: '2026-09-02T09:00:01Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add caching' }] },
      },
    ],
    '2026-09-02T09:00:01Z',
  )
  return { home, app, site }
}

function harness(home: string, workspaces: ConversationImportWorkspace[] = []) {
  const created: WorkspaceCreateRequest[] = []
  const removed: string[] = []
  const transcripts: ConversationImportTranscriptInput[] = []
  let failTranscript = false
  const service = createConversationImportService({
    listWorkspaces: () => [
      ...workspaces,
      ...created.map((request, index) => ({ id: `ws-${index + 1}`, agents: request.agents })),
    ],
    createWorkspace: (request) => {
      created.push(request)
      return { ok: true, workspaceId: `ws-${created.length}` }
    },
    removeWorkspace: (workspaceId) => removed.push(workspaceId),
    importTranscript: async (input) => {
      transcripts.push(input)
      return failTranscript ? { ok: false, message: 'Disk full.' } : { ok: true }
    },
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    homeDir: () => home,
    env: () => ({}),
    now: () => NOW,
    newAgentSuffix: () => `n${created.length + 1}`,
  })
  return {
    service,
    created,
    removed,
    transcripts,
    failNext: () => {
      failTranscript = true
    },
  }
}

test('the scan groups both CLIs’ sessions by folder, newest first, leaving out what the app already runs', async () => {
  const { home, app, site } = await fixture()
  const terminal: ConversationImportWorkspace = { id: 'terminal', agents: { a: { cliSessionId: 'claude-3' } } }
  const scan = await harness(home, [terminal]).service.scan()
  assert.ok(scan.ok)
  assert.deepEqual(scan.sources, ['claude-code', 'codex'])
  assert.deepEqual(
    scan.folders.map((folder) => [folder.folderPath, folder.name, folder.sessions.map((session) => session.sessionId)]),
    [
      [site, 'site', ['claude-2']],
      [app, 'app', ['codex-1', 'claude-1']],
    ],
  )
  assert.equal(scan.folders[1]?.sessions[1]?.title, 'Fix the login bug')
})

test('an import makes each session a chat in its folder that resumes the session', async () => {
  const { home, app } = await fixture()
  const t = harness(home)
  const result = await t.service.importSessions({
    sessions: [
      { source: 'claude-code', sessionId: 'claude-1' },
      { source: 'codex', sessionId: 'codex-1' },
    ],
  })
  assert.deepEqual(result, {
    ok: true,
    imported: [
      { source: 'claude-code', sessionId: 'claude-1', workspaceId: 'ws-1', agentId: 'agent-claude-code-n1' },
      { source: 'codex', sessionId: 'codex-1', workspaceId: 'ws-2', agentId: 'agent-codex-n2' },
    ],
    skipped: 0,
    failed: [],
  })
  const [claude, codex] = t.created
  assert.equal(claude?.folderPath, app)
  assert.equal(claude?.name, 'Fix the login bug')
  assert.equal(claude?.background, true)
  assert.deepEqual(claude?.imported, {
    startedAt: Date.parse('2026-09-01T10:00:00Z'),
    lastActiveAt: Date.parse('2026-09-01T10:00:05Z'),
  })
  const agent = claude?.agents?.['agent-claude-code-n1']
  assert.equal(agent?.runtimeKind, 'conversation')
  assert.deepEqual(agent?.conversation, { providerId: 'claude-agent', modelId: 'default' })
  assert.deepEqual(agent?.importedFrom, { source: 'claude-code', sessionId: 'claude-1' })
  assert.deepEqual(codex?.agents?.['agent-codex-n2']?.conversation, { providerId: 'codex-agent', modelId: 'default' })

  assert.deepEqual(
    t.transcripts.map((input) => [input.key, input.providerSessionId, input.events.map((entry) => entry.type)]),
    [
      [
        { workspaceRoot: app, workspaceId: 'ws-1', agentId: 'agent-claude-code-n1' },
        'claude-1',
        ['user_message', 'turn_started', 'content_delta', 'turn_completed'],
      ],
      [
        { workspaceRoot: app, workspaceId: 'ws-2', agentId: 'agent-codex-n2' },
        'codex-1',
        ['user_message', 'turn_started', 'turn_completed'],
      ],
    ],
  )
})

test('a session that is already a chat is skipped, and the scan says so', async () => {
  const { home } = await fixture()
  const t = harness(home)
  await t.service.importSessions({ sessions: [{ source: 'claude-code', sessionId: 'claude-1' }] })
  const again = await t.service.importSessions({
    sessions: [
      { source: 'claude-code', sessionId: 'claude-1' },
      { source: 'claude-code', sessionId: 'claude-1' },
    ],
  })
  assert.ok(again.ok)
  assert.deepEqual([again.imported.length, again.skipped], [0, 2])
  assert.equal(t.created.length, 1)
  const scan = await t.service.scan()
  assert.ok(scan.ok)
  const sessions = scan.folders.flatMap((folder) => folder.sessions)
  assert.equal(sessions.find((session) => session.sessionId === 'claude-1')?.imported, true)
  assert.equal(sessions.find((session) => session.sessionId === 'codex-1')?.imported, false)
})

test('a chat whose history could not be written is taken back out', async () => {
  const { home } = await fixture()
  const t = harness(home)
  t.failNext()
  const result = await t.service.importSessions({ sessions: [{ source: 'claude-code', sessionId: 'claude-1' }] })
  assert.ok(result.ok)
  assert.deepEqual(result.failed, [
    { source: 'claude-code', sessionId: 'claude-1', title: 'Fix the login bug', message: 'Disk full.' },
  ])
  assert.deepEqual(t.removed, ['ws-1'])
})

test('a session that is not on disk any more fails on its own', async () => {
  const { home } = await fixture()
  const result = await harness(home).service.importSessions({
    sessions: [
      { source: 'codex', sessionId: 'missing' },
      { source: 'claude-code', sessionId: 'claude-4' },
    ],
  })
  assert.ok(result.ok)
  assert.deepEqual(
    result.failed.map((entry) => entry.sessionId),
    ['missing', 'claude-4'],
  )
})

test('a machine with neither CLI has nothing to import', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sprintengine-import-empty-'))
  roots.add(home)
  assert.deepEqual(await harness(home).service.scan(), { ok: true, folders: [], sources: [] })
})
