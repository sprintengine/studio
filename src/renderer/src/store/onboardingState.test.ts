import assert from 'node:assert/strict'

import type { AgentCli, AgentCliAvailabilityMap } from '../../../shared/electron-api'
import { shouldShowFirstRunCliCard } from './onboardingState'

function availability(entries: Record<string, boolean>): AgentCliAvailabilityMap {
  const map: AgentCliAvailabilityMap = {}
  for (const [cli, installed] of Object.entries(entries)) {
    map[cli as AgentCli] = {
      cli: cli as AgentCli,
      installed,
      resolvedPath: installed ? `/usr/bin/${cli}` : null,
      version: installed ? '1.0.0' : null,
    }
  }
  return map
}

// The card exists for exactly one machine: probe finished, nothing installed,
// never dismissed.
function testAsksOnlyWhenTheMachineReallyHasNoCli(): void {
  assert.equal(
    shouldShowFirstRunCliCard({
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: false, 'claude-code': false }),
      firstRunCliCardDismissed: false,
    }),
    true,
    'a resolved probe with nothing installed is the one case worth asking about',
  )
}

// THE TRAP the whole predicate exists to avoid. Availability resolves after
// hydration, so for the first moments of every launch the map is empty and
// 'loading'. Answering then would flash the card at the majority of users, who
// do have a CLI — the probe just has not said so yet.
function testNeverFlashesBeforeTheProbeResolves(): void {
  assert.equal(
    shouldShowFirstRunCliCard({
      cliAvailabilityStatus: 'loading',
      cliAvailability: {},
      firstRunCliCardDismissed: false,
    }),
    false,
    'an unresolved probe is not evidence of absence',
  )
  assert.equal(
    shouldShowFirstRunCliCard({
      cliAvailabilityStatus: 'loading',
      cliAvailability: availability({ codex: false }),
      firstRunCliCardDismissed: false,
    }),
    false,
    'a partial map mid-probe is not evidence of absence either',
  )
}

// A probe that failed could not find out. Treating "we could not check" as "you
// have nothing" would put a card in front of a user whose CLI is sitting there.
function testAProbeErrorDoesNotAsk(): void {
  assert.equal(
    shouldShowFirstRunCliCard({
      cliAvailabilityStatus: 'error',
      cliAvailability: {},
      firstRunCliCardDismissed: false,
    }),
    false,
  )
}

function testOneInstalledCliIsEnough(): void {
  assert.equal(
    shouldShowFirstRunCliCard({
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: false, 'claude-code': true, gemini: false }),
      firstRunCliCardDismissed: false,
    }),
    false,
    'the question is "any CLI at all", not "every CLI"',
  )
}

// Dismissal is the only persisted bit of the old wizard that survives, and it is
// absolute: a user who said "not now" is never asked again, even if they later
// uninstall the CLI they had.
function testDismissedWins(): void {
  assert.equal(
    shouldShowFirstRunCliCard({
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: false }),
      firstRunCliCardDismissed: true,
    }),
    false,
  )
}

// An empty map with a resolved status is a real answer: the probe ran and found
// no registered CLI installed. This is the fresh-machine case.
function testResolvedEmptyMapAsks(): void {
  assert.equal(
    shouldShowFirstRunCliCard({
      cliAvailabilityStatus: 'ready',
      cliAvailability: {},
      firstRunCliCardDismissed: false,
    }),
    true,
  )
}

testAsksOnlyWhenTheMachineReallyHasNoCli()
testNeverFlashesBeforeTheProbeResolves()
testAProbeErrorDoesNotAsk()
testOneInstalledCliIsEnough()
testDismissedWins()
testResolvedEmptyMapAsks()

console.log('onboarding-state tests passed')
