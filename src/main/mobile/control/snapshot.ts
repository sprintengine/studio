import { createHash } from 'crypto'
import { resolve } from 'path'
import { mobileControlProtocolVersion } from './protocol'
// The wire schema is owned by ./protocol. Import the snapshot type tree from
// there and re-export it, rather than re-declaring it and risking drift from
// the validator (validateMobileControlSnapshot) that consumes the same schema.
import type {
  MobileControlBacklogWorkspaceSnapshot,
  MobileControlCommandType,
  MobileControlSnapshot,
  MobileControlWebTargetSnapshot,
  MobileSnapshotCollection,
} from './protocol'
import { readMobileBacklogWorkspaceSnapshot } from './backlog'
import { deriveWorkspaceId } from './workspace-id'
import { deepRedactLocalPaths } from './path-safety'

export type { MobileControlSnapshot }

/**
 * Every command the command service knows, advertised when a caller names no
 * narrower set. A transport that serves fewer — the tailnet gateway serves
 * `snapshot.request` and `backlog.update` — passes its own list, so the phone
 * draws only the controls that will work over it.
 *
 * `snapshot.commands` is `string[]` on the wire by design, so a phone reads this
 * list to decide which controls to draw rather than inferring them from a version.
 */
const mobileSnapshotCommandTypes = [
  'snapshot.request',
  'backlog.update',
  'backlog.create',
] as const satisfies readonly MobileControlCommandType[]

// The advertised set is a SUBSET of the command union — a command the desktop cannot
// execute yet must not be advertised — so membership is tested against the wide union
// rather than the narrow tuple's own element type.
const mobileSnapshotCommandSet = new Set<MobileControlCommandType>(mobileSnapshotCommandTypes)

export const defaultMobileSnapshotCommands: readonly MobileControlCommandType[] = mobileSnapshotCommandTypes

export type MobileControlSnapshotRequest = {
  desktopSessionId: string
  workspaceRoots?: string[]
  commands?: MobileControlCommandType[]
  generatedAt?: string
  // Collection scoping. Absent = the default set below; a caller that names
  // collections gets exactly those. `workspace.snapshot` maps its `include`
  // argument to this.
  include?: MobileSnapshotCollection[]
}

// The unscoped default: every collection the wire declares.
const defaultSnapshotCollections: ReadonlySet<MobileSnapshotCollection> = new Set(['backlog'])

// Make an outbound snapshot safe to hand another device: no absolute local path
// leaves the desktop (see path-safety.ts). Round-trip critical workspace roots
// become resolvable tokens (deriveWorkspaceId);
// display-only path fields become the folder name or are dropped; any remaining
// absolute path anywhere in the payload is redacted as a defensive backstop.
// Applied only to the copy emitted to the phone — readSnapshot() keeps the real
// paths for server-side resolution.
export function sanitizeMobileSnapshotForTransport(snapshot: MobileControlSnapshot): MobileControlSnapshot {
  // `projectKey` is the phone's key for a repo: the same token for the same
  // repo root on every read.
  const backlog = snapshot.backlog?.map((workspace) => {
    const token = deriveWorkspaceId(workspace.workspacePath)
    return {
      ...workspace,
      // Round-trips back for backlog.create/.update, so it has to be a resolvable
      // token rather than a display string. The phone shows workspaceName, not
      // this field.
      workspaceId: `backlog:${token}`,
      workspacePath: token,
      projectKey: token,
    }
  })

  return deepRedactLocalPaths({
    ...snapshot,
    ...(backlog ? { backlog } : {}),
  })
}

type MobileControlSnapshotServiceOptions = {
  supportedCommands?: readonly MobileControlCommandType[]
  /**
   * Dev servers this desktop publishes on the tailnet, for the phone's web
   * screen (Track 1b). Injected rather than imported so the snapshot service
   * keeps no dependency on Tailscale, and so a test can describe a machine that
   * shares nothing without stubbing a daemon.
   */
  readWebTargets?: () => Promise<MobileControlWebTargetSnapshot[]>
  /**
   * How long one read of the published dev servers answers for. Reading them
   * runs two `tailscale` processes, and a phone polling the snapshot would
   * otherwise pay for both on every poll. Injected in tests.
   */
  webTargetsMaxAgeMs?: number
  now?: () => number
}

/** A share started or stopped on this desktop reaches the phone's web screen within this. */
const DEFAULT_WEB_TARGETS_MAX_AGE_MS = 20_000

