// Part of the IPC contract: the signed-in session and account.
// ../electron-api.ts re-exports everything here.

import type { SessionUser } from './window'

export type SessionOrganization = {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team' | 'enterprise'
}

export type FeatureValue = boolean | number | string

export type EntitlementSnapshot = {
  userId: string
  organizationId: string
  product: 'sprintengine'
  roles: string[]
  features: Record<string, FeatureValue>
  limits: Record<string, number>
  sources: Record<string, string>
  plan: {
    code: string
    status: string
  }
  issuedAt: string
  expiresAt: string
  schemaVersion: 1
}

export type SprintEngineAuthState = {
  authenticated: boolean
  user: SessionUser | null
  selectedOrganization: SessionOrganization | null
  entitlements: EntitlementSnapshot | null
  status: 'checking' | 'signed_out' | 'signed_in' | 'error'
  entitlementStatus: 'fresh' | 'offline_grace' | 'expired' | 'missing'
  message: string | null
  lastRefreshAt: string | null
  graceExpiresAt: string | null
}

export type PremiumAccessRequest = {
  featureKey: string
  amount?: number
  hostedCost?: boolean
}

export type PremiumAccessDecision = {
  allowed: boolean
  featureKey: string
  value: FeatureValue | undefined
  status: 'fresh' | 'offline_grace' | 'expired' | 'signed_out' | 'missing' | 'error'
  message: string
  limit?: number
  graceExpiresAt?: string
}

export type SessionSnapshot =
  | {
      authenticated: true
      user: SessionUser
      selectedOrganization: SessionOrganization
      session: {
        id: string
        expiresAt: string
      }
    }
  | {
      authenticated: false
      user: null
      selectedOrganization: null
    }
