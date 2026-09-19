import assert from 'node:assert/strict'
import {
  availableFolderOpenTargets,
  folderOpenTargetLabel,
  offersFolderOpenMenu,
  resolveFolderOpenPrimary,
} from './openInEditorTargets'
import type { FolderOpenTargetAvailability } from '../../../../shared/folder-open-targets'
import { test } from 'vitest'

test('openInEditorTargets', async () => {
  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  const probe = (
    entries: Partial<Record<FolderOpenTargetAvailability['id'], boolean>>,
  ): FolderOpenTargetAvailability[] =>
    (Object.entries(entries) as [FolderOpenTargetAvailability['id'], boolean][]).map(([id, available]) => ({
      id,
      available,
    }))

  run('an uninstalled editor is absent from the menu, not disabled in it', () => {
    const available = availableFolderOpenTargets(probe({ vscode: true, intellij: false, finder: true }))
    assert.deepEqual(available, ['vscode', 'finder'])
  })

  run('a target missing from the probe result is treated as unavailable', () => {
    assert.deepEqual(availableFolderOpenTargets(probe({ finder: true })), ['finder'])
  })

  run('targets keep the shared preference order regardless of probe order', () => {
    const available = availableFolderOpenTargets([
      { id: 'finder', available: true },
      { id: 'intellij', available: true },
      { id: 'vscode', available: true },
    ])
    assert.deepEqual(available, ['vscode', 'intellij', 'finder'])
  })

  run('an unprobed control offers nothing, so it does not render', () => {
    assert.deepEqual(availableFolderOpenTargets(null), [])
    assert.equal(resolveFolderOpenPrimary([], null), null)
  })

  run('first run with only the vscode target installed defaults to vscode', () => {
    const available = availableFolderOpenTargets(probe({ vscode: true, intellij: false, finder: true }))
    assert.equal(resolveFolderOpenPrimary(available, null), 'vscode')
  })

  run('first run with no editor installed defaults to the file manager', () => {
    const available = availableFolderOpenTargets(probe({ vscode: false, intellij: false, finder: true }))
    assert.equal(resolveFolderOpenPrimary(available, null), 'finder')
  })

  run('a remembered target wins over the preference order', () => {
    const available = availableFolderOpenTargets(probe({ vscode: true, intellij: true, finder: true }))
    assert.equal(resolveFolderOpenPrimary(available, 'intellij'), 'intellij')
  })

  run('a remembered target uninstalled since the pick falls back, never arms a dead click', () => {
    const available = availableFolderOpenTargets(probe({ vscode: true, intellij: false, finder: true }))
    assert.equal(resolveFolderOpenPrimary(available, 'intellij'), 'vscode')
  })

  run('with only the file manager resolving there is no menu to offer', () => {
    const available = availableFolderOpenTargets(probe({ vscode: false, intellij: false, finder: true }))
    assert.deepEqual(available, ['finder'])
    assert.equal(offersFolderOpenMenu(available), false)
  })

  run('a second target is what earns the menu', () => {
    assert.equal(offersFolderOpenMenu(availableFolderOpenTargets(probe({ vscode: true, finder: true }))), true)
    assert.equal(offersFolderOpenMenu([]), false)
  })

  run('the file manager is named by the OS, not by us', () => {
    assert.equal(folderOpenTargetLabel('finder', true), 'Finder')
    assert.equal(folderOpenTargetLabel('finder', false), 'File manager')
    assert.equal(folderOpenTargetLabel('vscode', false), 'VS Code')
    assert.equal(folderOpenTargetLabel('intellij', true), 'IntelliJ IDEA')
  })

  if (failures > 0) {
    console.error(`openInEditorTargets.test.ts: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('openInEditorTargets.test.ts: ok')
})
