export const mobileControlProtocolVersion = 3 as const;
export const mobileControlWorkspaceSnapshotVersion = 2 as const;

/**
 * Every protocol version this desktop still accepts from a phone, oldest first.
 *
 * The desktop and the phone are two separately installed apps, and the phone's
 * update goes through a store review this repository does not control. Exact
 * equality — which is what every check here did until now — meant the hour
 * between shipping a desktop bump and the phone's build clearing review was an
 * hour in which every paired phone was refused outright, with
 * `unsupported_protocol_version` and no way for its owner to act on it.
 *
 * One version of slack is the smallest window that survives that, and the
 * largest that does not ask this code to remember two wire shapes indefinitely.
 * Widening it is a decision about how long an old phone keeps working; see
 * `docs/compatibility.md` for what a bump obliges a contributor to do.
 *
 * Outbound traffic is unaffected: this desktop always STAMPS
 * `mobileControlProtocolVersion`. The window governs only what it will read.
 */
export const mobileControlSupportedProtocolVersions = [2, 3] as const;

export type MobileControlProtocolVersion = (typeof mobileControlSupportedProtocolVersions)[number];
export type MobileControlWorkspaceSnapshotVersion = typeof mobileControlWorkspaceSnapshotVersion;

/**
 * The window has to END at the version this build speaks, or the desktop would
 * be advertising a version it does not itself accept back. A compile error here
 * means a bump changed `mobileControlProtocolVersion` and left the window behind.
 */
type _AssertWindowEndsAtCurrent =
  (typeof mobileControlSupportedProtocolVersions) extends readonly [...unknown[], typeof mobileControlProtocolVersion]
    ? true
    : ["mobileControlSupportedProtocolVersions must end at mobileControlProtocolVersion"];
const _windowEndsAtCurrent: _AssertWindowEndsAtCurrent = true;
void _windowEndsAtCurrent;

/** The oldest phone this desktop will still talk to. */
export const mobileControlMinSupportedProtocolVersion = mobileControlSupportedProtocolVersions[0];

export function isSupportedMobileControlProtocolVersion(value: unknown): value is MobileControlProtocolVersion {
  return (mobileControlSupportedProtocolVersions as readonly unknown[]).includes(value);
}

/**
 * Why a payload was refused, naming both the version seen and the window.
 *
 * Both, because either alone is undiagnosable: the phone's owner cannot act on
 * "unsupported version" without knowing which side is behind, and a support
 * thread that carries only one number cannot tell a phone that is too old from
 * one that is too new.
 */
export function unsupportedMobileControlProtocolVersion(
  seen: unknown,
  accepts: "window" | "current" = "window",
): string {
  // What the READER accepts, which is not always the window — a payload the
  // desktop sends is read at the current version only. Saying "speaks 1-2" on a
  // refusal that accepted neither would send someone looking for a bug that is
  // not there. Collapses to a single number once the window narrows to one.
  const speaks =
    accepts === "current"
      ? String(mobileControlProtocolVersion)
      : [...new Set<number>([mobileControlMinSupportedProtocolVersion, mobileControlProtocolVersion])].join("-");
  const saw = typeof seen === "number" ? String(seen) : "no readable version";
  return `mobile-control protocol version ${saw} is not supported; this build speaks ${speaks}`;
}

export type MobileControlCommandType =
  | "snapshot.request"
  | "device.revoke"
  | "backlog.update"
  | "backlog.create"
  | "automations.control";

export type MobileControlEventType =
  | "snapshot.updated"
  | "command.accepted"
  | "command.rejected"
  | "device.presence"
  | "notification.created";

export type MobileControlCapability =
  | "snapshots.read"
  | "devices.revoke"
  | "backlog.update"
  | "backlog.create"
  // Control the desktop's automations (src/main/automations). This is the
  // desktop's own automations store, not a Sprint Engine run's automation mode:
  // the run-scoped `sprintengines.automation` capability that used to sit beside
  // it, and which was a standing invitation to confuse the two, left the wire
  // with the rest of the Sprint Engine surface (v3).
  | "automations.control";

export type MobileControlErrorCode =
  | "unsupported_protocol_version"
  | "invalid_payload"
  | "unauthenticated"
  | "unauthorized"
  | "device_revoked"
  | "desktop_unavailable"
  | "relay_unavailable"
  | "command_not_supported"
  | "command_expired"
  | "duplicate_idempotency_key"
  | "stale_snapshot"
  // Kept although its name reads sprint-shaped: the automations controller
  // answers a run already in flight with it (src/main/mobile/control/command.ts).
  | "task_not_ready"
  | "path_not_allowed"
  | "snapshot_too_large"
  | "python_tool_failed"
  | "internal_error";

export type MobileNotificationCategory = "command.failed" | "desktop.offline";

export type MobileNotificationTarget =
  | { kind: "command"; commandId: string }
  | { kind: "desktop" };

export type MobileControlWorkspaceKind = "switchboard" | "watchtower";

export type MobileControlWorkspaceCapability =
  | "summary.read"
  | "detail.read"
  | "logs.read"
  | "comments.create"
  | "inbox.promote"
  | "tasks.move"
  | "runner.pause"
  | "runner.resume"
  | "execution.cancel";

