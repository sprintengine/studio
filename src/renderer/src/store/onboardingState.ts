// Phase 9 first-run onboarding — the pure state machine.
//
// A fresh install walks welcome → theme (pick an app theme) → essentials
// (set up an agent CLI + adopt/extend) → modules (choose plugins) → workspace
// (create the first one) → first-run (the activation payoff) → complete. The
// step is persisted in AppSettings so a reload mid-onboarding resumes where it
// left off. Kept pure (no React/store) so it's unit-testable; the OnboardingFlow
// component and store wiring consume it.
//
// Built to the brand system — see OnboardingFlow for the UI.

export type OnboardingStep =
  | 'welcome'
  | 'theme'
  | 'essentials'
  | 'modules'
  | 'workspace'
  | 'first-run'
  | 'complete'

// Ordered; advancing walks this sequence and clamps at 'complete'.
export const ONBOARDING_SEQUENCE: readonly OnboardingStep[] = [
  'welcome',
  'theme',
  'essentials',
  'modules',
  'workspace',
  'first-run',
  'complete',
]

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return (
    value === 'welcome' ||
    value === 'theme' ||
    value === 'essentials' ||
    value === 'modules' ||
    value === 'workspace' ||
    value === 'first-run' ||
    value === 'complete'
  )
}

// Onboarding is showing whenever we haven't reached 'complete'.
export function isOnboardingActive(step: OnboardingStep): boolean {
  return step !== 'complete'
}

// The next step in the sequence; 'complete' is terminal.
export function advanceOnboardingStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_SEQUENCE.indexOf(step)
  if (index < 0) return 'complete'
  return ONBOARDING_SEQUENCE[Math.min(index + 1, ONBOARDING_SEQUENCE.length - 1)]
}

// Whether the one-shot startup tip should open when onboarding settles at its
// terminal 'complete' step. A fresh install that walked through onboarding this
// session suppresses the tip: the guided flow already delivered the activation
// payoff, and stacking the (focus-untrapped) tip modal on the moment of
// completion both doubles modals and leaks keyboard focus to the workspace
// behind it. Existing installs reach 'complete' on the first render — never
// active this session — so they still get the tip, gated only by the user's
// show-on-startup preference. The suppression is per-session: the tip returns on
// the next launch, where onboarding is 'complete' from the first render.
export function shouldOpenStartupTipOnComplete(input: {
  onboardingActiveThisSession: boolean
  showTipsOnStartup: boolean
}): boolean {
  if (input.onboardingActiveThisSession) return false
  return input.showTipsOnStartup
}

// Resolve the starting step at hydration. A persisted, valid step wins (resume).
// Otherwise: existing installs — those that already have workspaces or already
// made a first-run module choice — are treated as 'complete' so an upgrade never
// drops a returning user into onboarding. Only a truly fresh install starts at
// 'welcome'.
export function resolveInitialOnboardingStep(input: {
  persisted?: unknown
  modulesChosen?: boolean
  hasWorkspaces: boolean
}): OnboardingStep {
  if (isOnboardingStep(input.persisted)) return input.persisted
  if (input.hasWorkspaces || input.modulesChosen) return 'complete'
  return 'welcome'
}
