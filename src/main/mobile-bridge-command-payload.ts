export function stringPayload(payload: unknown, field: string): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Command payload must be an object.')
  }
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`)
  }
  return value
}
