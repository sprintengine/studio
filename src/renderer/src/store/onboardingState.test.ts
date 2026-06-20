import assert from 'node:assert/strict'

import {
  advanceOnboardingStep,
  isOnboardingActive,
  isOnboardingStep,
  resolveInitialOnboardingStep,
} from './onboardingState'

function testAdvanceWalksSequenceAndClamps(): void {
  assert.equal(advanceOnboardingStep('welcome'), 'theme')
  assert.equal(advanceOnboardingStep('theme'), 'essentials')
  assert.equal(advanceOnboardingStep('essentials'), 'modules')
  assert.equal(advanceOnboardingStep('modules'), 'workspace')
  assert.equal(advanceOnboardingStep('workspace'), 'first-run')
  assert.equal(advanceOnboardingStep('first-run'), 'complete')
  assert.equal(advanceOnboardingStep('complete'), 'complete', 'complete is terminal')
}

function testActiveUntilComplete(): void {
  assert.equal(isOnboardingActive('welcome'), true)
  assert.equal(isOnboardingActive('theme'), true)
  assert.equal(isOnboardingActive('essentials'), true)
  assert.equal(isOnboardingActive('modules'), true)
  assert.equal(isOnboardingActive('workspace'), true)
  assert.equal(isOnboardingActive('first-run'), true)
  assert.equal(isOnboardingActive('complete'), false)
}

function testGuard(): void {
  assert.equal(isOnboardingStep('welcome'), true)
  assert.equal(isOnboardingStep('theme'), true)
  assert.equal(isOnboardingStep('essentials'), true)
  assert.equal(isOnboardingStep('first-run'), true)
  assert.equal(isOnboardingStep('complete'), true)
  // 'cli' was replaced by 'essentials' and is no longer a valid step.
  assert.equal(isOnboardingStep('cli'), false)
  assert.equal(isOnboardingStep('nope'), false)
  assert.equal(isOnboardingStep(undefined), false)
  assert.equal(isOnboardingStep(2), false)
}

function testInitialResume(): void {
  // A persisted valid step always wins (resume mid-onboarding).
  assert.equal(
    resolveInitialOnboardingStep({ persisted: 'modules', hasWorkspaces: false }),
    'modules'
  )
  assert.equal(
    resolveInitialOnboardingStep({ persisted: 'workspace', hasWorkspaces: true }),
    'workspace',
    'persisted step wins even if workspaces exist'
  )
}

function testInitialFreshVsExisting(): void {
  // Truly fresh install → welcome.
  assert.equal(resolveInitialOnboardingStep({ hasWorkspaces: false }), 'welcome')
  // Existing install (has workspaces) → complete, never re-onboard on upgrade.
  assert.equal(resolveInitialOnboardingStep({ hasWorkspaces: true }), 'complete')
  // Already chose modules (legacy modulesChosen) but no workspaces → complete.
  assert.equal(
    resolveInitialOnboardingStep({ modulesChosen: true, hasWorkspaces: false }),
    'complete'
  )
  // Invalid persisted value falls back to the fresh/existing logic.
  assert.equal(resolveInitialOnboardingStep({ persisted: 'garbage', hasWorkspaces: false }), 'welcome')
}

testAdvanceWalksSequenceAndClamps()
testActiveUntilComplete()
testGuard()
testInitialResume()
testInitialFreshVsExisting()
console.log('onboarding-state tests passed')
