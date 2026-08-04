import assert from 'node:assert/strict'

import type { AgentCli, AgentCliAvailabilityMap } from '../../../shared/electron-api'
import { shouldAutoOpenCreationHub, shouldShowFirstRunCliCard } from './onboardingState'

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

// …but only a CLI a picker would offer counts. The probe answers for every
// registered plugin, and bundled `generic-shell` runs `sh`, which every machine
// resolves — so on the fresh Mac this card was written for, the raw map said
// "you have one" while every picker stood empty and the card never appeared.
function testAnUnofferedCliIsNotACli(): void {
  assert.equal(
    shouldShowFirstRunCliCard({
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: false, 'claude-code': false, 'generic-shell': true }),
      firstRunCliCardDismissed: false,
    }),
    true,
    'a CLI no picker offers is not this machine having an agent CLI',
  )
  assert.equal(
    shouldAutoOpenCreationHub({
      workspaceCount: 0,
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: false, 'generic-shell': true }),
      firstRunCliCardDismissed: false,
    }),
    false,
    'and the hub still waits for the question',
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

// --- First-run precedence: who gets the empty profile's window (MC-2094) ---

// THE BUG this precedence exists to fix. The card is gated on the creation hub
// being closed, and an empty profile used to open the hub unconditionally — so
// on the one machine the card is for, it could never appear. The hub waiting is
// what makes the card reachable; assert both halves of that first run together.
function testFreshProfileWithNoCliGivesTheWindowToTheCard(): void {
  const machine = {
    cliAvailabilityStatus: 'ready' as const,
    cliAvailability: availability({ codex: false, 'claude-code': false }),
    firstRunCliCardDismissed: false,
  }
  assert.equal(
    shouldAutoOpenCreationHub({ workspaceCount: 0, ...machine }),
    false,
    'a fresh profile with no CLI must not auto-open the hub over the card',
  )
  assert.equal(
    shouldShowFirstRunCliCard(machine),
    true,
    'and with the hub held back, the card is reachable in the window it exists for',
  )
}

function testFreshProfileWithACliGoesStraightToTheHub(): void {
  assert.equal(
    shouldAutoOpenCreationHub({
      workspaceCount: 0,
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: false, 'claude-code': true }),
      firstRunCliCardDismissed: false,
    }),
    true,
    'one installed CLI and first run is unchanged: hub opens, no card, no nagging',
  )
}

// Neither surface may flash while the probe is unresolved. The card already
// refuses to answer on 'loading'/'error'; the hub has to refuse too, or it opens
// on a guess in exactly the window the card would have owned.
function testUnresolvedProbeOpensNothing(): void {
  for (const cliAvailabilityStatus of ['loading', 'error'] as const) {
    assert.equal(
      shouldAutoOpenCreationHub({
        workspaceCount: 0,
        cliAvailabilityStatus,
        cliAvailability: {},
        firstRunCliCardDismissed: false,
      }),
      false,
      `the hub does not open on a guess while the probe is '${cliAvailabilityStatus}'`,
    )
    assert.equal(
      shouldShowFirstRunCliCard({
        cliAvailabilityStatus,
        cliAvailability: {},
        firstRunCliCardDismissed: false,
      }),
      false,
      `and the card does not appear while the probe is '${cliAvailabilityStatus}'`,
    )
  }
}

// "Not now" hands the window back. Without this the dismissing user is left on
// an empty stage, having closed the only thing on it.
function testDismissalReleasesTheWindowToTheHub(): void {
  assert.equal(
    shouldAutoOpenCreationHub({
      workspaceCount: 0,
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: false }),
      firstRunCliCardDismissed: true,
    }),
    true,
  )
  // Dismissal outranks even an unresolved probe: the question is settled, so
  // nothing is waiting on the answer any more.
  assert.equal(
    shouldAutoOpenCreationHub({
      workspaceCount: 0,
      cliAvailabilityStatus: 'loading',
      cliAvailability: {},
      firstRunCliCardDismissed: true,
    }),
    true,
  )
}

// The hub auto-opens for one reason only: there is nothing to open. A profile
// with workspaces is never interrupted, whatever the probe says.
function testExistingWorkspacesNeverAutoOpenTheHub(): void {
  assert.equal(
    shouldAutoOpenCreationHub({
      workspaceCount: 1,
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: false }),
      firstRunCliCardDismissed: false,
    }),
    false,
  )
  assert.equal(
    shouldAutoOpenCreationHub({
      workspaceCount: 2,
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: true }),
      firstRunCliCardDismissed: false,
    }),
    false,
  )
}

// Installing dismisses the card by making its condition false — and the same
// flip hands the window to the hub, so the user is not left staring at a card
// that has just told them everything is fine.
function testInstallingACliHandsTheWindowToTheHub(): void {
  assert.equal(
    shouldAutoOpenCreationHub({
      workspaceCount: 0,
      cliAvailabilityStatus: 'ready',
      cliAvailability: availability({ codex: true, 'claude-code': false }),
      firstRunCliCardDismissed: false,
    }),
    true,
  )
}

testAsksOnlyWhenTheMachineReallyHasNoCli()
testNeverFlashesBeforeTheProbeResolves()
testAProbeErrorDoesNotAsk()
testOneInstalledCliIsEnough()
testAnUnofferedCliIsNotACli()
testDismissedWins()
testResolvedEmptyMapAsks()
testFreshProfileWithNoCliGivesTheWindowToTheCard()
testFreshProfileWithACliGoesStraightToTheHub()
testUnresolvedProbeOpensNothing()
testDismissalReleasesTheWindowToTheHub()
testExistingWorkspacesNeverAutoOpenTheHub()
testInstallingACliHandsTheWindowToTheHub()

console.log('onboarding-state tests passed')
