// Shared sanitation rule for messages produced while resolving, serving, or
// evaluating third-party entry bundles. Anything that may reach the renderer
// (launch views, renderer-entry load states) must not leak absolute filesystem
// paths; both the main-side server (entry-containment.ts) and the renderer-side
// loader (third-party-loader.ts) apply the same rule so no process becomes the
// weak link.

export function sanitizeEntryMessage(message: string, fallback: string): string {
  if (containsAbsolutePath(message)) return fallback
  return message
}

function containsAbsolutePath(message: string): boolean {
  return /(^|[\s'"])(?:\/[\w.-][^\s'"]*|[A-Za-z]:\\[^\s'"]+)/.test(message)
}
