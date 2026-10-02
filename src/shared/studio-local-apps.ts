import type { StudioScope } from '../../packages/studio-protocol/src/public'
import type { CliPermissionPreset } from './cli-permission-preset'

// The applications on this machine paired with Studio's owner socket, as
// Settings shows and manages them. Pairing, revoking and reading the list are
// IPC-only, like the tailnet's: nothing a paired app can call reaches them, so
// an app can neither pair another nor widen its own grant.

export const STUDIO_LOCAL_APPS_STATUS_CHANNEL = 'studio-local-apps:status'
export const STUDIO_LOCAL_APPS_OFFER_CHANNEL = 'studio-local-apps:offer'
export const STUDIO_LOCAL_APPS_CANCEL_OFFER_CHANNEL = 'studio-local-apps:cancel-offer'
export const STUDIO_LOCAL_APPS_REVOKE_CHANNEL = 'studio-local-apps:revoke'
export const STUDIO_LOCAL_APPS_SET_REACH_CHANNEL = 'studio-local-apps:set-reach'
/** Pushed to every window with fresh status whenever an app pairs, connects, leaves or is revoked. */
export const STUDIO_LOCAL_APPS_CHANGED_CHANNEL = 'studio-local-apps:changed'

/** One paired app. Its token is never part of this: Studio keeps only its hash. */
export type StudioLocalApp = {
  id: string
  /** The name it was paired under, chosen in Settings. */
  name: string
  scopes: StudioScope[]
  /** The loosest permission preset its chats may run on. */
  ceiling: CliPermissionPreset
  createdAt: string
  lastSeenAt: string | null
  /**
   * Which agents the tools it offers reach, when it may offer tools
   * (`tools:offer`): the conversations it starts (`own`), or every
   * conversation and terminal agent on this machine (`all`).
   */
  toolReach: StudioLocalAppToolReach
  /** Whether it has a connection open now. */
  connected: boolean
  /** The toolsets it gives agents, and how each stands now. */
  toolsets: StudioLocalAppToolset[]
}

export type StudioLocalAppToolset = {
  name: string
  title: string
  tools: number
  /** Offered by a connected process, waiting out a reconnect, or not offered now. */
  state: 'offered' | 'reconnecting' | 'not_offered'
}

export type StudioLocalAppToolReach = 'own' | 'all'

/** A pairing code minted and not yet redeemed. The code itself is shown once, when minted. */
export type StudioLocalAppOffer = {
  id: string
  name: string
  scopes: StudioScope[]
  ceiling: CliPermissionPreset
  toolReach: StudioLocalAppToolReach
  expiresAt: string
}

export type StudioLocalAppsStatus = {
  running: boolean
  socketPath: string | null
  lastError: string | null
  apps: StudioLocalApp[]
  offers: StudioLocalAppOffer[]
}

/** What minting a pairing code answers: the code, once, and the status with the offer in it. */
export type StudioLocalAppOfferView = { offer: StudioLocalAppOffer; code: string; status: StudioLocalAppsStatus }

export type StudioLocalAppOfferInput = {
  name: string
  scopes: StudioScope[]
  ceiling: CliPermissionPreset
  toolReach: StudioLocalAppToolReach
}
