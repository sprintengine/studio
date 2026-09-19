import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChipButton } from '../ui/ChipButton'
import { SpawnDebugToggle } from './agentComposer/agentSpawnShared'
import { test } from 'vitest'

test('SpawnDebugToggle', async () => {
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
  // directly returns its element tree (a Tooltip wrapping the kit's `ChipButton`).
  // That lets us exercise the controlled toggle's props, state and click behaviour
  // without a DOM or the store/window-bound parent menu. What it is DRAWN with is
  // the kit's business, so the chrome assertions read the rendered markup instead
  // of a className string the call site no longer writes.
  function tooltipElement(active: boolean, onChange: (next: boolean) => void): ReactElement {
    return SpawnDebugToggle({ active, onChange }) as ReactElement
  }
  function buttonOf(el: ReactElement): ReactElement {
    return el.props.children as ReactElement
  }

  run('is the kit chip, labelled "DEBUG" and left in the tab order', () => {
    const button = buttonOf(tooltipElement(false, () => {}))
    assert.equal(button.type, ChipButton, 'the toggle is the kit chip, not a hand-rolled control')
    assert.equal(button.props.children, 'DEBUG', 'state is carried by a literal label, not color alone')
    assert.equal(button.props.disabled, undefined, 'the toggle is always operable')
    assert.equal(button.props.tabIndex, undefined, 'no negative tabIndex — it stays in the tab order')
    assert.match(
      renderToStaticMarkup(<SpawnDebugToggle active={false} onChange={() => {}} />),
      /<button type="button"/,
      'the chip renders a native <button>, which is inherently keyboard-focusable and toggleable',
    )
  })

  run('inactive: pressed=false, the quiet tone, and no error fill', () => {
    const button = buttonOf(tooltipElement(false, () => {}))
    assert.equal(button.props.pressed, false, 'off state is announced via the chip’s aria-pressed')
    assert.equal(button.props.tone, 'subtle', 'inactive takes the chip’s quietest ink')
    const markup = renderToStaticMarkup(<SpawnDebugToggle active={false} onChange={() => {}} />)
    assert.match(markup, /text-\[color:var\(--text-subtle\)\]/, 'inactive uses the quiet ink')
    assert.match(markup, /hover:text-\[color:var\(--text-default\)\]/, 'inactive lifts on hover rather than filling')
    assert.ok(!markup.includes('--tone-error-soft'), 'no error fill when off')
  })

  run('active: pressed=true with the error-tone fill', () => {
    const button = buttonOf(tooltipElement(true, () => {}))
    assert.equal(button.props.pressed, true, 'on state is announced via the chip’s aria-pressed')
    assert.equal(button.props.tone, 'error', 'a thrown DEBUG keeps its own tint rather than going neutral')
    const markup = renderToStaticMarkup(<SpawnDebugToggle active onChange={() => {}} />)
    assert.match(markup, /bg-\[color:var\(--tone-error-soft\)\]/, 'active uses the error-tone soft fill')
    assert.match(
      markup,
      /text-\[color:var\(--tone-error-on-tint\)\]/,
      'active label uses the deeper on-tint error ink that clears AA on the soft fill',
    )
  })

  run('carries a visible focus ring and a tooltip noting Auto/Bypass work best', () => {
    const el = tooltipElement(false, () => {})
    assert.match(
      renderToStaticMarkup(<SpawnDebugToggle active={false} onChange={() => {}} />),
      /focus-visible:focus-ring/,
      'keyboard focus is visible, not suppressed',
    )
    assert.match(String(el.props.content), /Auto/, 'the tooltip notes the Auto preset')
    assert.match(String(el.props.content), /Bypass/, 'the tooltip notes the Bypass preset')
  })

  run('clicking toggles by calling onChange with the negated value', () => {
    let received: boolean | null = null
    buttonOf(
      tooltipElement(false, (next) => {
        received = next
      }),
    ).props.onClick()
    assert.equal(received, true, 'an off toggle turns on')

    received = null
    buttonOf(
      tooltipElement(true, (next) => {
        received = next
      }),
    ).props.onClick()
    assert.equal(received, false, 'an on toggle turns off')
  })

  run('renders on the real server surface with the DEBUG label and aria-pressed', () => {
    const off = renderToStaticMarkup(<SpawnDebugToggle active={false} onChange={() => {}} />)
    assert.match(off, /aria-pressed="false"/, 'static markup announces the off state')
    assert.match(off, />DEBUG</, 'the label is present in real HTML')
    const on = renderToStaticMarkup(<SpawnDebugToggle active onChange={() => {}} />)
    assert.match(on, /aria-pressed="true"/, 'static markup announces the on state')
  })

  // Wiring the unit render cannot reach: DEBUG is not a permission preset, and
  // WorkspaceManager carries the value into the
  // spawn payload + launch input and resets it per spawn. Mirrors the
  // source-contract style of BacklogRow.test.tsx.
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

  run('DEBUG stays out of the permission options', () => {
    assert.ok(
      !sharedSource.includes("value: 'debug'") && !sharedSource.includes('debug_mode'),
      'DEBUG is not folded into AGENT_SPAWN_PERMISSION_OPTIONS',
    )
  })

  run(
    'WorkspaceManager carries the toggle into the spawn payload, resets it, and threads it to the New Chat panel',
    () => {
      assert.ok(
        (managerSource.match(/debugMode: agentSpawnDebugMode/g) ?? []).length >= 2,
        'the transient toggle becomes the agent record debugMode on the CLI spawn paths',
      )
      assert.match(
        managerSource,
        /if \(agentSpawnDebugMode\) setAgentSpawnDebugMode\(false\)/,
        'the toggle resets off after a spawn so the next unrelated spawn is not silently debugged',
      )
      // The top bar's spawn popover is gone (MC-2222); the New Chat panel and the
      // launcher's picker are the hosts that remain.
      assert.match(
        managerSource,
        /debugMode=\{agentSpawnDebugMode\}\n\s*onChangeDebugMode=\{setAgentSpawnDebugMode\}/,
        'the toggle + setter thread to the New Chat panel via the composer debugMode/onChangeDebugMode props',
      )
    },
  )

  run('every CLI spawn path seeds the picked row’s permission preset onto the agent record', () => {
    // The Default/Auto/Bypass pick must reach the launched agent on every CLI
    // path — the in-workspace spawn and the New Chat seed. The new-chat path
    // silently dropped it (launching Bypass picks with default permissions) until
    // createNewChat seeded it too.
    //
    // The preset is stored against the MODEL ROW now (owner, 2026-09-05), so each
    // path resolves it from the (cli, model) it is launching rather than reading
    // one app-wide value — which is also what keeps a path from seeding a preset
    // for a different row than the one it spawns.
    assert.ok(
      (managerSource.match(/cliPermissionPreset: resolveModelPermissionPreset\(/g) ?? []).length >= 2,
      'every CLI spawn path resolves the row’s preset',
    )
    assert.match(
      managerSource,
      /cliPermissionPreset: resolveModelPermissionPreset\(templateAgentCli, cliModel, agentSpawnPermissionPreset\)/,
      'including the new-chat seed, on the model that chat launches with',
    )
    // A conversation is a provider/model pair, not a picker row: it has no stored
    // preset and keeps the app-wide default.
    assert.ok(
      (managerSource.match(/cliPermissionPreset: agentSpawnPermissionPreset/g) ?? []).length === 2,
      'only the two conversation spawns fall back to the app-wide preset',
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
})
