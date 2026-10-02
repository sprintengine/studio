import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { parseStudioMethodParams } from '../../../packages/studio-protocol/src/public'
import { createStudioFiles } from './studio-files'
import {
  OWNER_TOKEN,
  connectLineClient,
  createFakeAuthenticator,
  hello,
  pairFakeClient,
  startTestServer,
} from './studio-rpc.test-helper'

// Files by root and relative path: confinement, the board-only write, the
// conditional atomic write, and the watch.

const directories: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'studio-files-'))
  directories.push(base)
  const workspace = join(base, 'project')
  const boards = join(base, 'data', 'canvas', 'ws_1')
  const outside = join(base, 'elsewhere')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const files = createStudioFiles({
    resolveRoot: (root) => (root.workspaceId !== 'ws-1' ? null : root.kind === 'workspace' ? workspace : boards),
    watchDebounceMs: 100,
  })
  return { files, workspace, boards, outside }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const ws = { kind: 'workspace' as const, workspaceId: 'ws-1' }
const store = { kind: 'boards' as const, workspaceId: 'ws-1' }

test('a path is relative to its root, and its spelling cannot leave it', () => {
  const refused = (path: string) => {
    const parsed = parseStudioMethodParams('files.read', { root: ws, path })
    return parsed.ok ? null : parsed.code
  }
  for (const path of ['../x.excalidraw', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', 'a\0b'])
    assert.equal(refused(path), 'invalid_params', path)
  assert.equal(refused('diagrams/arch.excalidraw'), null)
  assert.equal(refused(''), null)
  const write = parseStudioMethodParams('files.write', {
    root: ws,
    path: 'notes.md',
    text: 'x',
    ifMatch: null,
    commandId: 'c1',
  })
  assert.equal(write.ok ? null : write.code, 'invalid_params')
})

test('a write creates the board atomically, only when the file is still what the client read', async () => {
  const { files, boards } = fixture()
  const created = await files.write(store, 'arch.excalidraw', Buffer.from('{"v":1}'), null)
  assert.deepEqual(created.ok && [created.hash, created.size], [hash('{"v":1}'), 7])
  // Create-only finds it there now.
  const again = await files.write(store, 'arch.excalidraw', Buffer.from('{"v":9}'), null)
  assert.deepEqual(again, { ok: false, code: 'conflict', currentHash: hash('{"v":1}') })
  // A write against what it read goes through; one against an older read does not.
  const next = await files.write(store, 'arch.excalidraw', Buffer.from('{"v":2}'), hash('{"v":1}'))
  assert.equal(next.ok, true)
  const stale = await files.write(store, 'arch.excalidraw', Buffer.from('{"v":3}'), hash('{"v":1}'))
  assert.equal(stale.ok ? null : stale.code, 'conflict')
  assert.equal(readFileSync(join(boards, 'arch.excalidraw'), 'utf8'), '{"v":2}')
  // No temp file is left behind, and parents are created.
  await files.write(store, 'deep/er/flow.excalidraw', Buffer.from('{}'), null)
  assert.deepEqual(readdirSync(boards).sort(), ['arch.excalidraw', 'deep'])
  const read = await files.read(store, 'arch.excalidraw')
  assert.deepEqual(read.ok && [read.text, read.hash], ['{"v":2}', hash('{"v":2}')])
  // Only a board is written or removed.
  const note = await files.write(ws, 'notes.md', Buffer.from('x'), null)
  assert.equal(note.ok ? null : note.code, 'invalid_params')
  // A removal is conditional too.
  const kept = await files.remove(store, 'arch.excalidraw', hash('{"v":1}'))
  assert.equal(kept.ok ? null : kept.code, 'conflict')
  assert.deepEqual(await files.remove(store, 'arch.excalidraw', hash('{"v":2}')), { ok: true, removed: true })
  assert.deepEqual(await files.remove(store, 'arch.excalidraw', null), { ok: true, removed: false })
})

test.skipIf(process.platform === 'win32')('a link out of the root is a path that is not there', async () => {
  const { files, workspace, outside } = fixture()
  writeFileSync(join(outside, 'secret.excalidraw'), '{"secret":true}')
  symlinkSync(outside, join(workspace, 'escape'))
  symlinkSync(join(outside, 'secret.excalidraw'), join(workspace, 'linked.excalidraw'))
  for (const path of ['escape/secret.excalidraw', 'linked.excalidraw']) {
    const read = await files.read(ws, path)
    assert.equal(read.ok ? null : read.code, 'not_found', path)
    const write = await files.write(ws, path, Buffer.from('{}'), hash('{"secret":true}'))
    assert.equal(write.ok ? null : write.code, 'not_found', path)
  }
  const created = await files.write(ws, 'escape/new.excalidraw', Buffer.from('{}'), null)
  assert.equal(created.ok ? null : created.code, 'not_found')
  assert.equal(readFileSync(join(outside, 'secret.excalidraw'), 'utf8'), '{"secret":true}')
  // A listing names a link as neither kind.
  const listed = await files.list(ws, '')
  assert.deepEqual(listed.ok && listed.entries, [])
  // A root that is not here is not found.
  const unknown = await files.read({ kind: 'workspace', workspaceId: 'ws-9' }, 'x.excalidraw')
  assert.equal(unknown.ok ? null : unknown.code, 'not_found')
  assert.deepEqual(files.roots('ws-1'), { workspace: true, boards: true })
  assert.deepEqual(files.roots('ws-9'), { workspace: false, boards: false })
})

test('a watch tells of a burst of changes once, by name', async () => {
  const { files, workspace } = fixture()
  const pushes: string[][] = []
  const watched = await files.watch(ws, '', (names) => pushes.push(names))
  assert.ok(watched.ok)
  cleanups.push(() => watched.dispose())
  writeFileSync(join(workspace, 'a.excalidraw'), '1')
  writeFileSync(join(workspace, 'a.excalidraw'), '2')
  writeFileSync(join(workspace, 'b.excalidraw'), '3')
  const heard = () => new Set(pushes.flat())
  for (let tries = 0; !(heard().has('a.excalidraw') && heard().has('b.excalidraw')) && tries < 200; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  // Three writes inside one debounce are one push (a platform may name the
  // folder itself beside them).
  assert.equal(pushes.length, 1)
  assert.ok(heard().has('a.excalidraw') && heard().has('b.excalidraw'))
})

test('the files methods are an owner’s, and a write is answered once per command id', async () => {
  const { files, boards } = fixture()
  const auth = createFakeAuthenticator()
  const started = await startTestServer({ files, auth })
  cleanups.push(() => started.dispose())
  const owner = await connectLineClient(started.path)
  cleanups.push(() => owner.close())
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next((frame) => frame.t === 'welcome')
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('files-write'), true)
  const write = (id: string, ifMatch: string | null) => {
    owner.send({
      t: 'req',
      id,
      method: 'files.write',
      params: { root: store, path: 'b.excalidraw', text: '{"a":1}', ifMatch, commandId: 'w1' },
    })
    return owner.next((frame) => frame.t === 'res' && frame.id === id)
  }
  const first = await write('r1', null)
  assert.equal(first.t === 'res' && first.ok && (first.result as { ok: boolean }).ok, true)
  // The same command again is the first one's answer, not a conflict with itself.
  const retry = await write('r2', null)
  assert.deepEqual(retry.t === 'res' && retry.ok && retry.result, first.t === 'res' && first.ok && first.result)
  assert.equal(readFileSync(join(boards, 'b.excalidraw'), 'utf8'), '{"a":1}')
  owner.send({ t: 'req', id: 'r3', method: 'files.stat', params: { root: store, path: 'b.excalidraw' } })
  const stat = await owner.next((frame) => frame.t === 'res' && frame.id === 'r3')
  assert.equal(stat.t === 'res' && stat.ok && (stat.result as { stat: { hash: string } }).stat.hash, hash('{"a":1}'))
  // A paired app is refused whatever it holds.
  const app = await connectLineClient(started.path)
  cleanups.push(() => app.close())
  app.send(hello({ token: pairFakeClient(auth, 'app', ['files:read', 'files:write']) }))
  await app.next((frame) => frame.t === 'welcome')
  app.send({ t: 'req', id: 'a1', method: 'files.read', params: { root: store, path: 'b.excalidraw' } })
  const refused = await app.next((frame) => frame.t === 'res' && frame.id === 'a1')
  assert.equal(refused.t === 'res' && !refused.ok && refused.error.code, 'owner_required')
  // The watch stream over the socket.
  owner.send({ t: 'sub', id: 's1', topic: 'files.watch', params: { root: store, path: '' } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  writeFileSync(join(boards, 'c.excalidraw'), '{}')
  const push = await owner.next(
    (frame) =>
      frame.t === 'push' && frame.sub === 's1' && (frame.payload as { names: string[] }).names.includes('c.excalidraw'),
  )
  assert.equal(push.t, 'push')
})