export interface MobileControlError {
  protocolVersion: MobileControlProtocolVersion;
  code: MobileControlErrorCode;
  message: string;
  retryable: boolean;
  correlationId?: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface MobileControlCapabilities {
  protocolVersion: MobileControlProtocolVersion;
  deviceId: string;
  commands: MobileControlCommandType[];
  capabilities: MobileControlCapability[];
  snapshotTtlMs: number;
}

export type MobileControlDevicePlatform = "ios" | "android" | "web";

export interface MobileControlDevice {
  protocolVersion: MobileControlProtocolVersion;
  deviceId: string;
  displayName: string;
  platform: MobileControlDevicePlatform;
  appVersion: string;
  pairedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  capabilities: MobileControlCapability[];
}

export interface MobileControlCommandBase<Type extends MobileControlCommandType, Payload> {
  protocolVersion: MobileControlProtocolVersion;
  commandId: string;
  type: Type;
  issuedAt: string;
  deviceId: string;
  idempotencyKey?: string;
  expectedSnapshotVersion?: string;
  payload: Payload;
}

// Snapshot collections a `snapshot.request` may scope down to (item 1600).
// `desktopWorkspaces` is the switchboard/watchtower projections; it is
// the one collection absent from the default set, so a phone surface that wants
// those monitors must name it explicitly. The rest ship by default.
export const mobileSnapshotCollections = [
  "desktopWorkspaces",
  "backlog",
  "automations",
] as const;
export type MobileSnapshotCollection = (typeof mobileSnapshotCollections)[number];

export type SnapshotRequestCommand = MobileControlCommandBase<
  "snapshot.request",
  {
    /**
     * The `snapshotVersion` the client already holds. When it equals the
     * version the desktop would ship, `dispatchSnapshotRequest` skips the
     * payload and answers `{ ok: true, unchanged: true, snapshotVersion }`
     * (item 1599) — an If-None-Match on the read path. Additive and
     * old-client-safe: a client that omits it gets the full snapshot exactly
     * as before, so it cost no version bump of its own.
     *
     * This is skip-on-match, the opposite of the base `expectedSnapshotVersion`
     * (a reject-on-mismatch mutation guard) — do not fold the two together.
     */
    knownSnapshotVersion?: string;
    /**
     * Scope the snapshot to a single project root (item 1600). The value is the
     * relay-safe workspace token the phone already holds as `projectKey` on every
     * collection (deriveWorkspaceId output); the desktop resolves it back to the
     * real root and returns only that root's backlog and automations.
     * Additive and old-client-safe.
     */
    workspacePath?: string;
    /**
     * Restrict the payload to these collections (item 1600) so a list screen can
     * skip the ones it does not render. Absent means the default set — backlog
     * and automations; `desktopWorkspaces` (switchboard/watchtower) is off by
     * default and ships only when named here. Additive and old-client-safe.
     */
    include?: MobileSnapshotCollection[];
  }
>;

export type DeviceRevokeCommand = MobileControlCommandBase<
  "device.revoke",
  {
    deviceId: string;
    reason?: string;
  }
>;

export type BacklogUpdateCommand = MobileControlCommandBase<
  "backlog.update",
  {
    workspacePath: string;
    relativePath: string;
    status?: MobileControlBacklogItemStatus;
    type?: MobileControlBacklogItemType;
    difficulty?: MobileControlBacklogItemDifficulty;
    criticality?: MobileControlBacklogItemCriticality;
  }
>;


export type BacklogCreateCommand = MobileControlCommandBase<
  "backlog.create",
  {
    workspacePath: string;
    title: string;
    description?: string;
    type?: MobileControlBacklogItemType;
    difficulty?: MobileControlBacklogItemDifficulty;
    criticality?: MobileControlBacklogItemCriticality;
  }
>;

/**
 * What the phone may do to one automation. Deliberately not a boolean toggle:
 * `AutomationStatus` has three states and `blocked` is engine-owned, so there is
 * no action that sets it — the phone can only enable, pause, or fire a run.
 *
 * `runNow` is accepted by the engine ONLY for a `schedule` trigger with no run in
 * flight (`engine.runNow` rejects anything else with `unsupported_trigger` /
 * `in_flight`). The desktop enforces that; the phone gates the affordance on the
 * same facts so it never draws a button guaranteed to fail.
 *
 * There is no cancel for automation runs: no cancel primitive exists on that
 * surface, and the nearest thing (finalizing a run as failed) destroys the
 * worktree and disposes the agent — destruction, not cancellation. (Sprint runs
 * gained a cancel op with MC-1604, but cancel is a desktop decision by design;
 * the phone follows the snapshot.)
 */
export type MobileControlAutomationAction = "enable" | "pause" | "runNow";

/**
 * Control one desktop automation (item 47). One batched command covers enable,
 * pause and run-now because they share the re-pair cost of the new capability —
 * splitting them would buy two re-pairs for one benefit.
 *
 * `workspacePath` carries the workspace token (`ws_…`) the phone reads off the
 * automation's `projectKey`, exactly as the backlog commands do: absolute paths
 * are stripped before they cross the relay, so the desktop resolves the token
 * back to a root it already knows (`resolveWorkspaceIdToRoot`) and fails closed
 * with `path_not_allowed` when nothing matches.
 */
export type AutomationsControlCommand = MobileControlCommandBase<
  "automations.control",
  {
    workspacePath: string;
    automationId: string;
    action: MobileControlAutomationAction;
  }
>;

export type MobileControlCommand =
  | SnapshotRequestCommand
  | DeviceRevokeCommand
  | BacklogUpdateCommand
  | BacklogCreateCommand
  | AutomationsControlCommand;

export interface MobileControlWorkspaceSummary {
  status: "idle" | "running" | "needs_input" | "blocked" | "complete" | "error" | "unknown";
  headline?: string;
  counts?: Record<string, number>;
}

export interface MobileControlSwitchboardSourceSummary {
  type: string;
  externalId?: string | null;
  externalKey?: string | null;
  externalUrl?: string | null;
}

export interface MobileControlSwitchboardTaskSummary {
  taskId: string;
  identifier: string;
  title: string;
  status: string;
  lane: string;
  updatedAt: string;
  source: MobileControlSwitchboardSourceSummary;
  priority?: number | null;
  claimedBy?: string | null;
}

export interface MobileControlSwitchboardCommentSummary {
  taskId: string;
  commentId: string;
  kind: string;
  body: string;
  createdAt: string;
  authorName?: string | null;
  confidencePct?: number | null;
}

export interface MobileControlSwitchboardEvidenceSummary {
  taskId: string;
  summary?: string;
  artifactCount: number;
  commandCount: number;
  touchedFileCount: number;
  updatedAt: string;
}

export interface MobileControlSwitchboardLogSummary {
  taskId?: string;
  executionId: string;
  status?: string | null;
  agentId?: string | null;
  startedAt: string;
  completedAt?: string | null;
  summary?: string | null;
}

export interface MobileControlSwitchboardWorkspaceDetail {
  inboxCount?: number;
  laneCounts?: Record<string, number>;
  activeExecutionCount?: number;
  tasks?: MobileControlSwitchboardTaskSummary[];
  inboxItems?: MobileControlSwitchboardTaskSummary[];
  comments?: MobileControlSwitchboardCommentSummary[];
  evidence?: MobileControlSwitchboardEvidenceSummary[];
  logs?: MobileControlSwitchboardLogSummary[];
}

export interface MobileControlWatchtowerRunSummary {
  runId: string;
  status: string;
  preset: string;
  createdAt: string;
  completedAt?: string | null;
  validCount: number;
  invalidCount: number;
  generatedInboxCount: number;
  agentCount: number;
}

export interface MobileControlWatchtowerGeneratedInboxSummary {
  runId: string;
  taskId: string;
  source: "watchtower";
}

export interface MobileControlWatchtowerWorkspaceDetail {
  activeRunCount?: number;
  latestRunStatus?: string;
  generatedInboxCount?: number;
  runs?: MobileControlWatchtowerRunSummary[];
  generatedInboxItems?: MobileControlWatchtowerGeneratedInboxSummary[];
}

export type MobileControlWorkspaceDetail =
  | { kind: "switchboard"; data: MobileControlSwitchboardWorkspaceDetail }
  | { kind: "watchtower"; data: MobileControlWatchtowerWorkspaceDetail };

export interface MobileControlWorkspaceSnapshot {
  workspaceId: string;
  kind: MobileControlWorkspaceKind;
  name: string;
  workspacePath?: string;
  /** The repo this workspace belongs to, as a relay-safe token (MC-1583). */
  projectKey?: string;
  statePath?: string;
  updatedAt: string;
  capabilities: MobileControlWorkspaceCapability[];
  detailVersion: MobileControlWorkspaceSnapshotVersion;
  summary: MobileControlWorkspaceSummary;
  detail?: MobileControlWorkspaceDetail;
}

export type MobileControlBacklogItemStatus = "idea" | "ready" | "in_progress" | "needs_input" | "completed" | "archived";
export type MobileControlBacklogItemType = "epic" | "feature" | "bug" | "mockup" | "spike";
export type MobileControlBacklogItemDifficulty = "xs" | "s" | "m" | "l" | "xl";
export type MobileControlBacklogItemCriticality = "low" | "normal" | "high" | "critical";

export interface MobileControlBacklogItemSnapshot {
  itemId: string;
  relativePath: string;
  title: string;
  excerpt?: string;
  status: MobileControlBacklogItemStatus;
  type?: MobileControlBacklogItemType;
  difficulty?: MobileControlBacklogItemDifficulty;
  criticality?: MobileControlBacklogItemCriticality;
  // The up-pointing epic slug (frontmatter `epic:`) when this item belongs to an
  // epic; absent otherwise. The epic -> children direction stays a derived query.
  epic?: string;
  updatedAt?: string;
}

// Per-workspace epic metadata (MC-1498). Items carry only the `epic` up-slug; the
// phone renders desktop-parity epic chips and color bands, which need the epic's
// display id and color. Kept as a per-workspace block rather than denormalized
// onto every item.
export interface MobileControlBacklogEpicSnapshot {
  /** The epic slug (matches an item's `epic` up-slug). */
  slug: string;
  /** The epic's display id, e.g. `MC-1493`, when the epic file carries an `id`. */
  displayId?: string;
  title?: string;
  /** One of the desktop seven-color highlight set, when the epic sets `color`. */
  color?: string;
  /** Rollup over the epic's member items. */
  doneCount: number;
  totalCount: number;
}

export interface MobileControlBacklogWorkspaceSnapshot {
  workspaceId: string;
  workspacePath: string;
  /** The repo this backlog group belongs to, as a relay-safe token (MC-1583). */
  projectKey?: string;
  workspaceName: string;
  updatedAt: string;
  items: MobileControlBacklogItemSnapshot[];
  /** Epic metadata for the workspace's epics (MC-1498). */
  epics?: MobileControlBacklogEpicSnapshot[];
}

// Terminal and in-flight states of one automation run (`AutomationRunStatus`,
// multicode/src/shared/automations/contracts.ts). Closed on purpose: unlike a
// trigger kind, run status is engine-owned and cannot be extended by a provider.
export type MobileControlAutomationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

// One past run of an automation. Bounded and lossy by design: the phone monitors
// runs, it does not inspect them, so touched files, commands, prompts and worktree
// paths stay off the wire. `summary` and `blockedReason` are truncated by the
// producer to `automationRunTextMaxChars`.
export interface MobileControlAutomationRunSummary {
  runId: string;
  status: MobileControlAutomationRunStatus;
  /**
   * Present once the run leaves `queued`. The phone needs it to age-qualify a
   * `running` run: a permission-blocked run has no finalize channel and sits
   * `running` for hours until a sweep fails it, so elapsed time is the only
   * signal that separates healthy progress from a stuck run.
   */
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  summary?: string;
}

// One automation, projected for a read-only monitor (item 47). Nothing about the
// action, condition, prompt, worktree or connector rides this wire — the phone
// watches automations; the desktop authors them.
export interface MobileControlAutomationSnapshot {
  automationId: string;
  /** The repo this automation belongs to, as a relay-safe token (MC-1583). */
  projectKey?: string;
  name: string;
  /**
   * `AutomationStatus` (contracts.ts). Three states, not a boolean: `blocked` is
   * a real state the engine puts an automation into, and it must render as itself
   * rather than collapsing into "off".
   */
  status: "enabled" | "paused" | "blocked";
  /**
   * `AutomationDefinition.trigger.kind`. An OPEN string, mirroring `TriggerKind`
   * (contracts.ts) — trigger kinds are provider-registered, so a closed union here
   * would make any third-party trigger unreadable to the phone. Known kinds today:
   * `schedule`, `repo-event`, `webhook`. Anything else renders generically.
   */
  triggerKind: string;
  /**
   * Human-readable cadence ("Every 30 min", "Daily 09:00 IST"), PRE-RENDERED by the
   * desktop. The raw `ScheduleTriggerConfig.cadence` is a four-way discriminated
   * union plus a timezone, and trigger `config` is typed `unknown` because providers
   * own their schemas — the phone must never parse provider-owned config.
   */
  cadence?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: MobileControlAutomationRunStatus;
  /**
   * True while a run of this automation is `queued` or `running`.
   *
   * The phone gates the run-now affordance on `triggerKind === "schedule"` AND
   * this being falsy, because `engine.runNow` rejects a second run with
   * `in_flight`. It is a FIELD OF ITS OWN, and not something the phone infers
   * from `recentRuns`, for two reasons: `recentRuns` is the first automations
   * field the shedding ladder drops (bridge/snapshot-request.ts), and its
   * absence is ambiguous anyway — the producer also omits it for an automation
   * that has never run, which is precisely the case where run-now IS allowed.
   * Inferring in-flight from it would therefore hide the button exactly when a
   * big snapshot shed the history.
   *
   * `lastRunStatus` cannot answer this either: `lastRunId` is only stamped once
   * a run finishes (engine.ts updateDefinitionAfterRun), so it never names the
   * run that is in flight right now.
   */
  runInFlight?: boolean;
  /** Newest first, capped at `automationRecentRunsMax` by the producer. */
  recentRuns?: MobileControlAutomationRunSummary[];
}

// Read-only roadmap progress rider (MC-1620 / T7). ADDITIVE: an old phone that does
// not read `roadmaps` renders sprints exactly as before, and it carries NO new
// relay scope — the phone never acts on a roadmap (approvals from the phone are out
// of scope for v1). Per-lane it reports only what a progress view needs: how far the
// lane is, the running step's title, and whether it is paused. No paths, no run
// state, nothing the phone could steer with.
export interface MobileControlRoadmapLaneRider {
  name: string;
  /** Steps whose backlog item is delivered (terminal), of `total`. */
  done: number;
  total: number;
  /** Human title of the step whose sprint is running now, when one is. */
  runningItem?: string;
  /** True while the lane is paused/parked and waiting on the human. */
  parked?: boolean;
}

export interface MobileControlRoadmapRider {
  /** The roadmap file's stable slug (its file-name stem). */
  roadmapId: string;
  name: string;
  /**
   * The repo this horizon belongs to, as the same relay-safe token every other
   * collection is stamped with (MC-1583). Riders from every workspace root are
   * flattened into one top-level list, so without this a phone cannot tell which
   * project a horizon belongs to — and a phone that scopes its surfaces to a
   * current project would have to choose between showing another project's plan
   * and showing none at all.
   *
   * Additive and old-client-safe; absent from a desktop that predates it, and a
   * reader should then treat the horizon as unscoped rather than dropping it.
   */
  projectKey?: string;
  lanes: MobileControlRoadmapLaneRider[];
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
 * screen — the same contract `roadmaps` ships under.
 */
export interface MobileControlWebTargetSnapshot {
  /** Stable within a desktop session: the HTTPS port publishing it. */
  id: string;
  /** What a person recognises — the local port and the process serving it. */
  label: string;
  /** `https://<node>.<tailnet>.ts.net[:port]/` — opened as-is, never rewritten. */
  url: string;
  /** The loopback port on the desktop, for the label and for matching. */
  localPort: number;
  /** The desktop publishing it, by MagicDNS name. */
  machine: string;
}

export interface MobileControlSnapshot {
  protocolVersion: MobileControlProtocolVersion;
  generatedAt: string;
  desktopSessionId: string;
  snapshotVersion?: string;
  // Deliberately `string[]`, not MobileControlCommandType[]: the desktop may
  // advertise commands newer than this client (dark-launched controls gate on
  // them by raw string — see snapshotAdvertisesCapability). Rejecting unknown
  // entries here would turn every desktop command addition into a client that
  // can no longer read snapshots at all.
  commands?: string[];
  workspaces?: MobileControlWorkspaceSnapshot[];
  backlog?: MobileControlBacklogWorkspaceSnapshot[];
  // Flat across the desktop's automations store, grouped by each entry's
  // `projectKey` the way `backlog` groups by repo. Capped by construction —
  // see `automationsPerProjectMax`.
  automations?: MobileControlAutomationSnapshot[];
  // Read-only roadmap progress riders (MC-1620), one per active roadmap. Additive
  // and omitted when there are none, so a phone that predates roadmaps is untouched.
  roadmaps?: MobileControlRoadmapRider[];
  // Dev servers this desktop publishes on the tailnet, so the phone has a door
  // to them (Track 1b). Additive and omitted when there are none.
  webTargets?: MobileControlWebTargetSnapshot[];
}

export interface MobileControlEventBase<Type extends MobileControlEventType, Payload> {
  protocolVersion: MobileControlProtocolVersion;
  eventId: string;
  type: Type;
  emittedAt: string;
  payload: Payload;
}

export type SnapshotUpdatedEvent = MobileControlEventBase<
  "snapshot.updated",
  {
    snapshot: MobileControlSnapshot;
  }
>;

export type CommandAcceptedEvent = MobileControlEventBase<
  "command.accepted",
  {
    commandId: string;
    acceptedAt: string;
  }
>;

export type CommandRejectedEvent = MobileControlEventBase<
  "command.rejected",
  {
    commandId: string;
    error: MobileControlError;
  }
>;

export type DevicePresenceEvent = MobileControlEventBase<
  "device.presence",
  {
    device: MobileControlDevice;
    presence: "online" | "offline" | "revoked";
  }
>;

export type NotificationCreatedEvent = MobileControlEventBase<
  "notification.created",
  {
    category: MobileNotificationCategory;
    title: string;
    body: string;
    severity: "info" | "warning" | "error";
    deepLink: string;
    target: MobileNotificationTarget;
  }
>;

export type MobileControlEvent =
  | SnapshotUpdatedEvent
  | CommandAcceptedEvent
  | CommandRejectedEvent
  | DevicePresenceEvent
  | NotificationCreatedEvent;

export type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: MobileControlError;
    };

type ObjectValidationResult =
  | {
      ok: true;
      value: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

const commandTypes = [
  "snapshot.request",
  "device.revoke",
  "backlog.update",
  "backlog.create",
  "automations.control",
] as const satisfies readonly MobileControlCommandType[];

const eventTypes = [
  "snapshot.updated",
  "command.accepted",
  "command.rejected",
  "device.presence",
  "notification.created",
] as const satisfies readonly MobileControlEventType[];

const capabilities = [
  "snapshots.read",
  "devices.revoke",
  "backlog.update",
  "backlog.create",
  "automations.control",
] as const satisfies readonly MobileControlCapability[];

// `satisfies` only proves the entries are valid, not that the list is
// complete — the backlog trio above was once missing here (MC-1499), so
// validateCapabilityArray rejected device payloads carrying scopes that
// pairing actually grants. This alias turns a missing member into a compile
// error.
type _AssertCapabilityListComplete = [
  Exclude<MobileControlCapability, (typeof capabilities)[number]>,
] extends [never]
  ? true
  : ["capabilities const is missing", Exclude<MobileControlCapability, (typeof capabilities)[number]>];
const _capabilityListComplete: _AssertCapabilityListComplete = true;
void _capabilityListComplete;

const errorCodes = [
  "unsupported_protocol_version",
  "invalid_payload",
  "unauthenticated",
  "unauthorized",
  "device_revoked",
  "desktop_unavailable",
  "relay_unavailable",
  "command_not_supported",
  "command_expired",
  "duplicate_idempotency_key",
  "stale_snapshot",
  "task_not_ready",
  "path_not_allowed",
  "snapshot_too_large",
  "python_tool_failed",
  "internal_error",
] as const satisfies readonly MobileControlErrorCode[];

const devicePlatforms = ["ios", "android", "web"] as const satisfies readonly MobileControlDevicePlatform[];
const presenceValues = ["online", "offline", "revoked"] as const;
const severityValues = ["info", "warning", "error"] as const;
const workspaceKinds = ["switchboard", "watchtower"] as const;
const workspaceCapabilities = [
  "summary.read",
  "detail.read",
  "logs.read",
  "comments.create",
  "inbox.promote",
  "tasks.move",
  "runner.pause",
  "runner.resume",
  "execution.cancel",
] as const satisfies readonly MobileControlWorkspaceCapability[];
const workspaceSummaryStatuses = ["idle", "running", "needs_input", "blocked", "complete", "error", "unknown"] as const;
const notificationCategories = [
  "command.failed",
  "desktop.offline",
] as const satisfies readonly MobileNotificationCategory[];
const notificationTargetKinds = ["command", "desktop"] as const;
const automationStatuses = ["enabled", "paused", "blocked"] as const satisfies readonly MobileControlAutomationSnapshot["status"][];
const automationRunStatuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "blocked",
  "skipped",
] as const satisfies readonly MobileControlAutomationRunStatus[];

export function validateMobileControlCommand(input: unknown): ValidationResult<MobileControlCommand> {
  const base = validateObject(input, "command");
  if (base.ok === false) {
    return invalidPayload(base.error);
  }

  const versionError = validateProtocolVersion(base.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(base.value, "commandId") ??
    requireString(base.value, "issuedAt") ??
    requireIsoDate(base.value, "issuedAt") ??
    requireString(base.value, "deviceId");
  if (baseError) {
    return invalidPayload(baseError);
  }

  const type = base.value.type;
  if (!isOneOf(type, commandTypes)) {
    return invalidPayload("command.type must be a supported mobile-control command");
  }

  const payload = validateObject(base.value.payload, "command.payload");
  if (payload.ok === false) {
    return invalidPayload(payload.error);
  }

  const idempotencyError = optionalString(base.value, "idempotencyKey") ?? optionalString(base.value, "expectedSnapshotVersion");
  if (idempotencyError) {
    return invalidPayload(idempotencyError);
  }

  const payloadError = validateCommandPayload(type, payload.value);
  if (payloadError) {
    return invalidPayload(payloadError);
  }

  return { ok: true, value: input as MobileControlCommand };
}

export function validateMobileControlEvent(input: unknown): ValidationResult<MobileControlEvent> {
  const event = validateObject(input, "event");
  if (event.ok === false) {
    return invalidPayload(event.error);
  }

  const versionError = validateProtocolVersion(event.value, "current");
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(event.value, "eventId") ??
    requireString(event.value, "emittedAt") ??
    requireIsoDate(event.value, "emittedAt");
  if (baseError) {
    return invalidPayload(baseError);
  }

  const type = event.value.type;
  if (!isOneOf(type, eventTypes)) {
    return invalidPayload("event.type must be a supported mobile-control event");
  }

  const payload = validateObject(event.value.payload, "event.payload");
  if (payload.ok === false) {
    return invalidPayload(payload.error);
  }

  const payloadError = validateEventPayload(type, payload.value);
  if (payloadError) {
    return invalidPayload(payloadError);
  }

  return { ok: true, value: input as MobileControlEvent };
}

export function validateMobileControlSnapshot(input: unknown): ValidationResult<MobileControlSnapshot> {
  const snapshot = validateObject(input, "snapshot");
  if (snapshot.ok === false) {
    return invalidPayload(snapshot.error);
  }

  const versionError = validateProtocolVersion(snapshot.value, "current");
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(snapshot.value, "generatedAt") ??
    requireIsoDate(snapshot.value, "generatedAt") ??
    requireString(snapshot.value, "desktopSessionId") ??
    optionalString(snapshot.value, "snapshotVersion");
  if (baseError) {
    return invalidPayload(baseError);
  }

  if (snapshot.value.commands !== undefined) {
    // Strings only, membership unchecked — unknown commands must flow through
    // so dark-launched capability gates can see them (see the field comment on
    // MobileControlSnapshot.commands).
    const commandError = validateStringArray(snapshot.value.commands, "snapshot.commands");
    if (commandError) {
      return invalidPayload(commandError);
    }
  }

  if (snapshot.value.workspaces !== undefined) {
    const workspacesError = requireArray(snapshot.value, "workspaces");
    if (workspacesError) {
      return invalidPayload(workspacesError);
    }

    for (const workspace of snapshot.value.workspaces as unknown[]) {
      const error = validateWorkspaceSnapshot(workspace);
      if (error) {
        return invalidPayload(error);
      }
    }
  }

  const roadmapsError = validateOptionalArray(
    snapshot.value.roadmaps,
    "snapshot.roadmaps",
    validateRoadmapRider,
  );
  if (roadmapsError) {
    return invalidPayload(roadmapsError);
  }

  const automationsError = validateOptionalArray(
    snapshot.value.automations,
    "snapshot.automations",
    validateAutomationSnapshot,
  );
  if (automationsError) {
    return invalidPayload(automationsError);
  }

  return { ok: true, value: input as MobileControlSnapshot };
}

export function validateMobileControlDevice(input: unknown): ValidationResult<MobileControlDevice> {
  const device = validateObject(input, "device");
  if (device.ok === false) {
    return invalidPayload(device.error);
  }

  const versionError = validateProtocolVersion(device.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(device.value, "deviceId") ??
    requireString(device.value, "displayName") ??
    requireString(device.value, "appVersion") ??
    requireString(device.value, "pairedAt") ??
    requireIsoDate(device.value, "pairedAt") ??
    requireArray(device.value, "capabilities") ??
    optionalIsoDate(device.value, "lastSeenAt") ??
    optionalIsoDate(device.value, "revokedAt");
  if (baseError) {
    return invalidPayload(baseError);
  }

  if (!isOneOf(device.value.platform, devicePlatforms)) {
    return invalidPayload("device.platform must be ios, android, or web");
  }

  const capabilitiesError = validateCapabilityArray(device.value.capabilities, "device.capabilities");
  if (capabilitiesError) {
    return invalidPayload(capabilitiesError);
  }

  return { ok: true, value: input as MobileControlDevice };
}

export function validateMobileControlCapabilities(input: unknown): ValidationResult<MobileControlCapabilities> {
  const contract = validateObject(input, "capabilities");
  if (contract.ok === false) {
    return invalidPayload(contract.error);
  }

  const versionError = validateProtocolVersion(contract.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(contract.value, "deviceId") ??
    requireArray(contract.value, "commands") ??
    requireArray(contract.value, "capabilities") ??
    requirePositiveInteger(contract.value, "snapshotTtlMs");
  if (baseError) {
    return invalidPayload(baseError);
  }

  const commandError = validateStringLiteralArray(contract.value.commands, commandTypes, "capabilities.commands");
  const capabilityError = validateCapabilityArray(contract.value.capabilities, "capabilities.capabilities");
  const error = commandError ?? capabilityError;
  if (error) {
    return invalidPayload(error);
  }

  return { ok: true, value: input as MobileControlCapabilities };
}

export function validateMobileControlError(input: unknown): ValidationResult<MobileControlError> {
  const error = validateObject(input, "error");
  if (error.ok === false) {
    return invalidPayload(error.error);
  }

  const versionError = validateProtocolVersion(error.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(error.value, "message") ??
    requireBoolean(error.value, "retryable") ??
    optionalString(error.value, "correlationId");
  if (baseError) {
    return invalidPayload(baseError);
  }

  if (!isOneOf(error.value.code, errorCodes)) {
    return invalidPayload("error.code must be a stable mobile-control error code");
  }

  if ("detail" in error.value && error.value.detail !== undefined) {
    const detail = validateObject(error.value.detail, "error.detail");
    if (detail.ok === false) {
      return invalidPayload(detail.error);
    }
    for (const [key, value] of Object.entries(detail.value)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) {
        return invalidPayload(`error.detail.${key} must be a string, number, boolean, or null`);
      }
    }
  }

  return { ok: true, value: input as MobileControlError };
}

/**
 * How strict a reader is about the version stamped on what it just received.
 *
 * `window` accepts anything in `mobileControlSupportedProtocolVersions`, and is
 * for records where an OLDER counterpart is a case worth surviving: a command
 * from a phone whose store build has not cleared review yet, and the device and
 * capability records read back from disk, which were written by whatever version
 * was installed when they were stored.
 *
 * `current` accepts only the version this build speaks, and is for the payloads
 * the desktop SENDS. A window buys nothing there — a phone receiving a snapshot
 * from a newer desktop is not helped by also accepting older ones — and it costs
 * something real: a v2 snapshot carries the Sprint Engine collections this wire
 * retired (`sprintEngines`, `roleCatalogs`, the `sprintengine` workspace kind),
 * so accepting the version would only get the reader further in before failing
 * on a shape it no longer has a type for.
 */
type ProtocolVersionStrictness = "window" | "current";

function validateProtocolVersion(
  record: Record<string, unknown>,
  strictness: ProtocolVersionStrictness = "window",
): ValidationResult<never> | null {
  const accepted =
    strictness === "current"
      ? record.protocolVersion === mobileControlProtocolVersion
      : isSupportedMobileControlProtocolVersion(record.protocolVersion);
  if (!accepted) {
    return {
      ok: false,
      error: buildError(
        "unsupported_protocol_version",
        unsupportedMobileControlProtocolVersion(record.protocolVersion, strictness),
        false,
      ),
    };
  }

  return null;
}

// Bounds on the automations projection (item 47). The snapshot has no
// size-shedding ladder left — the sprint runs and role catalogs it used to drop
// left the wire in v3 — so every collection on it must now stay small by
// construction or it eats the relay's result-summary budget outright.
// The producer enforces these; the wire types cannot.
export const automationsPerProjectMax = 24;
export const automationRecentRunsMax = 5;
export const automationRunTextMaxChars = 160;

function validateCommandPayload(type: MobileControlCommandType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "snapshot.request":
      return (
        optionalString(payload, "knownSnapshotVersion") ??
        optionalString(payload, "workspacePath") ??
        optionalSnapshotCollections(payload, "include")
      );
    case "device.revoke":
      return requireString(payload, "deviceId") ?? optionalString(payload, "reason");
    case "backlog.update":
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "relativePath") ??
        optionalString(payload, "status") ??
        optionalString(payload, "type") ??
        optionalString(payload, "difficulty") ??
        optionalString(payload, "criticality")
      );
    case "backlog.create":
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "title") ??
        optionalString(payload, "description") ??
        optionalString(payload, "type") ??
        optionalString(payload, "difficulty") ??
        optionalString(payload, "criticality")
      );
    case "automations.control":
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "automationId") ??
        requireLiteral(payload, "action", automationActionValues)
      );
  }
}

