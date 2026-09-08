import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { globalCliFromEnginePick } from './useAgentComposer'
import { useWorkspaceStore } from '../../../store/workspaceStore'

// `appSettings.lastSelectedCli` is the app-wide default CLI: what the Sprint
// Engine board's role terminals, an automation with no runtime set, the review
// guide, a module asking for the default, and an `agent_launch` over MCP that
// names no CLI all fall back to. It shipped with a setter that only tests ever
// called, so it stood on its factory value forever — on a machine without that
// CLI installed, every one of those fallbacks named a binary that is not there.
//
// These checks hold the two halves of the fix: which picks move it, and that
// the composer and the manager actually write it.

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

run('a General pick is the app-wide default CLI', () => {
  assert.equal(globalCliFromEnginePick({ kind: 'general' }, 'codex'), 'codex')
})

run('a specialist pick moves that specialist alone', () => {
  assert.equal(
    globalCliFromEnginePick({ kind: 'specialist', specialistId: 'architect' }, 'codex'),
    null,
    'one role’s engine must never become every other surface’s default',
  )
})

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

run('the composer writes the app-wide default on an engine pick', () => {
  assert.equal(
    (hookSource.match(/globalCliFromEnginePick\(target, cli\)/g) ?? []).length,
    2,
    'both the CLI picker and the model picker (which picks a CLI too) go through the seam',
  )
  assert.match(hookSource, /if \(globalCli\) setLastSelectedCli\(globalCli\)/)
})

run('a New chat started on an explicit CLI remembers it as the default', () => {
  assert.match(
    managerSource,
    /if \(chosenCli\) \{\s*\n\s*setSpecialistCliDefault\(GENERAL_AGENT_ENGINE_KEY, chosenCli\)\s*\n\s*setLastSelectedCli\(chosenCli\)/,
    'the manager writes General’s own key AND the app-wide default',
  )
})

if (failures > 0) throw new Error(`${failures} engine CLI memory check(s) failed`)
console.log('engine cli memory: ok')
