import { resolve } from 'path'
import type { MobileControlCommand, MobileControlCommandResult } from '../control/command'
import {
  MobileControlSnapshotService,
  sanitizeMobileSnapshotForRelay,
  type MobileControlSnapshot,
} from '../control/snapshot'
import { isWorkspaceIdToken, resolveWorkspaceIdToRoot } from '../control/workspace-id'
import {
  mobileSnapshotCollections,
  type MobileSnapshotCollection,
} from '../../../../packages/mobile-control-protocol/src/index'
import {
  acceptedBridgeCommand,
  relayResultSummaryMaxBytes,
  relaySummaryByteLength,
  summarizeCommandResult,
} from './command-results'

const relaySnapshotResultTargetBytes = relayResultSummaryMaxBytes - 8 * 1024

export async function dispatchSnapshotRequest(input: {
  command: MobileControlCommand
  snapshotService: MobileControlSnapshotService
  desktopSessionId: string
  workspaceRootsProvider?: () => Promise<string[]>
}): Promise<MobileControlCommandResult> {
  const { command, snapshotService, desktopSessionId, workspaceRootsProvider } = input
  const payload = command.type === 'snapshot.request' ? command.payload : undefined
  const requestedWorkspacePath = typeof payload?.workspacePath === 'string' ? payload.workspacePath : null
  const knownSnapshotVersion = typeof payload?.knownSnapshotVersion === 'string' ? payload.knownSnapshotVersion : null
  const include = readIncludeCollections(payload?.include)

  // A `sprintEngineId` scope is read and ignored: the collection it narrowed is
  // always empty now, so honouring it would return the same snapshot
  // as refusing it, and refusing it would fail a request the phone is entitled
  // to make.
  const allWorkspaceRoots = workspaceRootsProvider ? await workspaceRootsProvider() : []
  const scope = resolveSnapshotScope({ requestedWorkspacePath, allWorkspaceRoots })

  // readSnapshot() returns the internal snapshot with real local paths; the
  // on-demand command-result path (workspace open / backlog refresh) does not go
  // through the publish emit() chokepoint, so sanitize here too or the relay
  // rejects the result for carrying local paths.
  const snapshot = sanitizeMobileSnapshotForRelay(
    await snapshotService.readSnapshot({
      desktopSessionId,
      workspaceRoots: scope.workspaceRoots,
      ...(include ? { include } : {}),
    }),
  )

  // If-None-Match on the read path (item 1599). Building to compare is cheap —
  // the cost we shed is the up-to-256 KB ledger write and transfer, not the
  // local assembly. When the client already holds this exact version, answer
  // with a tiny change-token result. It carries only the boolean and the hash
  // token — no content-bearing keys — so it stays inside the relay
  // result-summary rules. An absent or stale version falls through to the full
  // snapshot exactly as before, so old clients are unaffected.
  if (knownSnapshotVersion && knownSnapshotVersion === snapshot.snapshotVersion) {
    return acceptedBridgeCommand(command, { unchanged: true, snapshotVersion: snapshot.snapshotVersion })
  }

  return acceptedBridgeCommand(command, relaySizedSnapshot(command, snapshot, scope.scoped))
}

type SnapshotScope = {
  workspaceRoots: string[]
  // Whether the request named a workspace. A scoped request skips the
  // size-shedding ladder — the phone gets exactly the scope it named.
  scoped: boolean
}

// Map a request's scope fields to the workspace roots readSnapshot composes from
// (item 1600): `workspacePath` narrows to one project root, an unscoped request
// serves every root this desktop knows.
function resolveSnapshotScope(input: {
  requestedWorkspacePath: string | null
  allWorkspaceRoots: string[]
}): SnapshotScope {
  const { requestedWorkspacePath, allWorkspaceRoots } = input

  if (requestedWorkspacePath) {
    // The phone holds a relay-safe token (projectKey), never the absolute root, so
    // resolve it against the roots we know before scoping backlog/automations.
    const candidateRoots = uniqueResolvedRoots(allWorkspaceRoots)
    const matchedRoot = resolveScopedRoot(requestedWorkspacePath, candidateRoots)
    // Unknown workspace: fail closed with an empty-but-valid scope rather than
    // falling back to the whole fleet.
    if (!matchedRoot) {
      return { workspaceRoots: [], scoped: true }
    }
    return { workspaceRoots: [matchedRoot], scoped: true }
  }

  return { workspaceRoots: allWorkspaceRoots, scoped: false }
}

function resolveScopedRoot(requested: string, candidateRoots: string[]): string | null {
  if (isWorkspaceIdToken(requested)) {
    return resolveWorkspaceIdToRoot(requested, candidateRoots)
  }
  // A raw absolute root (desktop-internal callers/tests): honor it only when it is
  // one we actually serve, so an unknown path cannot widen the scope.
  const target = resolve(requested)
  return candidateRoots.includes(target) ? target : null
}

function uniqueResolvedRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))]
}

function readIncludeCollections(value: unknown): MobileSnapshotCollection[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const collections = value.filter((entry): entry is MobileSnapshotCollection =>
    (mobileSnapshotCollections as readonly string[]).includes(entry as string),
  )
  // Empty (unspecified or all-invalid) → default composition, never an empty snapshot.
  return collections.length > 0 ? collections : undefined
}

function relaySizedSnapshot(
  command: MobileControlCommand,
  snapshot: MobileControlSnapshot,
  scopedRequest: boolean,
): MobileControlSnapshot {
  if (snapshotFitsRelayResult(command, snapshot) || scopedRequest) {
    return snapshot
  }

  // The automations' recent-run history (item 47) is what the ladder sheds. The
  // producer caps it (24 automations per project, 5 runs each, 160-char run text)
  // but the caps bound a PROJECT, not a snapshot: at full cap a single project
  // measures ~27% of the budget, so four workspace roots crowd the snapshot out
  // on automations alone. Run text is ~90% of those bytes, so dropping it is what
  // buys the room back, and losing run history costs the phone some monitor
  // detail on automations it can still see. `recentRuns` is optional on the wire,
  // so shedding it is omitting it.
  //
  // The two rungs above this one are gone with the Sprint Engine: there
  // are no role catalogues to shed and no runs to cap. A snapshot that is still
  // over budget after this is returned as it stands — the bridge's own size gate
  // turns it into a `snapshot_too_large` refusal rather than a truncated success.
  return withoutAutomationRecentRuns(snapshot)
}

function withoutAutomationRecentRuns(snapshot: MobileControlSnapshot): MobileControlSnapshot {
  if (!snapshot.automations?.some((automation) => automation.recentRuns !== undefined)) {
    return snapshot
  }
  return {
    ...snapshot,
    automations: snapshot.automations.map(({ recentRuns: _recentRuns, ...automation }) => automation),
  }
}

function snapshotFitsRelayResult(command: MobileControlCommand, snapshot: MobileControlSnapshot): boolean {
  if (relaySummaryByteLength(snapshot) > relaySnapshotResultTargetBytes) {
    return false
  }
  const result = acceptedBridgeCommand(command, snapshot)
  return relaySummaryByteLength(summarizeCommandResult(result)) <= relaySnapshotResultTargetBytes
}