export class MobileControlSnapshotService {
  private readonly supportedCommands: MobileControlCommandType[]
  private readonly readWebTargetsNow: () => Promise<MobileControlWebTargetSnapshot[]>
  private readonly webTargetsMaxAgeMs: number
  private readonly now: () => number
  /** The last read of the web targets, shared by every snapshot inside its age. Holds no timer. */
  private webTargets: { read: Promise<MobileControlWebTargetSnapshot[]>; at: number } | null = null

  constructor(options: MobileControlSnapshotServiceOptions = {}) {
    this.supportedCommands = normalizeMobileControlCommands(options.supportedCommands ?? defaultMobileSnapshotCommands)
    this.readWebTargetsNow = options.readWebTargets ?? (async () => [])
    this.webTargetsMaxAgeMs = Math.max(0, options.webTargetsMaxAgeMs ?? DEFAULT_WEB_TARGETS_MAX_AGE_MS)
    this.now = options.now ?? Date.now
  }

  private readWebTargets(): Promise<MobileControlWebTargetSnapshot[]> {
    const at = this.now()
    if (this.webTargets && at - this.webTargets.at < this.webTargetsMaxAgeMs) return this.webTargets.read
    const read = this.readWebTargetsNow().catch(() => [] as MobileControlWebTargetSnapshot[])
    this.webTargets = { read, at }
    return read
  }

  async readSnapshot(request: MobileControlSnapshotRequest): Promise<MobileControlSnapshot> {
    const generatedAt = request.generatedAt ?? new Date().toISOString()
    const collections = request.include ? new Set(request.include) : defaultSnapshotCollections
    const workspaceRoots = uniqueResolved(request.workspaceRoots ?? [])
    const backlog = collections.has('backlog') ? await readBacklogWorkspaceSnapshots(workspaceRoots, generatedAt) : []
    // A share is machine state that can change without any workspace changing,
    // so it is folded into the version below — otherwise the phone's
    // If-None-Match would hold a stale web screen. It is read at most once
    // per `webTargetsMaxAgeMs`, however often the phone asks.
    const webTargets = await this.readWebTargets()
    return {
      protocolVersion: mobileControlProtocolVersion,
      generatedAt,
      desktopSessionId: request.desktopSessionId,
      // Content-derived so the phone's `knownSnapshotVersion` matches on an
      // idle read. It folds NO per-read wall-clock: the top level dropped
      // `generatedAt`, and each backlog `updatedAt` — which falls back to
      // `generatedAt` for an empty workspace — is stripped before hashing.
      // Backlog and web targets are folded so a change to either alone still
      // bumps the version.
      snapshotVersion: buildSnapshotVersion({
        backlog: backlog.map(withoutReadTimeStamp),
        webTargets,
      }),
      commands: normalizeMobileControlCommands(request.commands ?? this.supportedCommands),
      ...(backlog.length > 0 ? { backlog } : {}),
      ...(webTargets.length > 0 ? { webTargets } : {}),
    }
  }
}

async function readBacklogWorkspaceSnapshots(
  workspaceRoots: string[],
  generatedAt: string,
): Promise<MobileControlBacklogWorkspaceSnapshot[]> {
  const settled = await Promise.allSettled(
    workspaceRoots.map((workspaceRoot) => readMobileBacklogWorkspaceSnapshot(workspaceRoot, generatedAt)),
  )
  return settled
    .flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
    .sort((left, right) => left.workspaceName.localeCompare(right.workspaceName))
}

function normalizeMobileControlCommands(commands: readonly MobileControlCommandType[]): MobileControlCommandType[] {
  const supported = new Set<MobileControlCommandType>()
  for (const command of commands) {
    if (mobileSnapshotCommandSet.has(command)) {
      supported.add(command)
    }
  }
  return [...supported]
}

function buildSnapshotVersion(value: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
  return `snap_${digest}`
}

// Strips the read-time `updatedAt` before a backlog snapshot feeds
// the top-level snapshotVersion. That field falls back to `generatedAt` when the
// snapshot has no content timestamp of its own, so folding it verbatim would put
// per-read wall-clock back into the hash and stop the item-1599 fast path from
// ever matching. The content that survives is exactly what a real change perturbs.
function withoutReadTimeStamp<T extends { updatedAt: string }>(value: T): Omit<T, 'updatedAt'> {
  const { updatedAt: _updatedAt, ...rest } = value
  return rest
}

function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim()).map((path) => resolve(path)))]
}
