import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { SprintEngineSettingsPopover } from './SprintEngineBoardPanel'
import type { SprintEngineTask } from '../../types/workspace'

// Static contracts for the run-configuration popover's runtime status block:
// a blocked runtime renders the state label on its own line, the stop reason
// keeps only the question when the task row already names the task id, and
// the blocking task renders as a labeled deep-link row. Without a resolvable
// task the reason renders verbatim and no dead link button appears.

const blockedTask = {
  id: 'T4',
  title: 'Renderer third-party module loader',
  status: 'needs_input',
} as unknown as SprintEngineTask

const html = renderToStaticMarkup(
  <SprintEngineSettingsPopover
    automationMode="run_agents"
    runtimeState="blocked"
    runtimeReason="Waiting on T4: Should the loader fall back to the bundled registry?"
    runtimeTask={blockedTask}
    cliPermissionPreset="manual"
    onChangeAutomationMode={() => {}}
    onResumeAutomation={() => {}}
    onOpenRuntimeTask={() => {}}
    onUpdateCliPreset={() => {}}
    onClose={() => {}}
  />,
)

assert.ok(html.includes('Blocked'), 'blocked runtime shows the state label')
assert.ok(html.includes('Resume'), 'blocked runtime keeps the Resume action')
assert.ok(
  html.includes('aria-label="Open task T4 Renderer third-party module loader"'),
  'blocking task renders as a labeled deep-link row',
)
assert.ok(
  html.includes('Should the loader fall back to the bundled registry?'),
  'stop reason keeps the question',
)
assert.ok(
  !html.includes('Waiting on T4:'),
  'task id is not repeated in the reason when the task row names it',
)

// Without a resolvable task: verbatim reason, no link row.
const htmlNoTask = renderToStaticMarkup(
  <SprintEngineSettingsPopover
    automationMode="run_agents"
    runtimeState="blocked"
    runtimeReason="A task needs input from the user or architect before agents can continue."
    runtimeTask={null}
    cliPermissionPreset="manual"
    onChangeAutomationMode={() => {}}
    onResumeAutomation={() => {}}
    onOpenRuntimeTask={() => {}}
    onUpdateCliPreset={() => {}}
    onClose={() => {}}
  />,
)

assert.ok(
  htmlNoTask.includes('A task needs input from the user or architect before agents can continue.'),
  'reason renders verbatim when no task resolves',
)
assert.ok(!htmlNoTask.includes('aria-label="Open task'), 'no dead link button without a task')

// A pinned roster layout passes a null handler; the task row must not render
// as an unactionable button.
const htmlNoHandler = renderToStaticMarkup(
  <SprintEngineSettingsPopover
    automationMode="run_agents"
    runtimeState="blocked"
    runtimeReason="Waiting on T4: Should the loader fall back to the bundled registry?"
    runtimeTask={blockedTask}
    cliPermissionPreset="manual"
    onChangeAutomationMode={() => {}}
    onResumeAutomation={() => {}}
    onOpenRuntimeTask={null}
    onUpdateCliPreset={() => {}}
    onClose={() => {}}
  />,
)

assert.ok(!htmlNoHandler.includes('aria-label="Open task'), 'null handler renders no dead link')

console.log('Sprint Engine settings popover contracts passed')
