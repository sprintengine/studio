/**
 * What a caught value says, for a log line or a message a person reads: an
 * Error's message, or else the value as a string, or `fallback` when the
 * caller would rather say something of its own than print a non-Error.
 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message
  return fallback ?? String(error)
}
