// What an account surface is allowed to ask about entitlements, split in two
// on purpose (MC-2188).
//
// ACCESS — "may this account do the paid thing" — is answered by stable feature
// keys and never by the plan's name. A plan code is provider vocabulary: under
// Clerk, plans are dashboard-defined objects, so a gate spelled
// `plan.code === 'pro'` names the identity provider's data model, which is
// exactly what the entitlement seam (MC-2169, `src/main/entitlement-service.ts`)
// exists to keep out of the product. Feature keys survive a provider swap.
//
// DISPLAY — "what does this account's plan call itself" — is presentation, and
// reading the plan code for a label or a badge colour is legitimate. That is
// `planDisplayTier` and the label helpers on the surfaces themselves. Nothing
// derived from a plan code may decide what an account can do.

import type { MulticodeAuthState } from '../../../../shared/electron-api'

// The keys Pro grants that Free does not (`../multiauth/src/entitlements/catalog.ts`,
// `PLAN_FEATURES`), which is also how Pro is sold: "frontier models and the
// mobile companion". `multicode.sprintengine` is on both plans and
// `multicode.team_workspaces` / `multicode.cloud_agents` are off on both, so
// none of the three separates a paid account from a free one.
export const PAID_FEATURE_KEYS: readonly string[] = [
  'multicode.frontier_models',
  'multicode.mobile_companion',
]

// True when the account holds any paid capability. ANY rather than ALL: an
// operator grant for one key (`admin_override`) is real paid access, and an
// account that already has it should not be told to upgrade to get it.
//
// Read off the entitlement snapshot the main process publishes rather than
// through `window.api.authCheckPremiumAccess`, because these callers decide
// what to render, not whether to run an expensive or irreversible action: they
// need a synchronous answer, and the snapshot is the same one the seam decides
// from. An action that spends hosted budget must still go through the IPC seam
// for a fresh, grace-aware decision.
export function hasPaidEntitlement(authState: MulticodeAuthState): boolean {
  const features = authState.entitlements?.features
  if (!features) return false
  return PAID_FEATURE_KEYS.some((key) => features[key] === true)
}

// PRESENTATION ONLY — the account glyph's colour and the "Free"/"Pro" wording
// beside it. This reads the plan's name because a label is what it is for; it
// is not, and must never become, an access check. Use `hasPaidEntitlement` for
// anything that decides what the account can do.
export type PlanDisplayTier = 'free' | 'pro'

export function planDisplayTier(authState: MulticodeAuthState): PlanDisplayTier {
  const plan = authState.entitlements?.plan
  return plan?.status === 'active' && plan.code.toLowerCase() === 'pro' ? 'pro' : 'free'
}
