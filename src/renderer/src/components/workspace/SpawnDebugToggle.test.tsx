import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SpawnDebugToggle } from './agentComposer/agentSpawnShared'

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

// SpawnDebugToggle is a pure, hookless function component, so invoking it
// directly returns its element tree (a Tooltip wrapping the <button>). That
// lets us exercise the controlled toggle's render, aria, classes, and click
// behaviour without a DOM or the store/window-bound parent menu.
function tooltipElement(active: boolean, onChange: (next: boolean) => void): ReactElement {
  return SpawnDebugToggle({ active, onChange }) as ReactElement
}
function buttonOf(el: ReactElement): ReactElement {
  return el.props.children as ReactElement
}

run('renders a keyboard-operable native button labelled "DEBUG"', () => {
  const button = buttonOf(tooltipElement(false, () => {}))
  assert.equal(button.type, 'button', 'a native <button> is inherently keyboard-focusable and toggleable')
  assert.equal(button.props.type, 'button', 'type="button" so it never submits a form')
  assert.equal(button.props.children, 'DEBUG', 'state is carried by a literal label, not color alone')
  assert.equal(button.props.disabled, undefined, 'the toggle is always operable')
  assert.equal(button.props.tabIndex, undefined, 'no negative tabIndex — it stays in the tab order')
})

run('inactive: aria-pressed=false with the greyed Default/Auto idiom and no error fill', () => {
  const button = buttonOf(tooltipElement(false, () => {}))
  assert.equal(button.props['aria-pressed'], false, 'off state is announced via aria-pressed')
  assert.match(button.props.className, /text-\[color:var\(--text-disabled\)\]/, 'inactive uses the greyed disabled ink')
  assert.match(button.props.className, /hover:text-\[color:var\(--text-muted\)\]/, 'inactive hover matches Default/Auto')
  assert.ok(!button.props.className.includes('bg-[color:var(--tone-error)]'), 'no error fill when off')
})

run('active: aria-pressed=true with the error-tone fill', () => {
  const button = buttonOf(tooltipElement(true, () => {}))
  assert.equal(button.props['aria-pressed'], true, 'on state is announced via aria-pressed')
  assert.match(button.props.className, /bg-\[color:var\(--tone-error\)\]\/12/, 'active uses the error-tone soft fill')
  assert.match(button.props.className, /text-\[color:var\(--tone-error-on-tint\)\]/, 'active label uses the deeper on-tint error ink that clears AA on the soft fill')
})

run('carries a visible focus ring and a tooltip noting Auto/Bypass work best', () => {
  const el = tooltipElement(false, () => {})
  assert.match(buttonOf(el).props.className, /focus-visible:focus-ring/, 'keyboard focus is visible, not suppressed')
  assert.match(String(el.props.content), /Auto/, 'the tooltip notes the Auto preset')
  assert.match(String(el.props.content), /Bypass/, 'the tooltip notes the Bypass preset')
})

run('clicking toggles by calling onChange with the negated value', () => {
  let received: boolean | null = null
  buttonOf(tooltipElement(false, (next) => { received = next })).props.onClick()
  assert.equal(received, true, 'an off toggle turns on')

  received = null
  buttonOf(tooltipElement(true, (next) => { received = next })).props.onClick()
  assert.equal(received, false, 'an on toggle turns off')
})

run('renders on the real server surface with the DEBUG label and aria-pressed', () => {
  const off = renderToStaticMarkup(<SpawnDebugToggle active={false} onChange={() => {}} />)
  assert.match(off, /aria-pressed="false"/, 'static markup announces the off state')
  assert.match(off, />DEBUG</, 'the label is present in real HTML')
  const on = renderToStaticMarkup(<SpawnDebugToggle active onChange={() => {}} />)
  assert.match(on, /aria-pressed="true"/, 'static markup announces the on state')
})

// Wiring the unit render cannot reach: the composer places the toggle beside
// (not inside) the preset group, and WorkspaceManager carries the value into the
// spawn payload + launch input and resets it per spawn. Mirrors the
// source-contract style of BacklogRow.test.tsx.
const spawnPickerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/SpawnPicker.tsx'),
  'utf8',
)
const composerPanelSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/AgentComposer.tsx'),
  'utf8',
)
const sharedSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/agentSpawnShared.tsx'),
  'utf8',
)
const managerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/WorkspaceManager.tsx'),
  'utf8',
)
const terminalSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/panels/TerminalView.tsx'),
  'utf8',
)

run('both spawn surfaces offer the toggle as a controlled sibling of the permission control', () => {
  // The spawn picker's footer is Role / ⋯ / Permissions (MC-2122), so Debug
  // rides the ⋯ menu rather than a chip row — still a controlled toggle beside
  // the permission control, never folded into the presets themselves.
  assert.match(
    spawnPickerSource,
    /checked=\{debugMode\}[\s\S]{0,160}onClick=\{\(\) => onChangeDebugMode\(!debugMode\)\}/,
    'the spawn picker offers the toggle in its footer menu',
  )
  assert.match(
    composerPanelSource,
    /<SpawnDebugToggle active=\{debugMode\} onChange=\{onChangeDebugMode\} \/>/,
    'the New Chat panel renders the toggle in its Permissions & options disclosure',
  )
  assert.ok(
    !sharedSource.includes("value: 'debug'") && !sharedSource.includes('debug_mode'),
    'DEBUG is not folded into AGENT_SPAWN_PERMISSION_OPTIONS',
  )
})

run('WorkspaceManager carries the toggle into the spawn payload, resets it, and threads it to the picker hosts', () => {
  assert.ok(
    (managerSource.match(/debugMode: agentSpawnDebugMode/g) ?? []).length >= 3,
    'the transient toggle becomes the agent record debugMode on the CLI spawn paths',
  )
  assert.match(
    managerSource,
    /if \(agentSpawnDebugMode\) setAgentSpawnDebugMode\(false\)/,
    'the toggle resets off after a spawn so the next unrelated spawn is not silently debugged',
  )
  assert.match(
    managerSource,
    /agentSpawnDebugMode=\{agentSpawnDebugMode\}\n\s*setAgentSpawnDebugMode=\{setAgentSpawnDebugMode\}/,
    'the toggle + setter thread to the top bar spawn popover',
  )
  assert.match(
    managerSource,
    /debugMode=\{agentSpawnDebugMode\}\n\s*onChangeDebugMode=\{setAgentSpawnDebugMode\}/,
    'and to the New Chat panel via the composer debugMode/onChangeDebugMode props',
  )
})

run('every new-chat spawn path seeds the shared permission preset onto the agent record', () => {
  // The composer's Default/Auto/Bypass pick must reach the launched agent on
  // BOTH New Chat paths — the specialist seed and the General seed. The General
  // path silently dropped it (launching Bypass picks with default permissions)
  // until createNewChat seeded the preset like the specialist path does.
  assert.ok(
    (managerSource.match(/cliPermissionPreset: agentSpawnPermissionPreset/g) ?? []).length >= 5,
    'the shared preset rides every CLI spawn path, including the General new-chat seed',
  )
})

run('TerminalView forwards the agent debugMode into the launch metadata', () => {
  assert.match(
    terminalSource,
    /debugMode: finalAgent\.debugMode/,
    'the spawn payload reaches the debugMode launch input',
  )
})

if (failures > 0) {
  console.error(`SpawnDebugToggle.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('SpawnDebugToggle.test.tsx: ok')
