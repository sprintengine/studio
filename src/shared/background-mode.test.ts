/**
 * MC-2156 — the lines the background tray renders. The rule under test is
 * honesty: every counter names what main actually holds, and a zero is stated
 * rather than hidden behind an empty menu.
 */
import assert from 'node:assert/strict'
import {
  BACKGROUND_TRAY_RUN_LINES,
  buildBackgroundTrayItems,
  countAutoRunningRuns,
  describeBackgroundGateway,
  describeBackgroundRuns,
  describeBackgroundSessions,
  describeBackgroundTooltip,
  emptyBackgroundStatus,
  runBackgroundTrayAction,
  type BackgroundStatus,
} from './background-mode'

function status(overrides: Partial<BackgroundStatus> = {}): BackgroundStatus {
  return { ...emptyBackgroundStatus(), ...overrides }
}

function labels(input: BackgroundStatus): string[] {
  return buildBackgroundTrayItems(input)
    .filter((item) => item.kind !== 'separator')
    .map((item) => item.label ?? '')
}

// nothing running: every line says so out loud
{
  const empty = status()
  assert.equal(describeBackgroundRuns(empty), 'No sprint runs registered')
  assert.equal(describeBackgroundSessions(empty), 'No agent sessions running')
  assert.equal(describeBackgroundGateway(empty), 'Studio gateway not listening')
  const items = buildBackgroundTrayItems(empty)
  assert.ok(items.some((item) => item.id === 'open'))
  assert.ok(items.some((item) => item.id === 'quit'))
  assert.equal(items.filter((item) => item.id.startsWith('run:')).length, 0)
}

// registered-but-idle is not the same fact as auto-running
{
  const idle = status({ runs: [{ name: 'Headless Core', autoRunning: false }] })
  assert.equal(describeBackgroundRuns(idle), '1 sprint run, none auto-running')
  assert.equal(countAutoRunningRuns(idle), 0)
  assert.ok(labels(idle).includes('    Headless Core — idle'))
}

// counts are pluralized and the auto-running subset is named
{
  const mixed = status({
    runs: [
      { name: 'Alpha', autoRunning: true },
      { name: 'Beta', autoRunning: true },
      { name: 'Gamma', autoRunning: false },
    ],
    agentSessions: 1,
    gateway: { running: true },
  })
  assert.equal(describeBackgroundRuns(mixed), '2 of 3 sprint runs auto-running')
  assert.equal(describeBackgroundSessions(mixed), '1 agent session running')
  assert.equal(describeBackgroundGateway(mixed), 'Studio gateway listening')
  assert.match(describeBackgroundTooltip(mixed), /^Multicode — running in the background · 2 of 3 sprint runs auto-running · 1 agent session running$/)
}

// many runs: the list is capped and says how many it left out — never silently truncated
{
  const many = status({
    runs: Array.from({ length: BACKGROUND_TRAY_RUN_LINES + 3 }, (_, index) => ({
      name: `Run ${index}`,
      autoRunning: index % 2 === 0,
    })),
  })
  const runLabels = labels(many).filter((label) => label.startsWith('    '))
  assert.equal(runLabels.length, BACKGROUND_TRAY_RUN_LINES + 1)
  assert.equal(runLabels.at(-1), '    +3 more')
}

// status lines are readouts, never controls; only open/quit are actionable
{
  const items = buildBackgroundTrayItems(status({ runs: [{ name: 'A', autoRunning: true }] }))
  const actionable = items.filter((item) => item.kind === 'action').map((item) => item.id)
  assert.deepEqual(actionable, ['open', 'quit'])
  assert.equal(items.filter((item) => item.kind === 'separator').length, 1)
}

// the two actions dispatch to exactly one thing each — Quit must reach the
// app's own quit, which is what runs the graceful shutdown path
{
  const calls: string[] = []
  const actions = { open: () => calls.push('open'), quit: () => calls.push('quit') }
  for (const item of buildBackgroundTrayItems(status({ runs: [{ name: 'A', autoRunning: true }] }))) {
    runBackgroundTrayAction(item.id, actions)
  }
  assert.deepEqual(calls, ['open', 'quit'], 'no status line is wired to an action')
}

console.log('background-mode model tests passed')
