import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
// Mobile snapshots must never carry absolute local filesystem paths: the relay
// rejects any command-result summary that contains one (see multiauth
// src/relay/result-summary.ts -> containsLocalPath). We therefore hand the phone
// a relay-safe opaque token in place of a workspace root, and resolve it back to
// the real root server-side when a command (sprintengine.create, backlog.create
// / .update / .startSprintEngine) round-trips it. The token is a one-way hash so
// the absolute path itself never leaves the desktop.
const WORKSPACE_ID_PREFIX = 'ws_';
export function deriveWorkspaceId(workspaceRoot) {
    const normalized = resolve(workspaceRoot);
    return WORKSPACE_ID_PREFIX + createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}
export function isWorkspaceIdToken(value) {
    return value.startsWith(WORKSPACE_ID_PREFIX);
}
// Reverse a workspace token to its absolute root by matching it against the known
// candidate roots. Returns null when nothing matches (fail closed: the caller
// surfaces path_not_allowed rather than guessing a root).
export function resolveWorkspaceIdToRoot(workspaceId, candidateRoots) {
    for (const root of candidateRoots) {
        if (deriveWorkspaceId(root) === workspaceId) {
            return resolve(root);
        }
    }
    return null;
}
// Derive a workspace root from a Sprint Engine run.yaml state path, mirroring the
// layout `<root>/.multi-code/sprintengine/<team>/run.yaml`. Used to widen the
// candidate set for token resolution so workspaces that live under a configured
// parent root still resolve.
export function workspaceRootFromStatePath(statePath) {
    // run.yaml -> <team> -> sprintengine -> .multi-code -> <root>
    return dirname(dirname(dirname(dirname(resolve(statePath)))));
}