const automationActionValues = ["enable", "pause", "runNow"] as const satisfies readonly MobileControlAutomationAction[];

function validateEventPayload(type: MobileControlEventType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "snapshot.updated": {
      const snapshot = validateMobileControlSnapshot(payload.snapshot);
      if (snapshot.ok === false) {
        return snapshot.error.message;
      }
      return null;
    }
    case "command.accepted":
      return requireString(payload, "commandId") ?? requireString(payload, "acceptedAt") ?? requireIsoDate(payload, "acceptedAt");
    case "command.rejected": {
      const error = validateMobileControlError(payload.error);
      if (error.ok === false) {
        return error.error.message;
      }
      return requireString(payload, "commandId");
    }
    case "device.presence": {
      const device = validateMobileControlDevice(payload.device);
      if (device.ok === false) {
        return device.error.message;
      }
      return requireLiteral(payload, "presence", presenceValues);
    }
    case "notification.created":
      return (
        requireLiteral(payload, "category", notificationCategories) ??
        requireString(payload, "title") ??
        requireString(payload, "body") ??
        requireLiteral(payload, "severity", severityValues) ??
        requireString(payload, "deepLink") ??
        validateNotificationTarget(payload.target)
      );
  }
}

function validateNotificationTarget(input: unknown): string | null {
  const target = validateObject(input, "notification.target");
  if (target.ok === false) {
    return target.error;
  }

  const kindError = requireLiteral(target.value, "kind", notificationTargetKinds);
  if (kindError) {
    return kindError;
  }

  switch (target.value.kind) {
    case "command":
      return requireString(target.value, "commandId");
    case "desktop":
      return null;
  }

  return "notification.target.kind must be a supported notification target";
}

