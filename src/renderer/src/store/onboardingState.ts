import type { AgentCliAvailabilityMap } from '../../../shared/electron-api'
import type { CliAvailabilityStatus } from './slices/cliAvailabilitySlice'

// What is left of first-run onboarding: one predicate.
//
// The wizard used to walk welcome → theme → essentials → modules → workspace →
// first-run, persisting its position so a reload resumed mid-flow. Every question
// it asked, the app already answered — the theme defaults to the OS, every
// bundled module is on, and the CLI probe runs at boot. The one thing the app
// genuinely cannot answer is "you have no agent CLI installed", and that is a
// fact about the machine, not a step in a sequence.
//
// So this is a live predicate over probe state, NOT a persisted position. That
// distinction is the whole design: availability resolves asynchronously, AFTER
// hydration, so a synchronous answer (the way the old resolveInitialOnboardingStep
// worked) would have to guess — and it would guess "no CLI" for the majority of
// users who have one, flashing the card at them before the probe came back.
// Waiting for `ready` is what makes the card honest.
export function shouldShowFirstRunCliCard(input: {
  cliAvailabilityStatus: CliAvailabilityStatus
  cliAvailability: AgentCliAvailabilityMap
  firstRunCliCardDismissed: boolean
}): boolean {
  if (input.firstRunCliCardDismissed) return false
  // 'loading' is "we do not know yet" and 'error' is "we could not find out".
  // Neither is evidence of absence, and asking on either would put a card in
  // front of a user whose CLI is sitting right there.
  if (input.cliAvailabilityStatus !== 'ready') return false
  return !Object.values(input.cliAvailability).some((entry) => entry?.installed === true)
}
