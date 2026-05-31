import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
    async pathExists(targetPath) {
      return stat(targetPath).then(() => true, () => false)
    },
    async trashItem() {},
  })

  try {
    const writeBinaryFile = ipcMain.handlers.get('fs:write-binary-file')
    const copyInto = ipcMain.handlers.get('fs:copy-into')
    const createWorkspaceFolder = ipcMain.handlers.get('fs:create-workspace-folder')
    assert.ok(writeBinaryFile, 'binary write handler should be registered')
    assert.ok(copyInto, 'basename-preserving copy handler should be registered')
    assert.ok(createWorkspaceFolder, 'workspace folder creation handler should be registered')

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

    const sourceRoot = join(tempRoot, 'registry')
    const sourceRolesDir = join(sourceRoot, 'roles')
    const sourceSkillsDir = join(sourceRoot, 'skills')
    const sourceSkillDir = join(sourceSkillsDir, 'growth-copywriter')
    const destinationRoot = join(tempRoot, 'workspace', '.sprintengine')
    const destinationRolesDir = join(destinationRoot, 'roles')
    const destinationSkillsDir = join(destinationRoot, 'skills')
    await mkdir(sourceRolesDir, { recursive: true })
    await mkdir(sourceSkillDir, { recursive: true })
    await mkdir(destinationRolesDir, { recursive: true })
    await mkdir(destinationSkillsDir, { recursive: true })
    await writeFile(join(sourceRolesDir, 'marketer.json'), '{"id":"marketer","skills":["growth-copywriter"]}', 'utf-8')
    await writeFile(join(sourceSkillDir, 'SKILL.md'), '# Growth Copywriter\n', 'utf-8')

    const copiedRolePath = await copyInto(null, join(sourceRolesDir, 'marketer.json'), destinationRolesDir, { overwrite: true })
    const copiedSkillPath = await copyInto(null, sourceSkillDir, destinationSkillsDir, { overwrite: true })

    assert.equal(copiedRolePath, join(destinationRolesDir, 'marketer.json'), 'role manifests copy under their original file name')
    assert.equal(copiedSkillPath, join(destinationSkillsDir, 'growth-copywriter'), 'skill folders copy under their original directory name')
    assert.equal(
      await readFile(join(destinationSkillsDir, 'growth-copywriter', 'SKILL.md'), 'utf-8'),
      '# Growth Copywriter\n',
      'skill content remains discoverable at skills/<skill-id>/SKILL.md',
    )

    await writeFile(join(sourceSkillDir, 'SKILL.md'), '# Growth Copywriter v2\n', 'utf-8')
    await copyInto(null, sourceSkillDir, destinationSkillsDir, { overwrite: true })
    assert.equal(
      await readFile(join(destinationSkillsDir, 'growth-copywriter', 'SKILL.md'), 'utf-8'),
      '# Growth Copywriter v2\n',
      'overwrite updates existing installed skill folders without copy suffixes',
    )

    const projectParent = join(tempRoot, 'projects')
    await mkdir(projectParent)
    const createdWorkspacePath = await createWorkspaceFolder(null, projectParent, '  new-product  ')
    assert.equal(createdWorkspacePath, join(projectParent, 'new-product'), 'workspace folder names are trimmed before creation')

    await assert.rejects(
      () => createWorkspaceFolder(null, projectParent, '../escape'),
      /Enter a valid folder name\./,
      'workspace folder creation rejects path traversal names',
    )
    await assert.rejects(
      () => createWorkspaceFolder(null, projectParent, 'AUX'),
      /reserved by Windows/,
      'workspace folder creation rejects Windows reserved names',
    )
    await assert.rejects(
      () => createWorkspaceFolder(null, projectParent, 'trailing-dot.'),
      /cannot end with a period or space/,
      'workspace folder creation rejects names that end with a period',
    )
    await assert.rejects(
      () => createWorkspaceFolder(null, projectParent, 'new-product'),
      /already exists/,
      'workspace folder creation rejects collisions',
    )
  } finally {
    await rm(tempRoot, { force: true, recursive: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