function validateWorkspaceSnapshot(input: unknown): string | null {
  const workspace = validateObject(input, "snapshot.workspace");
  if (workspace.ok === false) {
    return workspace.error;
  }

  const baseError =
    requireString(workspace.value, "workspaceId") ??
    requireLiteral(workspace.value, "kind", workspaceKinds) ??
    requireString(workspace.value, "name") ??
    optionalString(workspace.value, "workspacePath") ??
    optionalString(workspace.value, "statePath") ??
    requireString(workspace.value, "updatedAt") ??
    requireIsoDate(workspace.value, "updatedAt") ??
    requireArray(workspace.value, "capabilities") ??
    requireLiteralNumber(workspace.value, "detailVersion", mobileControlWorkspaceSnapshotVersion);
  if (baseError) {
    return baseError;
  }

  const capabilitiesError = validateStringLiteralArray(
    workspace.value.capabilities,
    workspaceCapabilities,
    "workspace.capabilities",
  );
  if (capabilitiesError) {
    return capabilitiesError;
  }

  const summaryError = validateWorkspaceSummary(workspace.value.summary);
  if (summaryError) {
    return summaryError;
  }

  if (workspace.value.detail !== undefined) {
    return validateWorkspaceDetail(workspace.value.kind as MobileControlWorkspaceKind, workspace.value.detail);
  }

  return null;
}

