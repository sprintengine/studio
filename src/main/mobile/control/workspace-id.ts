import { createHash } from 'crypto'
import { resolve } from 'path'

// Mobile snapshots must never carry absolute local filesystem paths: the relay
// rejects any command-result summary that contains one (see multiauth
// src/relay/result-summary.ts -> containsLocalPath). We therefore hand the phone
// a relay-safe opaque token in place of a workspace root, and resolve it back to
// the real root server-side when a command (backlog.create / .update,
// automations.control) round-trips it. The token is a one-way hash so the
// absolute path itself never leaves the desktop.

const WORKSPACE_ID_PREFIX = 'ws_'

export function deriveWorkspaceId(workspaceRoot: string): string {
  const normalized = resolve(workspaceRoot)
  return WORKSPACE_ID_PREFIX + createHash('sha256').update(normalized).digest('hex').slice(0, 24)
}

export function isWorkspaceIdToken(value: string): boolean {
  return value.startsWith(WORKSPACE_ID_PREFIX)
}

// Reverse a workspace token to its absolute root by matching it against the known
// candidate roots. Returns null when nothing matches (fail closed: the caller
// surfaces path_not_allowed rather than guessing a root).
export function resolveWorkspaceIdToRoot(workspaceId: string, candidateRoots: readonly string[]): string | null {
  for (const root of candidateRoots) {
    if (deriveWorkspaceId(root) === workspaceId) {
      return resolve(root)
    }
  }
  return null
}
