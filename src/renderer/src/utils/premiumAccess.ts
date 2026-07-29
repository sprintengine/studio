import type { FeatureValue, MulticodeAuthState, PremiumAccessDecision } from '../../../shared/electron-api'

export const SPRINT_ENGINE_FEATURE_KEY = 'multicode.sprintengine'

export type PremiumFeatureAccessState = {
  allowed: boolean
  title: string
  body: string
  action: 'login'
}

type PremiumAccessPorts = {
  authRefreshEntitlements: Window['api']['authRefreshEntitlements']
  authCheckPremiumAccess: Window['api']['authCheckPremiumAccess']
}

function entitlementFeatureValue(authState: MulticodeAuthState, featureKey: string): FeatureValue | undefined {
  return authState.entitlements?.features[featureKey]
}

export function getSprintEngineAccessState(authState: MulticodeAuthState): PremiumFeatureAccessState {
  if (!authState.authenticated) {
    return {
      allowed: false,
      title: 'Sprint Engine is locked while signed out.',
      body: 'Sign in to create or supervise local Sprint Engine specialist workflows.',
      action: 'login',
    }
  }

  const value = entitlementFeatureValue(authState, SPRINT_ENGINE_FEATURE_KEY)
  if (value === true) {
    return {
      allowed: true,
      title: 'Sprint Engine is available.',
      body: 'This signed-in session can create local Sprint Engine workflows.',
      action: 'login',
    }
  }

  return {
    allowed: false,
    title: 'Sprint Engine requires Multicode Pro.',
    body: 'Refresh access or switch to an organization with Sprint Engine entitlement.',
    action: 'login',
  }
}

export async function requireFreshSprintEngineAccess(
  ports: PremiumAccessPorts,
  setAuthState: (authState: MulticodeAuthState) => void,
): Promise<PremiumAccessDecision> {
  const authState = await ports.authRefreshEntitlements()
  setAuthState(authState)

  const decision = await ports.authCheckPremiumAccess({ featureKey: SPRINT_ENGINE_FEATURE_KEY })
  if (!decision.allowed) {
    throw new Error(decision.message || 'Sprint Engine access could not be verified.')
  }

  return decision
}
