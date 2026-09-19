import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { test } from 'vitest'

test('engineCliMemory', async () => {
  // `appSettings.lastSelectedCli` is the app-wide default CLI: what an automation
  // with no runtime set, the review guide, a module asking for the default, and
  // an `agent_launch` over MCP that names no CLI all fall back to. It shipped
  // with a setter that only tests ever called, so it stood on its factory value
  // forever — on a machine without that CLI installed, every one of those
  // fallbacks named a binary that is not there.
  //
  // These checks hold the two halves of the fix: the setter really persists, and
  // the composer and the manager actually call it.

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

  run('the store setter really persists the pick', () => {
    const store = useWorkspaceStore.getState()
    const before = store.appSettings.lastSelectedCli
    try {
      store.setLastSelectedCli('codex')
      assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'codex')
      useWorkspaceStore.getState().setLastSelectedCli('gemini')
      assert.equal(
        useWorkspaceStore.getState().appSettings.lastSelectedCli,
        'gemini',
        'the default follows the latest pick, it is not written once and frozen',
      )
    } finally {
      useWorkspaceStore.getState().setLastSelectedCli(before)
    }
  })

  // Source contracts, in this directory's existing style: the seam above is only
  // worth anything if the two write paths consult it. Both used to write General's
  // own key and stop there.
  const hookSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/useAgentComposer.ts'),
    'utf8',
  )
  const managerSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/workspace/WorkspaceManager.tsx'),
    'utf8',
  )

  run('every composer engine pick writes the app-wide default', () => {
    // Three pickers move the engine — the CLI row, the model row (picking a model
    // picks its CLI) and the effort ramp — and each one must write the default,
    // or the surfaces that fall back to it keep naming the CLI nobody picked.
    assert.equal(
      (hookSource.match(/setLastSelectedCli\(cli\)/g) ?? []).length,
      3,
      'the CLI picker, the model picker and the effort ramp all write the app-wide default',
    )
  })

  run('a New chat started on an explicit CLI remembers it as the default', () => {
    assert.match(
      managerSource,
      /if \(chosenCli\) setLastSelectedCli\(chosenCli\)/,
      'the manager writes the app-wide default from the chat’s own pick',
    )
  })

  if (failures > 0) throw new Error(`${failures} engine CLI memory check(s) failed`)
  console.log('engine cli memory: ok')
})
