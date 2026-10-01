// Part of the IPC contract: the signed-in session and account.
// ../electron-api.ts re-exports everything here.

import type { SessionUser } from './window'

export type SessionOrganization = {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team' | 'enterprise'
}

export type SprintEngineAuthState = {
  authenticated: boolean
  user: SessionUser | null
  selectedOrganization: SessionOrganization | null
  status: 'checking' | 'signed_out' | 'signed_in' | 'error'
  message: string | null
}

export type SessionSnapshot =
  | {
      authenticated: true
      user: SessionUser
      selectedOrganization: SessionOrganization
    }
  | {
      authenticated: false
      user: null
      selectedOrganization: null
    }
