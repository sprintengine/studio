import { basename, dirname, resolve } from 'path'
import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command'
import { MobileSprintEngineSnapshotService, sanitizeMobileSnapshotForRelay, type MobileControlSnapshot } from '../sprintengine/snapshot'
import { filterToDefaultSnapshotStatePaths } from '../../mobile-sprintengine-discovery'
import {
  isWorkspaceIdToken,
  resolveWorkspaceIdToRoot,
  workspaceRootFromStatePath,
} from '../sprintengine/workspace-id'
import { mobileSnapshotCollections, type MobileSnapshotCollection } from '../../../../packages/mobile-control-protocol/src/index'
import {
  acceptedBridgeCommand,
  relayResultSummaryMaxBytes,
  relaySummaryByteLength,
  summarizeCommandResult,
} from './command-results'

const relaySnapshotResultTargetBytes = relayResultSummaryMaxBytes - 8 * 1024

export async function dispatchSnapshotRequest(input: {
  command: MobileControlCommand
  snapshotService: MobileSprintEngineSnapshotService
  desktopSessionId: string
  statePathsProvider: () => Promise<string[]>
  workspaceRootsProvider?: () => Promise<string[]>
}): Promise<MobileSprintEngineCommandResult> {
  const { command, snapshotService, desktopSessionId, statePathsProvider, workspaceRootsProvider } = input
  const payload = command.type === 'snapshot.request' ? command.payload : undefined
  const requestedSprintEngineId = typeof payload?.sprintEngineId === 'string' ? payload.sprintEngineId : null
  const requestedWorkspacePath = typeof payload?.workspacePath === 'string' ? payload.workspacePath : null
  const knownSnapshotVersion = typeof payload?.knownSnapshotVersion === 'string' ? payload.knownSnapshotVersion : null
  const include = readIncludeCollections(payload?.include)

  const [allStatePaths, allWorkspaceRoots] = await Promise.all([
    statePathsProvider(),
    workspaceRootsProvider ? workspaceRootsProvider() : Promise.resolve<string[]>([]),
  ])

  const scope = await resolveSnapshotScope({
    requestedSprintEngineId,
    requestedWorkspacePath,
    allStatePaths,
    allWorkspaceRoots,
  })

  // readSnapshot() returns the internal snapshot with real local paths; the
  // on-demand command-result path (workspace open / backlog refresh) does not go
  // through the publish emit() chokepoint, so sanitize here too or the relay
  // rejects the result for carrying local paths.
  const snapshot = sanitizeMobileSnapshotForRelay(await snapshotService.readSnapshot({
    desktopSessionId,
    statePaths: scope.statePaths,
    workspaceRoots: scope.workspaceRoots,
    ...(include ? { include } : {}),
  }))

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
  statePaths: string[]
  workspaceRoots: string[]
  // Whether the request named a scope (sprintEngineId or workspacePath). A scoped
  // request skips the size-shedding ladder and the unscoped terminal-run filter —
  // the phone gets exactly the scope it named, finished runs included.
  scoped: boolean
}

