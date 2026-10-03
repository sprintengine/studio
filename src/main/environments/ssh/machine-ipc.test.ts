import assert from 'node:assert/strict'
import { test } from 'vitest'

import { machineAwareIpc, machineOfArgs, plainArgs } from './machine-ipc'

// What the wrapper reads as a path on a machine, and what it leaves as text:
// a file's contents, a search or a commit message that happens to start with
// `ssh://` is a local call like any other, with or without SSH machines.

test('text arguments and fields are never read as machine paths', () => {
  assert.equal(
    machineOfArgs(['/Users/dev/repo/.git/config', 'url = ssh://git@example.com/acme/app'], 'fs:writefile'),
    null,
  )
  assert.equal(machineOfArgs(['/Users/dev/repo', 'ssh://build-box/notes in the message'], 'git:commit'), null)
  assert.equal(machineOfArgs(['/Users/dev/repo', 'ssh://e1/x', true], 'git:stash-push'), null)
  assert.equal(machineOfArgs([{ rootPath: '/Users/dev/repo', query: 'ssh://git@' }], 'fs:search-content'), null)
  // A machine path in a path argument still names the machine; its text rides along untouched.
  assert.deepEqual(machineOfArgs(['ssh://e1/home/dev/repo', 'ssh://e2/quoted'], 'git:commit'), { id: 'e1' })
  assert.deepEqual(plainArgs(['ssh://e1/home/dev/repo', 'ssh://e1/quoted'], 'git:commit', 'e1'), [
    '/home/dev/repo',
    'ssh://e1/quoted',
  ])
  assert.deepEqual(plainArgs([{ rootPath: 'ssh://e1/r', query: 'ssh://e1/q' }], 'fs:search-files', 'e1'), [
    { rootPath: '/r', query: 'ssh://e1/q' },
  ])
  // Outside text, an `ssh://` string that names no machine is refused, never resolved here.
  assert.deepEqual(machineOfArgs(['ssh://../etc'], 'fs:readfile'), { mixed: true })
})

test('with SSH machines off, a local call with ssh:// text goes through, a machine path is refused in words', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = machineAwareIpc(
    { handle: (channel: string, listener: never) => handlers.set(channel, listener) } as never,
    null,
  )
  const local: unknown[][] = []
  ipc.handle('fs:writefile', (_event, ...args) => {
    local.push(args)
    return undefined
  })
  ipc.handle('fs:readdir', (_event, ...args) => {
    local.push(args)
    return []
  })
  await handlers.get('fs:writefile')!(null, '/Users/dev/repo/README.md', 'ssh://git@example.com/acme/app')
  assert.deepEqual(local, [['/Users/dev/repo/README.md', 'ssh://git@example.com/acme/app']])
  await assert.rejects(
    Promise.resolve(handlers.get('fs:readdir')!(null, 'ssh://e1/home/dev/repo')),
    /Not available for SSH machines yet/u,
  )
  assert.equal(local.length, 1, 'the machine path never reached this computer')
})
