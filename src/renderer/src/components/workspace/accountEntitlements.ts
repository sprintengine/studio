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

// The one key the paid plan gates. Decision of record (owner, 2026-09-01,
// MC-1579): nothing is gated by the paid plan except the ability to use the
// mobile app. Sprint Engine is free, and no other capability is paid — the
// `multicode.frontier_models` key that used to sit here was retired from the
// Multiauth catalogue in the same change, because nothing in the product ever
// consumed it. Enforcement lives on the server: every relay entry point in
// `../multiauth/src/relay/service.ts` refuses without this key, so what the
// desktop reads here only decides what to render, never what the account can do.
const PAID_FEATURE_KEYS: readonly string[] = [
  'multicode.mobile_companion',
]

// True when the account holds any paid capability. ANY rather than ALL, so a
// second paid key can be added without turning this into "has every one": an
// operator grant (`admin_override`) for a key is real paid access, and an
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