function validateWorkspaceSummary(input: unknown): string | null {
  const summary = validateObject(input, "workspace.summary");
  if (summary.ok === false) {
    return summary.error;
  }

  const baseError =
    requireLiteral(summary.value, "status", workspaceSummaryStatuses) ??
    optionalString(summary.value, "headline");
  if (baseError) {
    return baseError;
  }

  if (summary.value.counts !== undefined) {
    const counts = validateObject(summary.value.counts, "workspace.summary.counts");
    if (counts.ok === false) {
      return counts.error;
    }
    for (const [key, value] of Object.entries(counts.value)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return `workspace.summary.counts.${key} must be a non-negative integer`;
      }
    }
  }

  return null;
}

function validateWorkspaceDetail(kind: MobileControlWorkspaceKind, input: unknown): string | null {
  const detail = validateObject(input, "workspace.detail");
  if (detail.ok === false) {
    return detail.error;
  }

  const kindError = requireLiteral(detail.value, "kind", workspaceKinds);
  if (kindError) {
    return kindError;
  }
  if (detail.value.kind !== kind) {
    return "workspace.detail.kind must match workspace.kind";
  }

  const data = validateObject(detail.value.data, "workspace.detail.data");
  if (data.ok === false) {
    return data.error;
  }

  switch (kind) {
    case "switchboard":
      return (
        optionalNonNegativeInteger(data.value, "inboxCount") ??
        optionalNumberRecord(data.value, "laneCounts") ??
        optionalNonNegativeInteger(data.value, "activeExecutionCount") ??
        validateOptionalArray(data.value.tasks, "workspace.detail.data.tasks", validateSwitchboardTaskSummary) ??
        validateOptionalArray(data.value.inboxItems, "workspace.detail.data.inboxItems", validateSwitchboardTaskSummary) ??
        validateOptionalArray(data.value.comments, "workspace.detail.data.comments", validateSwitchboardCommentSummary) ??
        validateOptionalArray(data.value.evidence, "workspace.detail.data.evidence", validateSwitchboardEvidenceSummary) ??
        validateOptionalArray(data.value.logs, "workspace.detail.data.logs", validateSwitchboardLogSummary)
      );
    case "watchtower":
      return (
        optionalNonNegativeInteger(data.value, "activeRunCount") ??
        optionalString(data.value, "latestRunStatus") ??
        optionalNonNegativeInteger(data.value, "generatedInboxCount") ??
        validateOptionalArray(data.value.runs, "workspace.detail.data.runs", validateWatchtowerRunSummary) ??
        validateOptionalArray(
          data.value.generatedInboxItems,
          "workspace.detail.data.generatedInboxItems",
          validateWatchtowerGeneratedInboxSummary,
        )
      );
  }
}

