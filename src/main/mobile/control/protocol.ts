// The mobile-control wire: what the companion phone reads from this desktop and
// the commands it may send back.
//
// The phone reaches it only over the tailnet gateway — `workspace.snapshot`
// returns a `MobileControlSnapshot`, and `workspace.mobile_command` takes the
// fields of a `MobileControlCommand` — so these shapes cross to software this
// repository does not ship. A change here is a compatibility decision, not a
// local edit: `docs/compatibility.md` is the policy.
//
// The phone app keeps its own copy of these types. Nothing compares the two
// automatically, so an edit that changes what crosses the wire has to be made
// on the phone's side as well.

import { isRecord } from '../../../shared/records'

export const mobileControlProtocolVersion = 4 as const

/**
 * Every protocol version this desktop still accepts from a phone, oldest first.
 *
 * The desktop and the phone are two separately installed apps, and the phone's
 * update goes through a store review this repository does not control. Exact
 * equality meant the hour between shipping a desktop bump and the phone's build
 * clearing review was an hour in which every paired phone was refused outright,
 * with `unsupported_protocol_version` and no way for its owner to act on it.
 *
 * One version of slack is the smallest window that survives that, and the
 * largest that does not ask this code to remember two wire shapes indefinitely.
 *
 * Outbound traffic is unaffected: this desktop always STAMPS
 * `mobileControlProtocolVersion`. The window governs only what it will read.
 */
export const mobileControlSupportedProtocolVersions = [3, 4] as const

export type MobileControlProtocolVersion = (typeof mobileControlSupportedProtocolVersions)[number]

/**
 * The window has to END at the version this build speaks, or the desktop would
 * be advertising a version it does not itself accept back. A compile error here
 * means a bump changed `mobileControlProtocolVersion` and left the window behind.
 */
type _AssertWindowEndsAtCurrent = typeof mobileControlSupportedProtocolVersions extends readonly [
  ...unknown[],
  typeof mobileControlProtocolVersion,
]
  ? true
  : ['mobileControlSupportedProtocolVersions must end at mobileControlProtocolVersion']
const _windowEndsAtCurrent: _AssertWindowEndsAtCurrent = true
void _windowEndsAtCurrent

/** The oldest phone this desktop will still talk to. */
export const mobileControlMinSupportedProtocolVersion = mobileControlSupportedProtocolVersions[0]

export function isSupportedMobileControlProtocolVersion(value: unknown): value is MobileControlProtocolVersion {
  return (mobileControlSupportedProtocolVersions as readonly unknown[]).includes(value)
}

/**
 * Why a payload was refused, naming both the version seen and the window.
 *
 * Both, because either alone is undiagnosable: the phone's owner cannot act on
 * "unsupported version" without knowing which side is behind.
 */
export function unsupportedMobileControlProtocolVersion(
  seen: unknown,
  accepts: 'window' | 'current' = 'window',
): string {
  // What the READER accepts, which is not always the window — a payload the
  // desktop sends is read at the current version only. Collapses to a single
  // number once the window narrows to one.
  const speaks =
    accepts === 'current'
      ? String(mobileControlProtocolVersion)
      : [...new Set<number>([mobileControlMinSupportedProtocolVersion, mobileControlProtocolVersion])].join('-')
  const saw = typeof seen === 'number' ? String(seen) : 'no readable version'
  return `mobile-control protocol version ${saw} is not supported; this build speaks ${speaks}`
}

export type MobileControlCommandType = 'snapshot.request' | 'backlog.update' | 'backlog.create'

/**
 * The error codes this desktop emits. The phone validates the code against its
 * own closed list, so a new code here is a wire change: an already-paired phone
 * would fail to parse the rejection it should have shown.
 */
export type MobileControlErrorCode =
  | 'unsupported_protocol_version'
  | 'invalid_payload'
  | 'command_not_supported'
  | 'command_expired'
  | 'duplicate_idempotency_key'
  | 'stale_snapshot'
  | 'path_not_allowed'
  | 'internal_error'

export interface MobileControlError {
  protocolVersion: MobileControlProtocolVersion
  code: MobileControlErrorCode
  message: string
  retryable: boolean
  correlationId?: string
  detail?: Record<string, string | number | boolean | null>
}

