import { createHash } from 'crypto'
import { resolve } from 'path'
import { mobileControlProtocolVersion } from '../../../../packages/mobile-control-protocol/src/index'
// Wire schema is owned by packages/mobile-control-protocol/src/index.ts. Import the
// snapshot type tree from there (aliased to this module's established local
// names) and re-export it, rather than re-declaring it and risking drift from
// the validator (validateMobileControlSnapshot) that consumes the same schema.
import type {
  MobileControlBacklogWorkspaceSnapshot,
  MobileControlCommandType,
  MobileControlSnapshot,
  MobileControlWebTargetSnapshot,
  MobileSnapshotCollection,
} from '../../../../packages/mobile-control-protocol/src/index'
import { readMobileAutomationSnapshots } from './automations'
import { readMobileBacklogWorkspaceSnapshot } from './backlog'
import { deriveWorkspaceId } from './workspace-id'
import { deepRedactLocalPaths } from './relay-path-safety'

export type { MobileControlSnapshot }

const defaultPublishThrottleMs = 1000

/**
 * The commands this desktop will actually execute.
 *
 * The Sprint Engine's removal stopped advertising the nine sprint commands while leaving them in the
 * protocol's union; protocol v3 deleted them, so this list and that union are now
 * the same five members and the `satisfies` below is what keeps them so.
 *
 * `snapshot.commands` is `string[]` on the wire by design, so a phone reads this
 * list to decide which controls to draw rather than inferring them from a version.
 */
const mobileSnapshotCommandTypes = [
  'snapshot.request',
  'device.revoke',
  'backlog.update',
  'backlog.create',
  'automations.control',
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
  // Collection scoping (item 1600). Absent = the default set below; a caller that
  // names collections gets exactly those. Scoped to the read composition, not the
  // wire — `dispatchSnapshotRequest` maps the request `include` field to this.
  include?: MobileSnapshotCollection[]
}

// The unscoped default: every collection the wire declares.
const defaultSnapshotCollections: ReadonlySet<MobileSnapshotCollection> = new Set(['backlog', 'automations'])

type MobileControlSnapshotListener = (snapshot: MobileControlSnapshot) => void

// Make an outbound snapshot relay-safe: the relay rejects any summary containing
// an absolute local path (multiauth src/relay/result-summary.ts). Round-trip
// critical workspace roots become resolvable tokens (deriveWorkspaceId);
// display-only path fields become the folder name or are dropped; any remaining
// absolute path anywhere in the payload is redacted as a defensive backstop.
// Applied only to the copy emitted to the phone — readSnapshot() keeps the real
// paths for server-side resolution.
export function sanitizeMobileSnapshotForRelay(snapshot: MobileControlSnapshot): MobileControlSnapshot {
  // `projectKey` is the phone's join key across collections: the same
  // token for the same repo root in every collection, which automations are
  // stamped with by their producer.
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
  publishThrottleMs?: number
  supportedCommands?: readonly MobileControlCommandType[]
  /**
   * Dev servers this desktop publishes on the tailnet, for the phone's web
   * screen (Track 1b). Injected rather than imported so the snapshot service
   * keeps no dependency on Tailscale, and so a test can describe a machine that
   * shares nothing without stubbing a daemon.
   */
  readWebTargets?: () => Promise<MobileControlWebTargetSnapshot[]>
}

export class MobileControlSnapshotService {
  private readonly listeners = new Set<MobileControlSnapshotListener>()
  private readonly publishThrottleMs: number
  private lastPublishedAt = 0
  private pendingRequest: MobileControlSnapshotRequest | null = null
  private publishTimer: NodeJS.Timeout | null = null
  private readonly supportedCommands: MobileControlCommandType[]
  private readonly readWebTargets: () => Promise<MobileControlWebTargetSnapshot[]>

