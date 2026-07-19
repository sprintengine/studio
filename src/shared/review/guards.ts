// Small shared validation primitives for the review contracts. Hand-rolled to
// match the repo convention (src/shared/plugin-manifest.ts, switchboard.ts) — no
// zod / json-schema. Node-free: this module and everything under
// src/shared/review/ must never import from src/main/ or Electron.
//
// Every review validator returns { ok: true; value } | { ok: false; errors:
// string[] } with path-qualified error strings, and is tolerant of unknown keys
// (forward compat) — the predicates below only ever check keys they know.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

export function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string'
    && ISO_TIMESTAMP.test(value)
    && !Number.isNaN(Date.parse(value))
  )
}

// A short, safe rendering of an offending value for error messages — enough to
// name the value the caller sent without dumping a whole nested object.
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return typeof value
}

// Rejects unknown enum values, naming the offending value — the review contracts
// never silently pass an unrecognized kind/status/provider (incl. any attempt to
// smuggle a severity-like kind into an explanation-only field).
export function checkEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[]
): value is T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return true
  errors.push(`${path} has unknown value ${describeValue(value)}; expected one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}.`)
  return false
}

// Optional string field: absent is fine, present must be a string.
export function checkOptionalString(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined && typeof value !== 'string') {
    errors.push(`${path} must be a string when present.`)
  }
}

// A required, non-empty, length-capped string (hoverTip, files[].why, change-map
// labels). Names which bound was violated so the author can see whether it was
// empty or too long.
export function checkBoundedString(
  value: unknown,
  maxLength: number,
  path: string,
  errors: string[]
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string.`)
    return
  }
  if (value.length > maxLength) {
    errors.push(`${path} must be ${maxLength} characters or fewer; got ${value.length}.`)
  }
}

export function checkStringArray(value: unknown, path: string, errors: string[]): value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    errors.push(`${path} must be a string array.`)
    return false
  }
  return true
}
