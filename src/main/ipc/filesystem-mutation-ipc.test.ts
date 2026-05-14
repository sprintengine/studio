import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerFilesystemMutationIpc } from './filesystem-mutation-ipc'

type Handler = (_event: unknown, ...args: unknown[]) => Promise<unknown>

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle(channel, handler): void {
      handlers.set(channel, handler)
    },
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'multicode-fs-mutation-'))
  const guardedStatePath = join(tempRoot, '.multi-code', 'sprintengine', 'team', 'state.yaml')
  const guardCalls: string[] = []
  const ipcMain = createIpcMain()

  registerFilesystemMutationIpc(ipcMain as unknown as Parameters<typeof registerFilesystemMutationIpc>[0], {
    async assertNotDirectSprintEngineStateMutation(targetPath) {
      guardCalls.push(targetPath)
      if (targetPath === guardedStatePath) {
        throw new Error('Sprint Engine state files must be updated through the Sprint Engine tool.')
      }
    },
    async getUniqueCopyPath() {
      throw new Error('copy is not used in this test')
    },
    async pathExists() {
      return false
    },
    async trashItem() {},
  })

  try {
    const writeBinaryFile = ipcMain.handlers.get('fs:write-binary-file')
    assert.ok(writeBinaryFile, 'binary write handler should be registered')

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
    const targetPath = join(tempRoot, 'attachment.png')
    await writeBinaryFile(null, targetPath, pngBytes.toString('base64'))

    assert.deepEqual(await readFile(targetPath), pngBytes, 'binary handler writes decoded bytes')
    assert.ok(guardCalls.includes(targetPath), 'binary write checks Sprint Engine state guard before writing')

    await assert.rejects(
      () => writeBinaryFile(null, guardedStatePath, pngBytes.toString('base64')),
      /Sprint Engine state files must be updated through the Sprint Engine tool\./,
    )
    assert.ok(guardCalls.includes(guardedStatePath), 'guarded state path is checked and rejected')
  } finally {
    await rm(tempRoot, { force: true, recursive: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
