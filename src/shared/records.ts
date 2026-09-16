/**
 * The one record predicate, for main, preload, the renderer and shared.
 *
 * A record here is a plain object with string keys — what `JSON.parse` yields
 * for `{…}`, and the only shape a `value.field` read can safely narrow to.
 * Arrays are deliberately NOT records: `typeof [] === 'object'`, so a predicate
 * that lets them through hands the caller a `Record` whose keys are indices.
 *
 * Fifty-odd byte-identical copies of this lived across the tree under three
 * names (`isRecord`, `isObject`, `asRecord`) and two spellings of one condition
 * (`Boolean(value) && typeof value === 'object'` vs `typeof value === 'object'
 * && value !== null`). They all agreed; this is what they collapsed to. One
 * predicate did NOT agree and kept its own definition:
 * `skills/plugin-install-store.ts` (a record of a specific shape).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** {@link isRecord} as a cast: the record, or null when the value is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}