  constructor(options: MobileControlSnapshotServiceOptions = {}) {
    this.publishThrottleMs = Math.max(0, options.publishThrottleMs ?? defaultPublishThrottleMs)
    this.supportedCommands = normalizeMobileControlCommands(options.supportedCommands ?? defaultMobileSnapshotCommands)
    this.readWebTargets = options.readWebTargets ?? (async () => [])
  }

  subscribe(listener: MobileControlSnapshotListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async readSnapshot(request: MobileControlSnapshotRequest): Promise<MobileControlSnapshot> {
    const generatedAt = request.generatedAt ?? new Date().toISOString()
    const collections = request.include ? new Set(request.include) : defaultSnapshotCollections
    const workspaceRoots = uniqueResolved(request.workspaceRoots ?? [])
    const backlog = collections.has('backlog') ? await readBacklogWorkspaceSnapshots(workspaceRoots, generatedAt) : []
    // Item 47: the automations monitor. One projection per workspace root, joined to
    // the other collections on `projectKey` (stamped by the producer, from the same
    // deriveWorkspaceId the sanitize pass stamps backlog workspaces with).
    const automations = collections.has('automations')
      ? (
          await Promise.all(
            workspaceRoots.map((workspaceRoot) => readMobileAutomationSnapshots(workspaceRoot, generatedAt)),
          )
        ).flat()
      : []
    // A share is machine state that can change without any workspace changing,
    // so it is read on every snapshot and folded into the version below —
    // otherwise the phone's If-None-Match would hold a stale web screen.
    const webTargets = await this.readWebTargets().catch(() => [] as MobileControlWebTargetSnapshot[])
    return {
      protocolVersion: mobileControlProtocolVersion,
      generatedAt,
      desktopSessionId: request.desktopSessionId,
      // Content-derived so the phone's If-None-Match (item 1599) matches on an
      // idle read. It folds NO per-read wall-clock: the top level dropped
      // `generatedAt`, and each backlog `updatedAt` — which falls back to
      // `generatedAt` for an empty workspace — is stripped before hashing.
      // Backlog and automations are folded so a backlog-only or automations-only
      // change still bumps the version.
      snapshotVersion: buildSnapshotVersion({
        backlog: backlog.map(withoutReadTimeStamp),
        automations,
        webTargets,
      }),
      commands: normalizeMobileControlCommands(request.commands ?? this.supportedCommands),
      ...(backlog.length > 0 ? { backlog } : {}),
      ...(automations.length > 0 ? { automations } : {}),
      ...(webTargets.length > 0 ? { webTargets } : {}),
    }
  }

  async publishSnapshot(request: MobileControlSnapshotRequest): Promise<MobileControlSnapshot | null> {
    const now = Date.now()
    const elapsedMs = now - this.lastPublishedAt
    if (elapsedMs >= this.publishThrottleMs) {
      this.clearPublishTimer()
      const snapshot = await this.readSnapshot(request)
      this.emit(snapshot)
      this.lastPublishedAt = Date.now()
      return snapshot
    }

    this.pendingRequest = request
    if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => {
        void this.flushPendingSnapshot()
      }, this.publishThrottleMs - elapsedMs)
    }
    return null
  }

  async flushPendingSnapshot(): Promise<MobileControlSnapshot | null> {
    const request = this.pendingRequest
    if (!request) {
      this.clearPublishTimer()
      return null
    }

    this.pendingRequest = null
    this.clearPublishTimer()
    const snapshot = await this.readSnapshot(request)
    this.emit(snapshot)
    this.lastPublishedAt = Date.now()
    return snapshot
  }

  shutdown(): void {
    this.clearPublishTimer()
    this.pendingRequest = null
    this.listeners.clear()
  }

  private emit(snapshot: MobileControlSnapshot): void {
    const safe = sanitizeMobileSnapshotForRelay(snapshot)
    for (const listener of this.listeners) {
      listener(safe)
    }
  }

  private clearPublishTimer(): void {
    if (!this.publishTimer) return
    clearTimeout(this.publishTimer)
    this.publishTimer = null
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