function validateSwitchboardTaskSummary(input: unknown, fieldName: string): string | null {
  const task = validateObject(input, fieldName);
  if (task.ok === false) {
    return task.error;
  }
  return (
    requireString(task.value, "taskId") ??
    requireString(task.value, "identifier") ??
    requireString(task.value, "title") ??
    requireString(task.value, "status") ??
    requireString(task.value, "lane") ??
    requireString(task.value, "updatedAt") ??
    requireIsoDate(task.value, "updatedAt") ??
    optionalNullableNumber(task.value, "priority") ??
    optionalNullableString(task.value, "claimedBy") ??
    validateSwitchboardSourceSummary(task.value.source, `${fieldName}.source`)
  );
}

function validateSwitchboardSourceSummary(input: unknown, fieldName: string): string | null {
  const source = validateObject(input, fieldName);
  if (source.ok === false) {
    return source.error;
  }
  return (
    requireString(source.value, "type") ??
    optionalNullableString(source.value, "externalId") ??
    optionalNullableString(source.value, "externalKey") ??
    optionalNullableString(source.value, "externalUrl")
  );
}

function validateSwitchboardCommentSummary(input: unknown, fieldName: string): string | null {
  const comment = validateObject(input, fieldName);
  if (comment.ok === false) {
    return comment.error;
  }
  return (
    requireString(comment.value, "taskId") ??
    requireString(comment.value, "commentId") ??
    requireString(comment.value, "kind") ??
    requireString(comment.value, "body") ??
    requireString(comment.value, "createdAt") ??
    requireIsoDate(comment.value, "createdAt") ??
    optionalNullableString(comment.value, "authorName") ??
    optionalNullablePercentage(comment.value, "confidencePct")
  );
}

