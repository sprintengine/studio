import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { FirstRunPayoff, runFirstRunPayoffAction } from './FirstRunPayoff'

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

type Calls = { launch: number; palette: number; done: number; order: string[] }
function trackedActions(): { actions: Parameters<typeof runFirstRunPayoffAction>[1]; calls: Calls } {
  const calls: Calls = { launch: 0, palette: 0, done: 0, order: [] }
  return {
    calls,
    actions: {
      onLaunchFirstAgent: () => {
        calls.launch += 1
        calls.order.push('launch')
      },
      onOpenCommandPalette: () => {
        calls.palette += 1
        calls.order.push('palette')
      },
      onDone: () => {
        calls.done += 1
        calls.order.push('done')
      },
    },
  }
}

// --- runFirstRunPayoffAction: the real-action contract (AC1/AC2/AC3) ---

run('CLI configured → launches the real first agent run, then finishes onboarding', () => {
  const { actions, calls } = trackedActions()
  runFirstRunPayoffAction(true, actions)
  // The launch handler is WorkspaceManager's real createNewChat — no simulated path.
  assert.deepEqual(calls.order, ['launch', 'done'])
  assert.equal(calls.palette, 0)
})

run('no CLI configured → opens the real command palette, then finishes onboarding', () => {
  const { actions, calls } = trackedActions()
  runFirstRunPayoffAction(false, actions)
  // The palette handler is runCommand('commandPalette.open') — the honest fallback.
  assert.deepEqual(calls.order, ['palette', 'done'])
  assert.equal(calls.launch, 0)
})

run('never fires both actions for a single primary press', () => {
  for (const hasCli of [true, false]) {
    const { actions, calls } = trackedActions()
    runFirstRunPayoffAction(hasCli, actions)
    assert.equal(calls.launch + calls.palette, 1)
    assert.equal(calls.done, 1)
  }
})

// --- FirstRunPayoff markup: correct CTA per state + adopting gate (AC2/AC4) ---

const noop = () => {}
const renderProps = {
  onLaunchFirstAgent: noop,
  onOpenCommandPalette: noop,
  onDone: noop,
  adoption: null,
}

run('shows the run CTA when a CLI is configured', () => {
  const html = renderToStaticMarkup(<FirstRunPayoff {...renderProps} hasConfiguredCli={true} />)
  assert.match(html, /Run your first agent/)
  assert.match(html, /Open workspace/)
  // No button is gated when no adoption is in flight.
  assert.equal((html.match(/disabled=""/g) ?? []).length, 0)
})

run('shows the command-palette CTA when no CLI is configured', () => {
  const html = renderToStaticMarkup(<FirstRunPayoff {...renderProps} hasConfiguredCli={false} />)
  assert.match(html, /Open command palette/)
  assert.match(html, /No agent CLI is set up yet/)
})

run('gates both buttons while a deferred adoption is still writing', () => {
  const html = renderToStaticMarkup(
    <FirstRunPayoff {...renderProps} hasConfiguredCli={true} adoption={{ status: 'adopting' }} />,
  )
  // Disabled until adoption resolves so its success/failure is never hidden.
  assert.match(html, /Finishing setup/)
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
  assert.doesNotMatch(html, /Run your first agent/)
})

if (failures > 0) {
  console.error(`FirstRunPayoff.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('FirstRunPayoff.test.tsx: ok')
