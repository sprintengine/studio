// Phase 9 first-run onboarding — the pure state machine.
//
// A fresh install walks welcome → modules (choose plugins) → workspace (create
// the first one) → complete. The step is persisted in AppSettings so a reload
// mid-onboarding resumes where it left off. Kept pure (no React/store) so it's
// unit-testable; the OnboardingFlow component and store wiring consume it.
//
// Built to the brand system (knowledge/brand) — see OnboardingFlow for the UI.

export type OnboardingStep = 'welcome' | 'modules' | 'workspace' | 'complete'

// Ordered; advancing walks this sequence and clamps at 'complete'.
export const ONBOARDING_SEQUENCE: readonly OnboardingStep[] = [
  'welcome',
  'modules',
  'workspace',
  'complete',
]

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return (
    value === 'welcome' || value === 'modules' || value === 'workspace' || value === 'complete'
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
