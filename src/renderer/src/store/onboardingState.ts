import type { AgentCliAvailabilityMap } from '../../../shared/electron-api'
import type { CliAvailabilityStatus } from './slices/cliAvailabilitySlice'
import { isSelectableAgentCli } from '../components/workspace/newWorkspace/cliRuntimeOptions'

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
  // Only the CLIs the pickers actually offer count as "this machine has one".
  // The probe answers for every registered plugin, and `generic-shell` runs
  // `sh` — present on every machine, offered by nothing — so counting the raw
  // map made the card unreachable on the fresh Mac it was written for.
  return !Object.entries(input.cliAvailability).some(
    ([cli, entry]) => entry?.installed === true && isSelectableAgentCli(cli),
  )
}

// The auto-open's half of the same decision. The card renders only on
// a resolved "nothing installed"; this answers the earlier question — may New
// chat take the first-run window yet? — and the two differ on the unresolved
// probe. 'loading' and 'error' render no card, but they are also no basis for
// opening a launch surface on a machine that may not be able to honour it, so
// the window is HELD rather than guessed away: nothing flashes in either
// direction.
//
// 'error' holds indefinitely, and that is deliberate — a probe that could not
// run is not evidence the machine has a CLI. The empty stage keeps its own "New
// chat" button, so holding the auto-open delays New chat, never blocks it.
function isFirstRunCliCardPending(input: {
  cliAvailabilityStatus: CliAvailabilityStatus
  cliAvailability: AgentCliAvailabilityMap
  firstRunCliCardDismissed: boolean
}): boolean {
  // Dismissal hands the window back immediately: "Not now" must drop the user
  // into New chat, not leave them on an empty stage.
  if (input.firstRunCliCardDismissed) return false
  if (input.cliAvailabilityStatus !== 'ready') return true
  return shouldShowFirstRunCliCard(input)
}

// Zero workspaces is what opens New chat, but no longer on its own: the CLI
// question comes first on a fresh profile. Before this the creation surface
// opened unconditionally on an empty profile, and the card — gated on it being
// closed — could never appear in the one window it exists for.
export function shouldAutoOpenNewChat(input: {
  workspaceCount: number
  cliAvailabilityStatus: CliAvailabilityStatus
  cliAvailability: AgentCliAvailabilityMap
  firstRunCliCardDismissed: boolean
}): boolean {
  if (input.workspaceCount > 0) return false
  return !isFirstRunCliCardPending(input)
}
