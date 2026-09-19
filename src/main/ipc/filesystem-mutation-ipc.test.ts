import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerFilesystemMutationIpc } from './filesystem-mutation-ipc'
import { test } from 'vitest'

test('filesystem-mutation-ipc', async () => {
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
    const tempRoot = await mkdtemp(join(tmpdir(), 'sprintengine-fs-mutation-'))
    const ipcMain = createIpcMain()

    registerFilesystemMutationIpc(ipcMain as unknown as Parameters<typeof registerFilesystemMutationIpc>[0], {
      async getUniqueCopyPath() {
        throw new Error('copy is not used in this test')
      },
      async pathExists(targetPath) {
        return stat(targetPath).then(
          () => true,
          () => false,
        )
      },
      async trashItem() {},
    })

    try {
      const copyInto = ipcMain.handlers.get('fs:copy-into')
      const renamePath = ipcMain.handlers.get('fs:rename')
      const movePath = ipcMain.handlers.get('fs:move')
      const deletePath = ipcMain.handlers.get('fs:delete')
      assert.ok(copyInto, 'basename-preserving copy handler should be registered')
      assert.ok(renamePath, 'rename handler should be registered')
      assert.ok(movePath, 'move handler should be registered')
      assert.ok(deletePath, 'delete handler should be registered')

      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])

      const saveDroppedImage = ipcMain.handlers.get('fs:save-dropped-image')
      assert.ok(saveDroppedImage, 'dropped-image handler should be registered')
      const savedPath = (await saveDroppedImage(null, {
        mediaType: 'image/png',
        dataBase64: pngBytes.toString('base64'),
      })) as string
      try {
        assert.ok(savedPath.endsWith('.png'), 'saved image wears the extension of its media type')
        assert.deepEqual(await readFile(savedPath), pngBytes, 'saved image holds the decoded bytes')
      } finally {
        await rm(savedPath, { force: true })
      }
      await assert.rejects(
        () => saveDroppedImage(null, { mediaType: 'image/svg+xml', dataBase64: pngBytes.toString('base64') }),
        /Only PNG, JPEG, WebP, and GIF/,
        'non-attachable media types are refused',
      )
      await assert.rejects(
        () => saveDroppedImage(null, { mediaType: 'image/png', dataBase64: '' }),
        /could not be read/,
        'an empty payload is refused rather than written as a zero-byte file',
      )

      // The renderer holds a conversation attachment as base64 and no path, so
      // "open this image" needs a channel of its own; what it writes is covered by
      // attachment-image-file.test.ts, and what matters here is that it is wired.
      assert.ok(
        ipcMain.handlers.get('fs:open-image-attachment'),
        'the open-in-the-OS-viewer handler should be registered',
      )

      const sourceRoot = join(tempRoot, 'registry')
      const sourceManifestsDir = join(sourceRoot, 'manifests')
      const sourceSkillsDir = join(sourceRoot, 'skills')
      const sourceSkillDir = join(sourceSkillsDir, 'growth-copywriter')
      const destinationRoot = join(tempRoot, 'workspace', '.sprintengine')
      const destinationManifestsDir = join(destinationRoot, 'manifests')
      const destinationSkillsDir = join(destinationRoot, 'skills')
      await mkdir(sourceManifestsDir, { recursive: true })
      await mkdir(sourceSkillDir, { recursive: true })
      await mkdir(destinationManifestsDir, { recursive: true })
      await mkdir(destinationSkillsDir, { recursive: true })
      await writeFile(
        join(sourceManifestsDir, 'marketer.json'),
        '{"id":"marketer","skills":["growth-copywriter"]}',
        'utf-8',
      )
      await writeFile(join(sourceSkillDir, 'SKILL.md'), '# Growth Copywriter\n', 'utf-8')

      const copiedManifestPath = await copyInto(
        null,
        join(sourceManifestsDir, 'marketer.json'),
        destinationManifestsDir,
        { overwrite: true },
      )
      const copiedSkillPath = await copyInto(null, sourceSkillDir, destinationSkillsDir, { overwrite: true })

      assert.equal(
        copiedManifestPath,
        join(destinationManifestsDir, 'marketer.json'),
        'manifests copy under their original file name',
      )
      assert.equal(
        copiedSkillPath,
        join(destinationSkillsDir, 'growth-copywriter'),
        'skill folders copy under their original directory name',
      )
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

      const renameSource = join(tempRoot, 'plan.md')
      await writeFile(renameSource, '# Plan\n', 'utf-8')
      await assert.rejects(
        () => renamePath(null, renameSource, 'CON.md'),
        /reserved by Windows/,
        'rename rejects Windows reserved names',
      )
      await assert.rejects(
        () => renamePath(null, renameSource, 'bad:name.md'),
        /cannot contain control characters/,
        'rename rejects Windows-invalid filename characters',
      )
      await assert.rejects(
        () => renamePath(null, renameSource, 'trailing-space.md '),
        /cannot end with a period or space/,
        'rename rejects trailing spaces before filesystem mutation',
      )
      assert.equal(
        await readFile(renameSource, 'utf-8'),
        '# Plan\n',
        'invalid rename attempts leave source file in place',
      )

      const moveSourceDir = join(tempRoot, 'move-source')
      const moveDestinationDir = join(tempRoot, 'move-destination')
      await mkdir(moveSourceDir)
      await mkdir(moveDestinationDir)
      const moveSourceFile = join(moveSourceDir, 'notes.md')
      await writeFile(moveSourceFile, '# Notes\n', 'utf-8')

      const movedFilePath = await movePath(null, moveSourceFile, moveDestinationDir)
      assert.equal(
        movedFilePath,
        join(moveDestinationDir, 'notes.md'),
        'move returns the file path under the destination directory',
      )
      assert.equal(await readFile(movedFilePath, 'utf-8'), '# Notes\n', 'move carries file content to destination')
      await assert.rejects(() => stat(moveSourceFile), /ENOENT/, 'move removes the original file path')

      const collisionSource = join(moveSourceDir, 'notes.md')
      await writeFile(collisionSource, '# Collision\n', 'utf-8')
      await assert.rejects(
        () => movePath(null, collisionSource, moveDestinationDir),
        /already exists/,
        'move rejects destination name collisions',
      )
      assert.equal(await readFile(collisionSource, 'utf-8'), '# Collision\n', 'collision leaves source file in place')

      const moveParentDir = join(tempRoot, 'move-parent')
      const nestedDestinationDir = join(moveParentDir, 'nested')
      await mkdir(nestedDestinationDir, { recursive: true })
      await assert.rejects(
        () => movePath(null, moveParentDir, nestedDestinationDir),
        /Cannot move a file or folder into itself\./,
        'move rejects moving a folder into its own child',
      )
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
