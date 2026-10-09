import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { parseBacklogFrontmatter } from '../../shared/backlog/frontmatter'
import { readBacklogObjectStore } from '../backlog-service'
import { createModuleBacklogRegistry, type ModuleBacklogWorkspace } from './module-backlog'

let root: string
let workspaces: ModuleBacklogWorkspace[]
let permissions: Record<string, readonly string[]>

const registry = () =>
  createModuleBacklogRegistry({
    getWorkspace: (id) => workspaces.find((workspace) => workspace.id === id) ?? null,
    getModulePermissions: (moduleId) => permissions[moduleId],
  })

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'se-module-backlog-')))
  await mkdir(join(root, 'backlog', 'unfiled'), { recursive: true })
  await writeFile(
    join(root, 'backlog', 'unfiled', '2026-10-01-checkout.md'),
    '---\nid: 7\nstatus: ready\nepic: payments\n---\n# Checkout\n\nSpeed it up.\n',
  )
  // The workspace's committed display key.
  await mkdir(join(root, '.sprintengine', 'backlog'), { recursive: true })
  await writeFile(join(root, '.sprintengine', 'backlog', 'config.json'), '{"schemaVersion":2,"key":"MC"}\n')
  workspaces = [
    { id: 'ws-1', name: 'acme', folderPath: root },
    { id: 'ws-bare', name: 'scratch', folderPath: null },
  ]
  permissions = {
    board: ['backlog.read', 'backlog.write'],
    reader: ['backlog.read'],
    nobody: [],
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ITEM = 'backlog/unfiled/2026-10-01-checkout.md'

test('list reads the items with their number, display id, epic and modification time', async () => {
  const listed = await registry().list('reader', 'ws-1')
  assert.equal(listed.ok, true)
  if (!listed.ok) return
  assert.equal(listed.items.length, 1)
  const [item] = listed.items
  assert.equal(item!.id, ITEM)
  assert.equal(item!.status, 'ready')
  assert.equal(item!.numericId, 7)
  assert.equal(item!.displayId, 'MC-7')
  assert.equal(item!.epic, 'payments')
  assert.equal(typeof item!.modifiedAt, 'number')
})

test('reads need backlog.read and writes need backlog.write', async () => {
  const reads = await registry().list('nobody', 'ws-1')
  assert.deepEqual(reads.ok ? null : reads.code, 'permission_missing')
  const location = await registry().getLocation('nobody', 'ws-1')
  assert.equal(location.ok ? null : location.code, 'permission_missing')
  const write = await registry().updateStatus('reader', 'ws-1', ITEM, 'completed')
  assert.equal(write.ok ? null : write.code, 'permission_missing')
  const created = await registry().create('reader', 'ws-1', { title: 'Nope' })
  assert.equal(created.ok ? null : created.code, 'permission_missing')
  // Nothing was written.
  assert.match(await readFile(join(root, ITEM), 'utf-8'), /status: ready/)
})

test('a workspace that is unknown or has no folder is said, not guessed', async () => {
  const unknown = await registry().list('board', 'ws-missing')
  assert.equal(unknown.ok ? null : unknown.code, 'unknown_workspace')
  const bare = await registry().updateStatus('board', 'ws-bare', ITEM, 'ready')
  assert.equal(bare.ok ? null : bare.code, 'workspace_folder_missing')
})

test('getLocation reports the default root', async () => {
  const location = await registry().getLocation('reader', 'ws-1')
  assert.deepEqual(location, { ok: true, location: { root: join(root, 'backlog'), isDefault: true, exists: true } })
})

test('updateStatus writes the frontmatter through the Backlog service and keeps the body', async () => {
  const result = await registry().updateStatus('board', 'ws-1', ITEM, 'in_progress')
  assert.deepEqual(result, { ok: true })
  const content = await readFile(join(root, ITEM), 'utf-8')
  const { fields, body } = parseBacklogFrontmatter(content)
  assert.equal(fields.status, 'in_progress')
  assert.ok(fields.updated)
  assert.equal(body.trim(), '# Checkout\n\nSpeed it up.')
})

test('a status or item the app does not know is refused before anything is written', async () => {
  const badStatus = await registry().updateStatus('board', 'ws-1', ITEM, 'shipped' as never)
  assert.equal(badStatus.ok ? null : badStatus.code, 'invalid_input')
  const missing = await registry().updateStatus('board', 'ws-1', 'backlog/unfiled/nothing.md', 'ready')
  assert.equal(missing.ok ? null : missing.code, 'not_found')
  // A link on a missing item must not conjure a record for it.
  const link = await registry().addLink('board', 'ws-1', 'backlog/unfiled/nothing.md', {
    id: 'l1',
    type: 'external',
    label: 'Docs',
    target: { kind: 'url', id: 'docs', url: 'https://example.com' },
  })
  assert.equal(link.ok ? null : link.code, 'not_found')
  const store = await readBacklogObjectStore(root)
  assert.deepEqual(store.ok ? store.store.items : null, [])
  const escape = await registry().updateStatus('board', 'ws-1', 'backlog/../../etc/passwd', 'ready')
  assert.equal(escape.ok, false)
})

test('updateTriage touches only the axes given and clears with null', async () => {
  assert.deepEqual(await registry().updateTriage('board', 'ws-1', ITEM, { difficulty: 'm', risk: 'high' }), {
    ok: true,
  })
  let fields = parseBacklogFrontmatter(await readFile(join(root, ITEM), 'utf-8')).fields
  assert.equal(fields.difficulty, 'm')
  assert.equal(fields.risk, 'high')
  assert.deepEqual(await registry().updateTriage('board', 'ws-1', ITEM, { risk: null }), { ok: true })
  fields = parseBacklogFrontmatter(await readFile(join(root, ITEM), 'utf-8')).fields
  assert.equal(fields.difficulty, 'm')
  assert.equal(fields.risk, undefined)
  const bad = await registry().updateTriage('board', 'ws-1', ITEM, { criticality: 'urgent' })
  assert.equal(bad.ok ? null : bad.code, 'invalid_input')
})

test('create goes through the app create path: next id, epic folder, display id', async () => {
  const created = await registry().create('board', 'ws-1', {
    title: 'Faster refunds',
    body: 'Refunds take a day.',
    status: 'ready',
    type: 'feature',
    epic: 'payments',
    difficulty: 's',
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.numericId, 8)
  assert.equal(created.displayId, 'MC-8')
  assert.match(created.relativePath, /^backlog\/payments\/\d{4}-\d{2}-\d{2}-faster-refunds\.md$/)
  assert.equal(created.id, created.relativePath)
  assert.equal(created.path, join(root, created.relativePath))
  const { fields, body } = parseBacklogFrontmatter(await readFile(created.path, 'utf-8'))
  assert.equal(fields.id, '8')
  assert.equal(fields.status, 'ready')
  assert.equal(fields.type, 'feature')
  assert.equal(fields.difficulty, 's')
  assert.match(body, /# Faster refunds\n\nRefunds take a day\./)

  // The same title again gets a file of its own, never a clobber.
  const again = await registry().create('board', 'ws-1', { title: 'Faster refunds', epic: 'payments' })
  assert.ok(again.ok && again.relativePath !== created.relativePath)
  assert.ok(again.ok && again.numericId === 9)
})

test('create refuses what the app does not know', async () => {
  for (const input of [
    { title: '' },
    { title: 'x', status: 'archived' as const },
    { title: 'x', type: 'saga' },
    { title: 'x', epic: '../escape' },
    { title: 'x', risk: 'extreme' },
  ]) {
    const result = await registry().create('board', 'ws-1', input)
    assert.equal(result.ok ? null : result.code, 'invalid_input', JSON.stringify(input))
  }
})

test('concurrent creates from two modules never share an id', async () => {
  permissions.other = ['backlog.write']
  const results = await Promise.all([
    registry().create('board', 'ws-1', { title: 'One' }),
    registry().create('other', 'ws-1', { title: 'Two' }),
    registry().create('board', 'ws-1', { title: 'Three' }),
  ])
  const ids = results.map((result) => (result.ok ? result.numericId : null))
  assert.deepEqual(
    [...ids].sort((a, b) => (a ?? 0) - (b ?? 0)),
    [8, 9, 10],
  )
})

test('addLink stamps the caller as the owner and refuses another module id', async () => {
  const link = {
    id: 'board-agent',
    type: 'external' as const,
    label: 'Board',
    target: { kind: 'url', id: 'board', url: 'https://example.com/board' },
  }
  assert.deepEqual(await registry().addLink('board', 'ws-1', ITEM, link), { ok: true })
  const listed = await registry().list('reader', 'ws-1')
  const item = listed.ok ? listed.items.find((candidate) => candidate.id === ITEM) : undefined
  assert.equal(item?.links.find((candidate) => candidate.id === 'board-agent')?.moduleId, 'board')

  const spoofed = await registry().addLink('board', 'ws-1', ITEM, { ...link, moduleId: 'backlog' })
  assert.equal(spoofed.ok ? null : spoofed.code, 'invalid_input')
})

test('updateModuleMetadata writes under the caller module id only', async () => {
  assert.deepEqual(await registry().updateModuleMetadata('board', 'ws-1', ITEM, { lane: 'doing' }), { ok: true })
  const listed = await registry().list('reader', 'ws-1')
  const item = listed.ok ? listed.items.find((candidate) => candidate.id === ITEM) : undefined
  assert.deepEqual(item?.metadata, { board: { lane: 'doing' } })
})
