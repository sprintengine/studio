import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ensureExtensionFolders, MODULE_FOLDER_README, PLUGIN_FOLDER_README } from './extension-folders'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sprintengine-ext-folders-'))
}

test('creates both roots and seeds READMEs', () => {
  const base = tmpRoot()
  try {
    const moduleRoot = join(base, 'modules')
    const pluginRoot = join(base, 'plugins')
    const result = ensureExtensionFolders({ moduleRoot, pluginRoot })

    assert.equal(result.errors.length, 0)
    assert.equal(result.moduleRoot, moduleRoot)
    assert.equal(result.pluginRoot, pluginRoot)
    assert.equal(readFileSync(join(moduleRoot, 'README.md'), 'utf8'), MODULE_FOLDER_README)
    assert.equal(readFileSync(join(pluginRoot, 'README.md'), 'utf8'), PLUGIN_FOLDER_README)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('is idempotent and never overwrites an edited README', () => {
  const base = tmpRoot()
  try {
    const moduleRoot = join(base, 'modules')
    const pluginRoot = join(base, 'plugins')
    ensureExtensionFolders({ moduleRoot, pluginRoot })

    writeFileSync(join(moduleRoot, 'README.md'), 'user edited', 'utf8')
    const second = ensureExtensionFolders({ moduleRoot, pluginRoot })

    assert.equal(second.errors.length, 0)
    assert.equal(readFileSync(join(moduleRoot, 'README.md'), 'utf8'), 'user edited')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('leaves an already-installed extension folder untouched', () => {
  const base = tmpRoot()
  try {
    const moduleRoot = join(base, 'modules')
    const pluginRoot = join(base, 'plugins')
    ensureExtensionFolders({ moduleRoot, pluginRoot })
    writeFileSync(join(moduleRoot, 'README.md'), MODULE_FOLDER_README, 'utf8')

    // Pre-existing install: a module folder is present before the second run.
    const installed = join(moduleRoot, 'weather-deck')
    ensureExtensionFolders({ moduleRoot, pluginRoot })
    writeFileSync(join(pluginRoot, 'README.md'), PLUGIN_FOLDER_README, 'utf8')

    assert.equal(existsSync(moduleRoot), true)
    assert.equal(existsSync(pluginRoot), true)
    // The seeding step does not remove or alter sibling install folders.
    assert.equal(existsSync(installed), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
