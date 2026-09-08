// "New since you last looked", for the Design door.
//
// The model picker's chip reads a model's `releasedAt` against a fixed window,
// with no per-machine state: a model is new to everybody for thirty days. A
// design system cannot work that way — the bundle is the user's own repo, and
// what matters is what arrived since THEY last opened it, which is a fact about
// this machine and nothing else. So the rule here has two halves:
//
//   seen before   → an entry is new when it arrived after the last visit.
//   never seen    → almost everything is treated as already seen, EXCEPT what
//                   arrived inside the same window the model picker uses. A
//                   fresh profile that points at a repo with 200 components must
//                   not light up 200 markers; it should still surface the four
//                   that landed this week.
//
// The window is the model picker's own constant, imported rather than restated:
// one word, one meaning, one duration.
//
// Nothing here reads a clock or a store. `addedAt` comes from the reader
// (main-process, git or birthtime — see `src/main/design-system/entry-added-at.ts`)
// and `seenAt` from app settings, so the whole rule is one pure function that a
// test can drive with fabricated dates.

import { HOSTED_MODEL_NEW_FOR_DAYS } from '../hosted-model-feed'

/** The same window the model picker's "New" chip uses. */
export const DESIGN_SYSTEM_NEW_FOR_DAYS = HOSTED_MODEL_NEW_FOR_DAYS

/**
 * The key an entry is addressed by, across the reader, the IPC payload and the
 * canvas: its manifest group plus the entry string the manifest declares,
 * VERBATIM.
 *
 * A colon rather than a slash, because `contents.patterns` declares
 * bundle-relative paths ("patterns/context-rail.html") while
 * `contents.components` declares bare directory names ("badge") — joining the
 * group onto the entry with a slash would produce `patterns/patterns/…` for one
 * and be ambiguous for the other. Neither half is ever re-derived: the manifest
 * string is the identity, so a bundle that spells an entry two ways gets two
 * keys rather than one that silently merges them.
 */
export function designSystemEntryKey(groupKey: string, entry: string): string {
  return `${groupKey}:${entry}`
}

/**
 * Which entries arrived since the last visit.
 *
 * Returned as a Set of entry keys rather than a boolean per call, so a canvas
 * drawing 200 tiles asks the question once.
 *
 * Clock skew is deliberately counted as NEW rather than filtered out: an
 * `addedAt` in the future means the machine's clock moved, or the repo carries a
 * commit dated ahead, and the honest reading of "arrived after you last looked"
 * is yes. The model picker's rule does the opposite (a future `releasedAt` is
 * not new yet) because a feed is published to everyone and an early date there
 * is an editing mistake we should not amplify; a local repo's dates are the
 * user's own.
 *
 * With no `addedAt` data at all — a bundle outside git whose files carry no
 * usable birthtime — nothing is marked. An unknown date is never a marker: a
 * "New" on everything is the same as a "New" on nothing, and costs the person
 * the trust to believe the next one.
 */
export function newDesignSystemEntryKeys(input: {
  /** Entry key → ISO date the entry arrived. Absent or empty means no markers. */
  addedAt: Readonly<Record<string, string>> | null | undefined
  /** ISO of the last visit to THIS bundle, or null when it was never opened. */
  seenAt: string | null | undefined
  now: Date
  days?: number
}): Set<string> {
  const marked = new Set<string>()
  const addedAt = input.addedAt
  if (!addedAt) return marked

  const seenMs = parseIso(input.seenAt)
  const nowMs = input.now.getTime()
  const windowMs = (input.days ?? DESIGN_SYSTEM_NEW_FOR_DAYS) * 24 * 60 * 60 * 1000

  for (const [key, iso] of Object.entries(addedAt)) {
    const addedMs = parseIso(iso)
    if (addedMs === null) continue
    if (seenMs !== null) {
      // Strictly after: an entry stamped at exactly the moment of the last visit
      // was on screen during it.
      if (addedMs > seenMs) marked.add(key)
      continue
    }
    // Never seen: only the recent arrivals, and a future date is one of them.
    if (nowMs - addedMs < windowMs) marked.add(key)
  }
  return marked
}

function parseIso(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}