function validateSwitchboardEvidenceSummary(input: unknown, fieldName: string): string | null {
  const evidence = validateObject(input, fieldName);
  if (evidence.ok === false) {
    return evidence.error;
  }
  return (
    requireString(evidence.value, "taskId") ??
    optionalString(evidence.value, "summary") ??
    requireNonNegativeInteger(evidence.value, "artifactCount") ??
    requireNonNegativeInteger(evidence.value, "commandCount") ??
    requireNonNegativeInteger(evidence.value, "touchedFileCount") ??
    requireString(evidence.value, "updatedAt") ??
    requireIsoDate(evidence.value, "updatedAt")
  );
}

function validateSwitchboardLogSummary(input: unknown, fieldName: string): string | null {
  const log = validateObject(input, fieldName);
  if (log.ok === false) {
    return log.error;
  }
  return (
    optionalString(log.value, "taskId") ??
    requireString(log.value, "executionId") ??
    optionalNullableString(log.value, "status") ??
    optionalNullableString(log.value, "agentId") ??
    requireString(log.value, "startedAt") ??
    requireIsoDate(log.value, "startedAt") ??
    optionalNullableIsoDate(log.value, "completedAt") ??
    optionalNullableString(log.value, "summary")
  );
}

function validateWatchtowerRunSummary(input: unknown, fieldName: string): string | null {
  const run = validateObject(input, fieldName);
  if (run.ok === false) {
    return run.error;
  }
  return (
    requireString(run.value, "runId") ??
    requireString(run.value, "status") ??
    requireString(run.value, "preset") ??
    requireString(run.value, "createdAt") ??
    requireIsoDate(run.value, "createdAt") ??
    optionalNullableIsoDate(run.value, "completedAt") ??
    requireNonNegativeInteger(run.value, "validCount") ??
    requireNonNegativeInteger(run.value, "invalidCount") ??
    requireNonNegativeInteger(run.value, "generatedInboxCount") ??
    requireNonNegativeInteger(run.value, "agentCount")
  );
}

function validateWatchtowerGeneratedInboxSummary(input: unknown, fieldName: string): string | null {
  const item = validateObject(input, fieldName);
  if (item.ok === false) {
    return item.error;
  }
  return (
    requireString(item.value, "runId") ??
    requireString(item.value, "taskId") ??
    requireLiteral(item.value, "source", ["watchtower"] as const)
  );
}

function validateRoadmapRider(input: unknown, fieldName: string): string | null {
  const rider = validateObject(input, fieldName);
  if (rider.ok === false) {
    return rider.error;
  }
  const baseError =
    requireString(rider.value, "roadmapId") ??
    requireString(rider.value, "name") ??
    optionalString(rider.value, "projectKey") ??
    requireArray(rider.value, "lanes");
  if (baseError) {
    return baseError;
  }
  for (const lane of rider.value.lanes as unknown[]) {
    const laneObject = validateObject(lane, `${fieldName}.lanes[]`);
    if (laneObject.ok === false) {
      return laneObject.error;
    }
    const laneError =
      requireString(laneObject.value, "name") ??
      requireNonNegativeInteger(laneObject.value, "done") ??
      requireNonNegativeInteger(laneObject.value, "total") ??
      optionalString(laneObject.value, "runningItem") ??
      optionalBoolean(laneObject.value, "parked");
    if (laneError) {
      return laneError;
    }
  }
  return null;
}