// Map a request's scope fields to the state paths and workspace roots readSnapshot
// composes from. Item 1600: `workspacePath` narrows to one project root, an
// unscoped request sheds terminal runs beyond the recent-N keep-window, and a
// `sprintEngineId` request keeps its established shape (narrows the engine set only).
async function resolveSnapshotScope(input: {
  requestedSprintEngineId: string | null
  requestedWorkspacePath: string | null
  allStatePaths: string[]
  allWorkspaceRoots: string[]
}): Promise<SnapshotScope> {
  const { requestedSprintEngineId, requestedWorkspacePath, allStatePaths, allWorkspaceRoots } = input

  if (requestedWorkspacePath) {
    // The phone holds a relay-safe token (projectKey), never the absolute root, so
    // resolve it against the roots we know before scoping engines/backlog/automations.
    const candidateRoots = uniqueResolvedRoots([...allStatePaths.map(workspaceRootFromStatePath), ...allWorkspaceRoots])
    const matchedRoot = resolveScopedRoot(requestedWorkspacePath, candidateRoots)
    // Unknown workspace: fail closed with an empty-but-valid scope rather than
    // falling back to the whole fleet.
    if (!matchedRoot) {
      return { statePaths: [], workspaceRoots: [], scoped: true }
    }
    return {
      statePaths: allStatePaths.filter((statePath) => workspaceRootFromStatePath(statePath) === matchedRoot),
      workspaceRoots: [matchedRoot],
      scoped: true,
    }
  }

  if (requestedSprintEngineId) {
    return {
      statePaths: allStatePaths.filter((statePath) => basename(dirname(statePath)) === requestedSprintEngineId),
      workspaceRoots: allWorkspaceRoots,
      scoped: true,
    }
  }

  return {
    statePaths: await filterToDefaultSnapshotStatePaths(allStatePaths),
    workspaceRoots: allWorkspaceRoots,
    scoped: false,
  }
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
    (mobileSnapshotCollections as readonly string[]).includes(entry as string)
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

  // Shed the role catalogs first (MC-1543). They are duplicated per backlog
  // workspace and are an enhancement — losing them costs the phone a
  // registry-accurate launch picker (it falls back to its bundled list), whereas
  // losing a sprint engine costs it a run it can no longer see or drive. Cheapest
  // thing in the payload, so it goes before anything load-bearing.
  const shed = withoutRoleCatalogs(snapshot)
  if (snapshotFitsRelayResult(command, shed)) {
    return shed
  }

  // Then the automations' recent-run history (item 47). The producer caps it (24
  // automations per project, 5 runs each, 160-char run text) but the caps bound a
  // PROJECT, not a snapshot: at full cap a single project measures ~27% of the
  // budget, so four workspace roots crowd the snapshot out on automations alone.
  // Run text is ~90% of those bytes, so dropping it is what buys the room back.
  // It goes above the sprint engines for the same reason the role catalogs do:
  // losing run history costs the phone some monitor detail on automations it can
  // still see, whereas losing a sprint engine costs it a run it can no longer see
  // or drive. `recentRuns` is optional on the wire, so shedding it is omitting it.
  const withoutRuns = withoutAutomationRecentRuns(shed)
  if (snapshotFitsRelayResult(command, withoutRuns)) {
    return withoutRuns
  }

  for (let includedCount = withoutRuns.sprintEngines.length - 1; includedCount >= 0; includedCount -= 1) {
    const candidate = limitSprintEngines(withoutRuns, includedCount)
    if (snapshotFitsRelayResult(command, candidate)) {
      return candidate
    }
  }

  return withoutRuns
}

function withoutRoleCatalogs(snapshot: MobileControlSnapshot): MobileControlSnapshot {
  if (!snapshot.backlog?.some((workspace) => workspace.roles !== undefined)) {
    return snapshot
  }
  return {
    ...snapshot,
    backlog: snapshot.backlog.map(({ roles: _roles, ...workspace }) => workspace),
  }
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

function limitSprintEngines(snapshot: MobileControlSnapshot, includedCount: number): MobileControlSnapshot {
  const sprintEngines = snapshot.sprintEngines.slice(0, includedCount)
  const includedIds = new Set(sprintEngines.map((sprintEngine) => sprintEngine.sprintEngineId))
  return {
    ...snapshot,
    sprintEngines,
    workspaces: snapshot.workspaces?.filter((workspace) =>
      workspace.kind !== 'sprintengine' || includedIds.has(workspace.workspaceId)
    ),
    snapshotLimits: {
      ...(snapshot.snapshotLimits ?? {}),
      sprintEngines: {
        included: sprintEngines.length,
        omitted: Math.max(0, snapshot.sprintEngines.length - sprintEngines.length),
        total: snapshot.sprintEngines.length,
        reason: 'relay_result_summary_size',
      },
    },
  }
}