export interface MobileControlCommandBase<Type extends MobileControlCommandType, Payload> {
  protocolVersion: MobileControlProtocolVersion
  commandId: string
  type: Type
  issuedAt: string
  deviceId: string
  idempotencyKey?: string
  expectedSnapshotVersion?: string
  payload: Payload
}

/** Snapshot collections a read may scope down to. Every one ships by default. */
export const mobileSnapshotCollections = ['backlog'] as const
export type MobileSnapshotCollection = (typeof mobileSnapshotCollections)[number]

/**
 * Collection names this wire no longer serves, still accepted in a read's
 * `include` and answered with nothing.
 *
 * Automations left the phone on 2026-09-29 (owner ruling), without a version
 * bump (docs/compatibility.md). Phones built before that ask for
 * `['backlog', 'automations']` on every read; refusing the retired name would
 * fail every one of those reads, which is exactly the break a bump exists to
 * announce. Accepting it and sending no `automations` member is a snapshot
 * those phones already read: the member was optional, and absent whenever a
 * desktop had no automations to show.
 */
export const retiredMobileSnapshotCollections = ['automations'] as const

export type SnapshotRequestCommand = MobileControlCommandBase<
  'snapshot.request',
  {
    /**
     * The `snapshotVersion` the client already holds; a matching read answers
     * `{ unchanged: true }` instead of the document. Skip-on-match, the opposite
     * of the base `expectedSnapshotVersion` (a reject-on-mismatch mutation
     * guard) — do not fold the two together.
     */
    knownSnapshotVersion?: string
    /** One project root, as the workspace token the phone holds as `projectKey`. */
    workspacePath?: string
    /** Restrict the payload to these collections. Absent means every collection. */
    include?: MobileSnapshotCollection[]
  }
>

export type BacklogUpdateCommand = MobileControlCommandBase<
  'backlog.update',
  {
    workspacePath: string
    relativePath: string
    status?: MobileControlBacklogItemStatus
    type?: MobileControlBacklogItemType
    difficulty?: MobileControlBacklogItemDifficulty
    criticality?: MobileControlBacklogItemCriticality
  }
>

export type BacklogCreateCommand = MobileControlCommandBase<
  'backlog.create',
  {
    workspacePath: string
    title: string
    description?: string
    type?: MobileControlBacklogItemType
    difficulty?: MobileControlBacklogItemDifficulty
    criticality?: MobileControlBacklogItemCriticality
  }
>

export type MobileControlCommand = SnapshotRequestCommand | BacklogUpdateCommand | BacklogCreateCommand

export type MobileControlBacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
export type MobileControlBacklogItemType = 'epic' | 'feature' | 'bug' | 'mockup' | 'spike'
export type MobileControlBacklogItemDifficulty = 'xs' | 's' | 'm' | 'l' | 'xl'
export type MobileControlBacklogItemCriticality = 'low' | 'normal' | 'high' | 'critical'

export interface MobileControlBacklogItemSnapshot {
  itemId: string
  relativePath: string
  title: string
  excerpt?: string
  status: MobileControlBacklogItemStatus
  type?: MobileControlBacklogItemType
  difficulty?: MobileControlBacklogItemDifficulty
  criticality?: MobileControlBacklogItemCriticality
  // The up-pointing epic slug (frontmatter `epic:`) when this item belongs to an
  // epic; absent otherwise. The epic -> children direction stays a derived query.
  epic?: string
  updatedAt?: string
}

// Per-workspace epic metadata. Items carry only the `epic` up-slug; the phone
// renders epic chips and colour bands, which need the epic's display id and
// colour. Kept as a per-workspace block rather than denormalized onto every item.
export interface MobileControlBacklogEpicSnapshot {
  /** The epic slug (matches an item's `epic` up-slug). */
  slug: string
  /** The epic's display id, when the epic file carries an `id`. */
  displayId?: string
  title?: string
  /** One of the desktop seven-colour highlight set, when the epic sets `color`. */
  color?: string
  /** Rollup over the epic's member items. */
  doneCount: number
  totalCount: number
}

