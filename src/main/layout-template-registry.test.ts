import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { installLayoutTemplateFolder, loadUserLayoutTemplates } from './layout-template-registry'

const VALID = JSON.stringify({
  id: 'duo',
  name: 'Duo',
  description: 'Two agents.',
  layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
})

const INVALID = JSON.stringify({ id: 'Bad Id', name: '', layout: { layout: { type: 'tabset' } } })

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-templates-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testInstallValidAndRejectInvalid(): Promise<void> {
  await withTempDir(async (dir) => {
    const src = join(dir, 'src')
    const root = join(dir, 'registry')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'duo.json'), VALID)
    await writeFile(join(src, 'broken.json'), INVALID)

    const result = await installLayoutTemplateFolder(src, root)
    assert.equal(result.ok, true)
    assert.deepEqual(result.installed, ['duo'])
    assert.equal(result.rejected.length, 1)

    // Stored under the validated id so re-install replaces deterministically.
    const files = (await readdir(root)).sort()
    assert.deepEqual(files, ['duo.json'])

    const listed = await loadUserLayoutTemplates(root)
    assert.deepEqual(
      listed.templates.map((template) => template.id),
      ['duo']
    )
    assert.equal(listed.rejected.length, 0)
  })
}

async function testInstallEmptyFolder(): Promise<void> {
  await withTempDir(async (dir) => {
    const src = join(dir, 'empty')
    await mkdir(src, { recursive: true })
    const result = await installLayoutTemplateFolder(src, join(dir, 'registry'))
    assert.equal(result.ok, false)
    assert.ok(result.message && result.message.length > 0)
  })
}

async function testListMissingRootIsEmpty(): Promise<void> {
  await withTempDir(async (dir) => {
    const listed = await loadUserLayoutTemplates(join(dir, 'nope'))
    assert.deepEqual(listed.templates, [])
    assert.deepEqual(listed.rejected, [])
  })
}

async function main(): Promise<void> {
  await testInstallValidAndRejectInvalid()
  await testInstallEmptyFolder()
  await testListMissingRootIsEmpty()
  console.log('layout-template-registry tests passed')
}

void main()