function validateAutomationSnapshot(input: unknown, fieldName: string): string | null {
  const automation = validateObject(input, fieldName);
  if (automation.ok === false) {
    return automation.error;
  }

  const baseError =
    requireString(automation.value, "automationId") ??
    optionalString(automation.value, "projectKey") ??
    requireString(automation.value, "name") ??
    requireLiteral(automation.value, "status", automationStatuses) ??
    // Membership deliberately unchecked beyond "non-empty string": trigger kinds
    // are provider-registered (see MobileControlAutomationSnapshot.triggerKind).
    requireString(automation.value, "triggerKind") ??
    optionalString(automation.value, "cadence") ??
    optionalIsoDate(automation.value, "nextRunAt") ??
    optionalIsoDate(automation.value, "lastRunAt") ??
    optionalLiteral(automation.value, "lastRunStatus", automationRunStatuses, `${fieldName}.lastRunStatus`) ??
    optionalBoolean(automation.value, "runInFlight");
  if (baseError) {
    return baseError;
  }

  return validateOptionalArray(
    automation.value.recentRuns,
    `${fieldName}.recentRuns`,
    validateAutomationRunSummary,
  );
}

function validateAutomationRunSummary(input: unknown, fieldName: string): string | null {
  const run = validateObject(input, fieldName);
  if (run.ok === false) {
    return run.error;
  }

  return (
    requireString(run.value, "runId") ??
    requireLiteral(run.value, "status", automationRunStatuses) ??
    optionalIsoDate(run.value, "startedAt") ??
    optionalIsoDate(run.value, "completedAt") ??
    optionalString(run.value, "blockedReason") ??
    optionalString(run.value, "summary")
  );
}

function validateCapabilityArray(input: unknown, fieldName: string): string | null {
  return validateStringLiteralArray(input, capabilities, fieldName);
}

function validateOptionalArray(
  input: unknown,
  fieldName: string,
  validateItem: (item: unknown, itemFieldName: string) => string | null,
): string | null {
  if (input === undefined) {
    return null;
  }
  if (!Array.isArray(input)) {
    return `${fieldName} must be an array`;
  }
  for (let index = 0; index < input.length; index += 1) {
    const error = validateItem(input[index], `${fieldName}.${index}`);
    if (error) {
      return error;
    }
  }
  return null;
}

function validateStringLiteralArray<const Values extends readonly string[]>(
  input: unknown,
  allowed: Values,
  fieldName: string,
): string | null {
  if (!Array.isArray(input)) {
    return `${fieldName} must be an array`;
  }

  for (const value of input) {
    if (!isOneOf(value, allowed)) {
      return `${fieldName} contains an unsupported value`;
    }
  }

  return null;
}

function validateStringArray(input: unknown, fieldName: string): string | null {
  if (!Array.isArray(input)) {
    return `${fieldName} must be an array`;
  }

  for (const value of input) {
    if (typeof value !== "string" || value.length === 0) {
      return `${fieldName} must contain only non-empty strings`;
    }
  }

  return null;
}

function validateObject(input: unknown, name: string): ObjectValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: `${name} must be an object` };
  }

  return { ok: true, value: input as Record<string, unknown> };
}

function requireString(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === "string" && record[field].length > 0 ? null : `${field} must be a non-empty string`;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || (typeof record[field] === "string" && record[field].length > 0)
    ? null
    : `${field} must be a non-empty string when provided`;
}

function requireBoolean(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === "boolean" ? null : `${field} must be a boolean`;
}

function optionalBoolean(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || typeof record[field] === "boolean"
    ? null
    : `${field} must be a boolean when provided`;
}

function requireArray(record: Record<string, unknown>, field: string): string | null {
  return Array.isArray(record[field]) ? null : `${field} must be an array`;
}

function requirePositiveInteger(record: Record<string, unknown>, field: string): string | null {
  return Number.isInteger(record[field]) && (record[field] as number) > 0 ? null : `${field} must be a positive integer`;
}

function requireNonNegativeInteger(record: Record<string, unknown>, field: string): string | null {
  return Number.isInteger(record[field]) && (record[field] as number) >= 0 ? null : `${field} must be a non-negative integer`;
}

function optionalNonNegativeInteger(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined ? null : requireNonNegativeInteger(record, field);
}

function optionalNullableNumber(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || record[field] === null || typeof record[field] === "number"
    ? null
    : `${field} must be a number or null when provided`;
}

function optionalNumberRecord(record: Record<string, unknown>, field: string): string | null {
  if (record[field] === undefined) {
    return null;
  }

  const object = validateObject(record[field], field);
  if (object.ok === false) {
    return object.error;
  }

  for (const [key, value] of Object.entries(object.value)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return `${field}.${key} must be a non-negative integer`;
    }
  }

  return null;
}

function requireIsoDate(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return `${field} must be an ISO 8601 timestamp`;
  }

  return null;
}

function optionalIsoDate(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined ? null : requireIsoDate(record, field);
}

function optionalNullableIsoDate(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || record[field] === null ? null : requireIsoDate(record, field);
}

function optionalNullablePercentage(record: Record<string, unknown>, field: string): string | null {
  if (record[field] === undefined || record[field] === null) {
    return null;
  }
  const value = record[field];
  return typeof value === "number" && value >= 0 && value <= 100 ? null : `${field} must be a percentage number or null when provided`;
}

function requireLiteral<const Values extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  allowed: Values,
): string | null {
  return isOneOf(record[field], allowed) ? null : `${field} must be one of: ${allowed.join(", ")}`;
}

function optionalLiteral<const Values extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  allowed: Values,
  fieldName: string,
): string | null {
  if (record[field] === undefined) {
    return null;
  }
  return isOneOf(record[field], allowed) ? null : `${fieldName} must be one of: ${allowed.join(", ")}`;
}

function optionalSnapshotCollections(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return `${field} must be an array of snapshot collections when provided`;
  }
  for (const entry of value) {
    if (!isOneOf(entry, mobileSnapshotCollections)) {
      return `${field} must contain only: ${mobileSnapshotCollections.join(", ")}`;
    }
  }
  return null;
}

function optionalNullableString(record: Record<string, unknown>, field: string): string | null {
  if (record[field] === undefined || record[field] === null) {
    return null;
  }
  return typeof record[field] === "string" && record[field].length > 0
    ? null
    : `${field} must be a non-empty string or null when provided`;
}

function requireLiteralNumber(record: Record<string, unknown>, field: string, expected: number): string | null {
  return record[field] === expected ? null : `${field} must be ${expected}`;
}

function isOneOf<const Values extends readonly string[]>(input: unknown, values: Values): input is Values[number] {
  return typeof input === "string" && values.includes(input);
}

function invalidPayload(message: string): ValidationResult<never> {
  return {
    ok: false,
    error: buildError("invalid_payload", message, false),
  };
}

function buildError(code: MobileControlErrorCode, message: string, retryable: boolean): MobileControlError {
  return {
    protocolVersion: mobileControlProtocolVersion,
    code,
    message,
    retryable,
  };
}
