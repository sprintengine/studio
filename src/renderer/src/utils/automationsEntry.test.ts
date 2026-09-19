import assert from 'node:assert/strict'
import { listAutomationProjectFolders, type AutomationProjectFolderCandidate } from './automationsEntry'
import { test } from 'vitest'

test('automationsEntry', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  function ws(folderPath: string | null): AutomationProjectFolderCandidate {
    return { folderPath }
  }

  // The full-page Automations surface (item 1707) creates an automation in a
  // project the user chooses; this lists those project folders. Only folderPath is
  // read.

  run('lists distinct project folders in first-seen order', () => {
    const workspaces = [
      ws('/proj/app'),
      ws('/proj/lib'),
      ws('/proj/app'), // second workspace in the same project — deduped
    ]
    assert.deepEqual(listAutomationProjectFolders(workspaces), [
      { folderPath: '/proj/app', displayName: 'app' },
      { folderPath: '/proj/lib', displayName: 'lib' },
    ])
  })

  run('dedupes case- and separator-insensitively, keeping the first-seen path', () => {
    const workspaces = [
      ws('/work/Checkout-Service'),
      ws('/work/checkout-service/'), // same project, trailing slash + case drift
      ws('C:\\work\\billing'),
      ws('C:\\work\\billing\\'),
    ]
    assert.deepEqual(listAutomationProjectFolders(workspaces), [
      { folderPath: '/work/Checkout-Service', displayName: 'Checkout-Service' },
      { folderPath: 'C:\\work\\billing', displayName: 'billing' },
    ])
  })

  run('skips folder-less workspaces (chat / standard with no root)', () => {
    const workspaces = [ws(null), ws('/proj/app'), ws(null)]
    assert.deepEqual(listAutomationProjectFolders(workspaces), [{ folderPath: '/proj/app', displayName: 'app' }])
  })

  run('empty when no workspace has a folder', () => {
    assert.deepEqual(listAutomationProjectFolders([ws(null), ws(null)]), [])
  })

  console.log('all automationsEntry tests passed')
})
