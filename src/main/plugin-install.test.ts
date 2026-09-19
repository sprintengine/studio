import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { installPluginFolder } from './plugin-install'

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), 'multicode-plugin-install-'))
}

test('installs a valid CLI plugin folder under its declared id', async () => {
  const base = tmpBase()
  try {
    const root = join(base, 'plugins')
    // Reuse a known-good bundled CLI manifest as the source folder, renamed so
    // the source folder name differs from the declared id (install must key on id).
    const src = join(base, 'some-arbitrary-folder')
    cpSync(join(process.cwd(), 'resources', 'plugins', 'codex'), src, { recursive: true })

    const result = await installPluginFolder(src, root)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.id, 'codex')
    assert.equal(result.kind, 'cli')
    assert.equal(existsSync(join(root, 'codex', 'plugin.json')), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('rejects a folder with no plugin.json', async () => {
  const base = tmpBase()
  try {
    const root = join(base, 'plugins')
    const src = join(base, 'empty')
    mkdirSync(src, { recursive: true })

    const result = await installPluginFolder(src, root)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /No plugin\.json/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('rejects invalid plugin.json with structured issues', async () => {
  const base = tmpBase()
  try {
    const root = join(base, 'plugins')
    const src = join(base, 'broken')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'plugin.json'), '{ not json', 'utf8')

    const result = await installPluginFolder(src, root)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok((result.issues?.length ?? 0) >= 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('overwrites a prior install of the same id', async () => {
  const base = tmpBase()
  try {
    const root = join(base, 'plugins')
    const src = join(base, 'src')
    cpSync(join(process.cwd(), 'resources', 'plugins', 'codex'), src, { recursive: true })

    await installPluginFolder(src, root)
    // Drop a stale extra file into the installed copy; a re-install with force
    // copies fresh content over it.
    writeFileSync(join(root, 'codex', 'STALE.txt'), 'old', 'utf8')
    const second = await installPluginFolder(src, root)
    assert.equal(second.ok, true)
    assert.equal(readFileSync(join(root, 'codex', 'plugin.json'), 'utf8').length > 0, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
