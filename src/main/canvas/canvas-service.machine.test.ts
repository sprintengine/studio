import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createCanvasService, type CanvasFs } from './canvas-service'
import type { CanvasWorkerHost } from './canvas-worker-host'

// A workspace on an SSH machine keeps its folder spelled `ssh://<id>/…`.
// Resolved on this computer that would be a folder under the working
// directory, so a board inside it is refused in words and nothing touches
// this computer's disk; a board in the store is still this computer's.

test("a board inside an SSH machine's folder is refused, and the folder is never walked here", async () => {
  const touched: string[] = []
  const fs = new Proxy({} as CanvasFs, {
    get: (_target, member) => async (path: string) => {
      touched.push(`${String(member)} ${path}`)
      if (member === 'readdir') return []
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
  })
  const service = createCanvasService({
    fs,
    platform: 'linux',
    now: () => 1_000,
    resolveWorkspaceRoot: (workspaceId) => (workspaceId === 'ws-ssh' ? 'ssh://e1/home/dev/repo' : null),
    resolveBoardStore: () => '/Users/dev/data/canvas/ws-ssh',
    broadcast: () => undefined,
    sendTo: () => undefined,
    worker: {} as CanvasWorkerHost,
    watch: () => ({ close: () => undefined }),
    setTimer: () => ({ cancel: () => undefined }),
  })
  const read = await service.readBoard({ workspaceId: 'ws-ssh', path: 'docs/arch.excalidraw' }, { create: true })
  assert.equal(read.ok, false)
  assert.match(!read.ok ? read.error.message : '', /Boards inside a folder on an SSH machine are not available yet/u)
  assert.equal(touched.length, 0, 'nothing was read or written for it')

  const listed = await service.listBoards('ws-ssh')
  assert.equal(listed.ok, true)
  assert.ok(
    touched.every((entry) => entry.includes('/Users/dev/data/canvas/ws-ssh')),
    `only the store was listed: ${touched.join(', ')}`,
  )
})
