/**
 * The lines the background tray renders. The rule under test is
 * honesty: every counter names what main actually holds, and a zero is stated
 * rather than hidden behind an empty menu.
 */
import assert from 'node:assert/strict'
import {
  buildBackgroundTrayItems,
  describeBackgroundGateway,
  describeBackgroundSessions,
  describeBackgroundTooltip,
  emptyBackgroundStatus,
  runBackgroundTrayAction,
  type BackgroundStatus,
} from './background-mode'
import { test } from 'vitest'

test('background-mode', async () => {
  function status(overrides: Partial<BackgroundStatus> = {}): BackgroundStatus {
    return { ...emptyBackgroundStatus(), ...overrides }
  }

  // nothing running: every line says so out loud
  {
    const empty = status()
    assert.equal(describeBackgroundSessions(empty), 'No agent sessions running')
    assert.equal(describeBackgroundGateway(empty), 'Studio gateway not listening')
    const items = buildBackgroundTrayItems(empty)
    assert.ok(items.some((item) => item.id === 'open'))
    assert.ok(items.some((item) => item.id === 'quit'))
  }

  // counts are pluralized and the tooltip carries both readouts, in order
  {
    const one = status({ agentSessions: 1, gateway: { running: true } })
    assert.equal(describeBackgroundSessions(one), '1 agent session running')
    assert.equal(describeBackgroundGateway(one), 'Studio gateway listening')
    assert.match(
      describeBackgroundTooltip(one),
      /^Multicode — running in the background · 1 agent session running · Studio gateway listening$/,
    )

    const several = status({ agentSessions: 3 })
    assert.equal(describeBackgroundSessions(several), '3 agent sessions running')
  }

  // status lines are readouts, never controls; only open/quit are actionable
  {
    const items = buildBackgroundTrayItems(status({ agentSessions: 2 }))
    const actionable = items.filter((item) => item.kind === 'action').map((item) => item.id)
    assert.deepEqual(actionable, ['open', 'quit'])
    assert.equal(items.filter((item) => item.kind === 'separator').length, 1)
  }

  // the two actions dispatch to exactly one thing each — Quit must reach the
  // app's own quit, which is what runs the graceful shutdown path
  {
    const calls: string[] = []
    const actions = { open: () => calls.push('open'), quit: () => calls.push('quit') }
    for (const item of buildBackgroundTrayItems(status({ agentSessions: 1 }))) {
      runBackgroundTrayAction(item.id, actions)
    }
    assert.deepEqual(calls, ['open', 'quit'], 'no status line is wired to an action')
  }

  console.log('background-mode model tests passed')
})
