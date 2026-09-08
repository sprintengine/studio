// Coercion for third-party config values. Every function here answers "is this
// actually a string / array of strings / record of strings", and returns
// nothing when it is not — a value is never invented, and a shape a CLI's own
// config does not have is never reported as one it does.

import { asRecord } from '../../shared/records'

/** Re-exported: this module was the entry point importers already had. */
export { asRecord }

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[0].trim()))
    .map(([key, item]) => [key.trim(), item] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}
