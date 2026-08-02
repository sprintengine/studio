import type { ReviewMatchPrProjectResult } from '../../../../shared/electron-api'

// Renderer-side controller for the PR tab's URL-first project inference (MC-1787,
// plan §3.12). The form drives it: as the reviewer types a pull-request URL, a
// debounced call to `reviewMatchPrProject` (T9) returns the open project roots
// that share the PR's repository, and this module turns that answer into the one
// project control the form should render — never an up-front project picker.
//
// T9 took the D5 fallback (no projectless storage), so a review is always stored
// inside one open project. That shapes the three settled states below: exactly
// one match resolves silently, several offer a picker of just those checkouts,
// and no match still creates the review by letting the reviewer pick where to
// keep it.

export type PrProjectControl =
  // No pull-request-shaped URL yet: nothing to resolve, so no project control.
  | { kind: 'hidden' }
  // The match call is debouncing or in flight.
  | { kind: 'matching' }
  // Exactly one open project shares the repository — resolved silently, shown as
  // a confirmation line, not a control the reviewer must operate.
  | { kind: 'confirmed'; root: string }
  // A picker is needed. `many`: several checkouts of the matched repo — offer
  // only those. `none`: no open project matches — offer every open project so the
  // review is still creatable. `error`: the match check failed — same full picker,
  // but the copy says so rather than claiming a clean no-match.
  | { kind: 'choose'; roots: string[]; reason: 'many' | 'none' | 'error' }
  // Nothing is open, so there is nowhere to store the review.
  | { kind: 'no-projects' }

// Looks-like-a-pull-request-URL gate. NOT a validator — T9's IPC is the
// authoritative matcher (it re-parses and normalises host + owner/repo). This
// only decides WHEN to spend a match call and reveal the project control, so a
// half-typed URL never flashes the no-match picker. The URL field only accepts
// web URLs, so this covers the https PR/MR paths of GitHub, GitLab, and Bitbucket.
const PR_URL_SHAPE = /^https?:\/\/[^/\s]+\/\S+\/(?:pull|pull-requests|merge_requests)\/\d+/i

export function looksLikePrUrl(url: string): boolean {
  return PR_URL_SHAPE.test(url.trim())
}

// Map a settled match result to the project control the form renders. `matches`
// is always a subset of `projectRoots` (T9 echoes only supplied roots), so the
// picker never surfaces a path the caller did not already hold.
export function resolvePrProject(
  result: ReviewMatchPrProjectResult,
  projectRoots: readonly string[],
): PrProjectControl {
  if (projectRoots.length === 0) return { kind: 'no-projects' }
  // A failed match check must not block creation: fall back to the full picker so
  // the reviewer can still store the review, but say the check failed rather than
  // presenting it as a confident no-match.
  if (!result.ok) return { kind: 'choose', roots: [...projectRoots], reason: 'error' }
  const matches = result.matches
  if (matches.length === 1) return { kind: 'confirmed', root: matches[0] }
  if (matches.length > 1) return { kind: 'choose', roots: [...matches], reason: 'many' }
  return { kind: 'choose', roots: [...projectRoots], reason: 'none' }
}

// The storage root a resolved control implies as its default selection, or null
// when the control offers no root (hidden / matching / no-projects). The form
// uses this as the default and lets the reviewer override it within a picker.
export function controlDefaultRoot(control: PrProjectControl): string | null {
  if (control.kind === 'confirmed') return control.root
  if (control.kind === 'choose') return control.roots[0] ?? null
  return null
}
