import assert from 'node:assert/strict'

import { createRendererHost, type ModuleWorkspaceView } from './renderer-host'
import { test } from 'vitest'

test('workspace-context', async () => {
  // RendererHost.getWorkspace is the supported workspace id → root/name/mode
  // read for module panels. Contract under test: before the shell wires the
  // resolver (early boot, unit-test bundles) every lookup resolves null; once
  // wired, known ids resolve to the view and unknown ids resolve null — never a
  // throw in any state.

  async function main(): Promise<void> {
    const kernel = createRendererHost()
    const host = kernel.hostFor('weather-deck')

    // Early boot: no resolver wired yet — null, not a throw.
    assert.equal(await host.getWorkspace('ws-1'), null)

    const view: ModuleWorkspaceView = {
      id: 'ws-1',
      name: 'Calendar week',
      folderPath: '/repos/calendar',
      mode: 'calendar',
    }
    kernel.setWorkspaceResolver((workspaceId) => (workspaceId === 'ws-1' ? { ...view } : null))

    assert.deepEqual(await host.getWorkspace('ws-1'), view)
    // Unknown id: explicit null, mirroring the main-side WorkspaceContextToken.
    assert.equal(await host.getWorkspace('ws-missing'), null)

    // A folderless workspace surfaces folderPath: null rather than an invented path.
    kernel.setWorkspaceResolver(() => ({ id: 'ws-2', name: 'Scratch', folderPath: null, mode: 'standard' }))
    const folderless = await host.getWorkspace('ws-2')
    assert.equal(folderless?.folderPath, null)

    console.log('workspace-context guard passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