export interface MobileControlBacklogWorkspaceSnapshot {
  workspaceId: string
  workspacePath: string
  /** The repo this backlog group belongs to, as a workspace token. */
  projectKey?: string
  workspaceName: string
  updatedAt: string
  items: MobileControlBacklogItemSnapshot[]
  epics?: MobileControlBacklogEpicSnapshot[]
}

/**
 * A web page on this desktop that a phone can actually open.
 *
 * The pane's browser tab is not one of these: it holds a `localhost` URL, and
 * localhost on a phone is the phone. What a phone can open is a dev server the
 * desktop has published on the tailnet (`tailscale serve`), which is a real
 * HTTPS origin reachable from any device on the tailnet.
 *
 * Additive and optional, so a phone that predates it simply does not draw the
 * screen.
 */
export interface MobileControlWebTargetSnapshot {
  /** Stable within a desktop session: the HTTPS port publishing it. */
  id: string
  /** What a person recognises — the local port and the process serving it. */
  label: string
  /** `https://<node>.<tailnet>.ts.net[:port]/` — opened as-is, never rewritten. */
  url: string
  /** The loopback port on the desktop, for the label and for matching. */
  localPort: number
  /** The desktop publishing it, by MagicDNS name. */
  machine: string
}

export interface MobileControlSnapshot {
  protocolVersion: MobileControlProtocolVersion
  generatedAt: string
  desktopSessionId: string
  snapshotVersion?: string
  // Deliberately `string[]`, not MobileControlCommandType[]: the desktop may
  // advertise commands newer than the phone, which gates controls on them by raw
  // string. Rejecting unknown entries would turn every desktop command addition
  // into a phone that can no longer read snapshots at all.
  commands?: string[]
  backlog?: MobileControlBacklogWorkspaceSnapshot[]
  // Dev servers this desktop publishes on the tailnet, so the phone has a door
  // to them. Additive and omitted when there are none.
  webTargets?: MobileControlWebTargetSnapshot[]
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: MobileControlError }

/**
 * The check the phone runs on a snapshot it receives, kept here so the
 * desktop's tests can prove that what it sends — after path sanitizing — is a
 * document the phone accepts.
 *
 * Strict about the version: a snapshot is something this desktop SENDS, so only
 * the version it speaks is accepted. A window buys nothing there, and an older
 * snapshot can carry collections this wire has since retired.
 */
export function validateMobileControlSnapshot(input: unknown): ValidationResult<MobileControlSnapshot> {
  if (!isRecord(input)) return invalidPayload('snapshot must be an object')
  if (input.protocolVersion !== mobileControlProtocolVersion) {
    return {
      ok: false,
      error: buildError(
        'unsupported_protocol_version',
        unsupportedMobileControlProtocolVersion(input.protocolVersion, 'current'),
      ),
    }
  }

  const baseError =
    requireString(input, 'generatedAt') ??
    requireIsoDate(input, 'generatedAt') ??
    requireString(input, 'desktopSessionId') ??
    optionalString(input, 'snapshotVersion')
  if (baseError) return invalidPayload(baseError)

  if (input.commands !== undefined) {
    // Strings only, membership unchecked — see the field comment on
    // MobileControlSnapshot.commands.
    const commandError = validateStringArray(input.commands, 'snapshot.commands')
    if (commandError) return invalidPayload(commandError)
  }

  return { ok: true, value: input as unknown as MobileControlSnapshot }
}

function validateStringArray(input: unknown, fieldName: string): string | null {
  if (!Array.isArray(input)) return `${fieldName} must be an array`
  return input.every((value) => typeof value === 'string' && value.length > 0)
    ? null
    : `${fieldName} must contain only non-empty strings`
}

function requireString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  return typeof value === 'string' && value.length > 0 ? null : `${field} must be a non-empty string`
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  if (record[field] === undefined || requireString(record, field) === null) return null
  return `${field} must be a non-empty string when provided`
}

function requireIsoDate(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : `${field} must be an ISO 8601 timestamp`
}

function invalidPayload(message: string): ValidationResult<never> {
  return { ok: false, error: buildError('invalid_payload', message) }
}

function buildError(code: MobileControlErrorCode, message: string): MobileControlError {
  return { protocolVersion: mobileControlProtocolVersion, code, message, retryable: false }
}
