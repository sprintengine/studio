export const mobileControlProtocolVersion = 2 as const;
export const mobileControlWorkspaceSnapshotVersion = 2 as const;

export type MobileControlProtocolVersion = typeof mobileControlProtocolVersion;
export type MobileControlWorkspaceSnapshotVersion = typeof mobileControlWorkspaceSnapshotVersion;

export type MobileControlCommandType =
  | "snapshot.request"
  | "artifact.read"
  | "sprintengine.create"
  | "task.start"
  | "artifact.approve"
  | "artifact.requestChanges"
  | "agent.followUp"
  | "device.revoke"
  | "backlog.update"
  | "backlog.startSprintEngine"
  | "backlog.create";

export type MobileControlEventType =
  | "snapshot.updated"
  | "command.accepted"
  | "command.rejected"
  | "device.presence"
  | "artifact.reviewUpdated"
  | "notification.created";

export type MobileControlCapability =
  | "snapshots.read"
  | "artifacts.read"
  | "sprintengines.create"
  | "tasks.start"
  | "artifacts.review"
  | "agents.followUp"
  | "devices.revoke"
  | "backlog.update"
  | "backlog.start"
  | "backlog.create";

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
  | "sprintengine_not_found"
  | "task_not_ready"
  | "artifact_not_found"
  | "path_not_allowed"
  | "snapshot_too_large"
  | "python_tool_failed"
  | "internal_error";

export type MobileNotificationCategory =
  | "artifact.ready"
  | "task.needs_input"
  | "command.failed"
  | "desktop.offline"
  | "sprintengine.complete";

export type MobileNotificationTarget =
  | { kind: "artifact"; sprintEngineId: string; artifactId: string }
  | { kind: "task"; sprintEngineId: string; taskId: string }
  | { kind: "sprintEngine"; sprintEngineId: string }
  | { kind: "command"; commandId: string; sprintEngineId?: string }
  | { kind: "desktop" };

export type MobileControlWorkspaceKind = "sprintengine" | "switchboard" | "watchtower" | "multiloop";

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
  artifactPreviewModes: ArtifactPreviewMode[];
  maxFollowUpCharacters: number;
  snapshotTtlMs: number;
}

export type MobileControlDevicePlatform = "ios" | "android" | "web";
export type ArtifactPreviewMode = "text" | "markdown" | "restrictedHtml";

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

export type SnapshotRequestCommand = MobileControlCommandBase<
  "snapshot.request",
  {
    sprintEngineId?: string;
  }
>;

export type ArtifactReadCommand = MobileControlCommandBase<
  "artifact.read",
  {
    sprintEngineId: string;
    artifactId: string;
    previewMode: ArtifactPreviewMode;
  }
>;

export type SprintEngineCreateCommand = MobileControlCommandBase<
  "sprintengine.create",
  {
    workspacePath: string;
    productPrompt: string;
    requestedRole?: string;
  }
>;

export type TaskStartCommand = MobileControlCommandBase<
  "task.start",
  {
    sprintEngineId: string;
    taskId: string;
    role: string;
    worktreeIsolation: "required" | "preferred" | "disabled";
  }
>;

export type ArtifactApproveCommand = MobileControlCommandBase<
  "artifact.approve",
  {
    sprintEngineId: string;
    artifactId: string;
    feedback?: string;
  }
>;

export type ArtifactRequestChangesCommand = MobileControlCommandBase<
  "artifact.requestChanges",
  {
    sprintEngineId: string;
    artifactId: string;
    feedback: string;
  }
>;

export type AgentFollowUpCommand = MobileControlCommandBase<
  "agent.followUp",
  {
    sprintEngineId: string;
    agentId: string;
    text: string;
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

export type BacklogStartSprintEngineCommand = MobileControlCommandBase<
  "backlog.startSprintEngine",
  {
    workspacePath: string;
    relativePath: string;
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

export type MobileControlCommand =
  | SnapshotRequestCommand
  | ArtifactReadCommand
  | SprintEngineCreateCommand
  | TaskStartCommand
  | ArtifactApproveCommand
  | ArtifactRequestChangesCommand
  | AgentFollowUpCommand
  | DeviceRevokeCommand
  | BacklogUpdateCommand
  | BacklogStartSprintEngineCommand
  | BacklogCreateCommand;

export type MobileControlNeedsInputKind = "architect" | "user" | "owner" | "external_validation";

export interface MobileControlTaskNeedsInput {
  kind?: MobileControlNeedsInputKind;
  reason?: string;
  question?: string;
  suggestedResolution?: string;
  artifactId?: string;
}

export interface MobileControlTaskEvidence {
  summary?: string;
  touchedFileCount?: number;
  commandCount?: number;
  resultCount?: number;
}

export interface MobileControlTaskFeedback {
  confidencePct?: number;
  hallucinationRiskPct?: number;
}

export interface MobileControlTaskReviewSignals {
  findingCount?: number;
  issueCount?: number;
  verdict?: string;
}

export interface MobileControlTaskRelease {
  requestedBy?: string;
  reason?: string;
}

export type MobileControlTaskCommentType =
  | "implementation_summary"
  | "implementation_response"
  | "review_feedback"
  | "test_feedback"
  | "product_feedback"
  | "architect_feedback"
  | "needs_input"
  | "user_note"
  | "system_note";

export interface MobileControlTaskCommentSummary {
  id: string;
  type?: MobileControlTaskCommentType;
  actor: string;
  authorRole?: string;
  body: string;
  createdAt?: string;
}

export interface MobileControlRecordedArtifactSummary {
  id: string;
  kind?: string;
  title?: string;
  path?: string;
  createdAt?: string;
}

export interface MobileControlTaskSnapshot {
  taskId: string;
  title: string;
  role: string;
  status: "todo" | "ready" | "in_progress" | "review" | "needs_input" | "done" | "canceled";
  ownerAgentId?: string;
  dependsOn: string[];
  needsInput?: MobileControlTaskNeedsInput;
  evidence?: MobileControlTaskEvidence;
  feedback?: MobileControlTaskFeedback;
  reviewSignals?: MobileControlTaskReviewSignals;
  release?: MobileControlTaskRelease;
  latestComments?: MobileControlTaskCommentSummary[];
  latestOpenFeedback?: MobileControlTaskCommentSummary[];
  recordedArtifacts?: MobileControlRecordedArtifactSummary[];
}

export interface MobileControlRosterEntry {
  role?: string;
  status?: string;
  currentTaskId?: string | null;
}

export interface MobileControlArtifactSnapshot {
  artifactId: string;
  title: string;
  kind: string;
  status: "draft" | "ready_for_review" | "approved" | "changes_requested";
  taskId?: string;
  path?: string;
}

export interface MobileControlSprintEngineLockReport {
  name: string;
  exists?: boolean;
  stale?: boolean;
  ageSeconds?: number | null;
}

export interface MobileControlSprintEngineLockWarning {
  name: string;
  message: string;
  ageSeconds?: number | null;
}

export interface MobileControlSprintEngineLockState {
  warnings?: MobileControlSprintEngineLockWarning[];
  locks?: MobileControlSprintEngineLockReport[];
}

export interface MobileControlSprintEngineActivityEntry {
  id?: string;
  type?: string;
  timestamp?: string;
  actor?: string;
  message?: string;
}

export interface MobileControlSprintEngineActivitySummary {
  count: number;
  latest?: MobileControlSprintEngineActivityEntry;
}

export interface MobileControlSprintEngineCounts {
  ready?: number;
  needsInput?: number;
}

export interface MobileControlSprintEngineSnapshot {
  sprintEngineId: string;
  name: string;
  workspacePath: string;
  statePath: string;
  planPath?: string;
  snapshotVersion: string;
  updatedAt: string;
  board: {
    todo: number;
    ready: number;
    inProgress: number;
    review: number;
    needsInput: number;
    done: number;
  };
  tasks: MobileControlTaskSnapshot[];
  artifacts: MobileControlArtifactSnapshot[];
  roster?: Record<string, MobileControlRosterEntry>;
  runSummary?: Record<string, string | number | boolean | null>;
  planReview?: Record<string, string | number | boolean | null>;
  /** Folder-store lock reports and stale-lock warnings. */
  locks?: MobileControlSprintEngineLockState;
  /** Latest projection activity entry plus total event count. */
  activity?: MobileControlSprintEngineActivitySummary;
  /** Headline counts mirrored from the projection's top-level counts block. */
  counts?: MobileControlSprintEngineCounts;
}

export interface MobileControlWorkspaceSummary {
  status: "idle" | "running" | "needs_input" | "blocked" | "complete" | "error" | "unknown";
  headline?: string;
  counts?: Record<string, number>;
}

export interface MobileControlSprintEngineWorkspaceDetail {
  sprintEngineId: string;
  snapshotVersion: string;
  board: MobileControlSprintEngineSnapshot["board"];
  roster?: Record<string, MobileControlRosterEntry>;
  runSummary?: Record<string, string | number | boolean | null>;
  planReview?: Record<string, string | number | boolean | null>;
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

export interface MobileControlMultiloopMilestoneSummary {
  milestoneId: string;
  title: string;
  status?: string;
  updatedAt?: string;
  linkedSprintEngineId?: string;
}

export interface MobileControlMultiloopBlockerSummary {
  blockerId: string;
  title: string;
  status?: string;
  updatedAt?: string;
}

export interface MobileControlMultiloopWorkspaceDetail {
  loopId?: string;
  milestoneCount?: number;
  blockerCount?: number;
  linkedSprintEngineId?: string;
  milestones?: MobileControlMultiloopMilestoneSummary[];
  blockers?: MobileControlMultiloopBlockerSummary[];
}

export type MobileControlWorkspaceDetail =
  | { kind: "sprintengine"; data: MobileControlSprintEngineWorkspaceDetail }
  | { kind: "switchboard"; data: MobileControlSwitchboardWorkspaceDetail }
  | { kind: "watchtower"; data: MobileControlWatchtowerWorkspaceDetail }
  | { kind: "multiloop"; data: MobileControlMultiloopWorkspaceDetail };

export interface MobileControlWorkspaceSnapshot {
  workspaceId: string;
  kind: MobileControlWorkspaceKind;
  name: string;
  workspacePath?: string;
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

export interface MobileControlBacklogWorkspaceSnapshot {
  workspaceId: string;
  workspacePath: string;
  workspaceName: string;
  updatedAt: string;
  items: MobileControlBacklogItemSnapshot[];
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
  sprintEngines: MobileControlSprintEngineSnapshot[];
  workspaces?: MobileControlWorkspaceSnapshot[];
  backlog?: MobileControlBacklogWorkspaceSnapshot[];
  snapshotLimits?: {
    sprintEngines?: {
      included: number;
      omitted: number;
      total: number;
      reason: "relay_result_summary_size";
    };
  };
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

export type ArtifactReviewUpdatedEvent = MobileControlEventBase<
  "artifact.reviewUpdated",
  {
    sprintEngineId: string;
    artifactId: string;
    status: MobileControlArtifactSnapshot["status"];
  }
>;

export type NotificationCreatedEvent = MobileControlEventBase<
  "notification.created",
  {
    category: MobileNotificationCategory;
    sprintEngineId?: string;
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
  | ArtifactReviewUpdatedEvent
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
  "artifact.read",
  "sprintengine.create",
  "task.start",
  "artifact.approve",
  "artifact.requestChanges",
  "agent.followUp",
  "device.revoke",
  "backlog.update",
  "backlog.startSprintEngine",
  "backlog.create",
] as const satisfies readonly MobileControlCommandType[];

const eventTypes = [
  "snapshot.updated",
  "command.accepted",
  "command.rejected",
  "device.presence",
  "artifact.reviewUpdated",
  "notification.created",
] as const satisfies readonly MobileControlEventType[];

const capabilities = [
  "snapshots.read",
  "artifacts.read",
  "sprintengines.create",
  "tasks.start",
  "artifacts.review",
  "agents.followUp",
  "devices.revoke",
  "backlog.update",
  "backlog.start",
  "backlog.create",
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
  "sprintengine_not_found",
  "task_not_ready",
  "artifact_not_found",
  "path_not_allowed",
  "snapshot_too_large",
  "python_tool_failed",
  "internal_error",
] as const satisfies readonly MobileControlErrorCode[];

const artifactPreviewModes = ["text", "markdown", "restrictedHtml"] as const satisfies readonly ArtifactPreviewMode[];
const devicePlatforms = ["ios", "android", "web"] as const satisfies readonly MobileControlDevicePlatform[];
const taskStatuses = ["todo", "ready", "in_progress", "review", "needs_input", "done", "canceled"] as const;
const artifactStatuses = ["draft", "ready_for_review", "approved", "changes_requested"] as const;
const taskCommentTypes = [
  "implementation_summary",
  "implementation_response",
  "review_feedback",
  "test_feedback",
  "product_feedback",
  "architect_feedback",
  "needs_input",
  "user_note",
  "system_note",
] as const satisfies readonly MobileControlTaskCommentType[];
const presenceValues = ["online", "offline", "revoked"] as const;
const severityValues = ["info", "warning", "error"] as const;
const worktreeIsolationValues = ["required", "preferred", "disabled"] as const;
const workspaceKinds = ["sprintengine", "switchboard", "watchtower", "multiloop"] as const;
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
  "artifact.ready",
  "task.needs_input",
  "command.failed",
  "desktop.offline",
  "sprintengine.complete",
] as const satisfies readonly MobileNotificationCategory[];
const notificationTargetKinds = ["artifact", "task", "sprintEngine", "command", "desktop"] as const;
const needsInputKinds = ["architect", "user", "owner", "external_validation"] as const satisfies readonly MobileControlNeedsInputKind[];

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

  const versionError = validateProtocolVersion(event.value);
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

  const versionError = validateProtocolVersion(snapshot.value);
  if (versionError) {
    return versionError;
  }

  const baseError =
    requireString(snapshot.value, "generatedAt") ??
    requireIsoDate(snapshot.value, "generatedAt") ??
    requireString(snapshot.value, "desktopSessionId") ??
    optionalString(snapshot.value, "snapshotVersion") ??
    requireArray(snapshot.value, "sprintEngines");
  if (baseError) {
    return invalidPayload(baseError);
  }

  for (const sprintEngine of snapshot.value.sprintEngines as unknown[]) {
    const error = validateSprintEngineSnapshot(sprintEngine);
    if (error) {
      return invalidPayload(error);
    }
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
    requireArray(contract.value, "artifactPreviewModes") ??
    requirePositiveInteger(contract.value, "maxFollowUpCharacters") ??
    requirePositiveInteger(contract.value, "snapshotTtlMs");
  if (baseError) {
    return invalidPayload(baseError);
  }

  const commandError = validateStringLiteralArray(contract.value.commands, commandTypes, "capabilities.commands");
  const capabilityError = validateCapabilityArray(contract.value.capabilities, "capabilities.capabilities");
  const previewModeError = validateStringLiteralArray(
    contract.value.artifactPreviewModes,
    artifactPreviewModes,
    "capabilities.artifactPreviewModes",
  );
  const error = commandError ?? capabilityError ?? previewModeError;
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

function validateProtocolVersion(record: Record<string, unknown>): ValidationResult<never> | null {
  if (record.protocolVersion !== mobileControlProtocolVersion) {
    return {
      ok: false,
      error: buildError(
        "unsupported_protocol_version",
        `mobile-control protocol version must be ${mobileControlProtocolVersion}`,
        false,
      ),
    };
  }

  return null;
}

function validateCommandPayload(type: MobileControlCommandType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "snapshot.request":
      return optionalString(payload, "sprintEngineId");
    case "artifact.read":
      return (
        requireString(payload, "sprintEngineId") ??
        requireString(payload, "artifactId") ??
        requireLiteral(payload, "previewMode", artifactPreviewModes)
      );
    case "sprintengine.create":
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "productPrompt") ??
        optionalString(payload, "requestedRole")
      );
    case "task.start":
      return (
        requireString(payload, "sprintEngineId") ??
        requireString(payload, "taskId") ??
        requireString(payload, "role") ??
        requireLiteral(payload, "worktreeIsolation", worktreeIsolationValues)
      );
    case "artifact.approve":
      return requireString(payload, "sprintEngineId") ?? requireString(payload, "artifactId") ?? optionalString(payload, "feedback");
    case "artifact.requestChanges":
      return requireString(payload, "sprintEngineId") ?? requireString(payload, "artifactId") ?? requireString(payload, "feedback");
    case "agent.followUp":
      return requireString(payload, "sprintEngineId") ?? requireString(payload, "agentId") ?? requireString(payload, "text");
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
    case "backlog.startSprintEngine":
      return requireString(payload, "workspacePath") ?? requireString(payload, "relativePath");
    case "backlog.create":
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "title") ??
        optionalString(payload, "description") ??
        optionalString(payload, "type") ??
        optionalString(payload, "difficulty") ??
        optionalString(payload, "criticality")
      );
  }
}

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
    case "artifact.reviewUpdated":
      return (
        requireString(payload, "sprintEngineId") ??
        requireString(payload, "artifactId") ??
        requireLiteral(payload, "status", artifactStatuses)
      );
    case "notification.created":
      return (
        requireLiteral(payload, "category", notificationCategories) ??
        optionalString(payload, "sprintEngineId") ??
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
    case "artifact":
      return requireString(target.value, "sprintEngineId") ?? requireString(target.value, "artifactId");
    case "task":
      return requireString(target.value, "sprintEngineId") ?? requireString(target.value, "taskId");
    case "sprintEngine":
      return requireString(target.value, "sprintEngineId");
    case "command":
      return requireString(target.value, "commandId") ?? optionalString(target.value, "sprintEngineId");
    case "desktop":
      return null;
  }

  return "notification.target.kind must be a supported notification target";
}

function validateSprintEngineSnapshot(input: unknown): string | null {
  const sprintEngine = validateObject(input, "snapshot.sprintEngine");
  if (sprintEngine.ok === false) {
    return sprintEngine.error;
  }

  const baseError =
    requireString(sprintEngine.value, "sprintEngineId") ??
    requireString(sprintEngine.value, "name") ??
    requireString(sprintEngine.value, "workspacePath") ??
    requireString(sprintEngine.value, "statePath") ??
    optionalString(sprintEngine.value, "planPath") ??
    requireString(sprintEngine.value, "snapshotVersion") ??
    requireString(sprintEngine.value, "updatedAt") ??
    requireIsoDate(sprintEngine.value, "updatedAt") ??
    requireArray(sprintEngine.value, "tasks") ??
    requireArray(sprintEngine.value, "artifacts");
  if (baseError) {
    return baseError;
  }

  const board = validateObject(sprintEngine.value.board, "sprintEngine.board");
  if (board.ok === false) {
    return board.error;
  }

  const boardError =
    requireNonNegativeInteger(board.value, "todo") ??
    requireNonNegativeInteger(board.value, "ready") ??
    requireNonNegativeInteger(board.value, "inProgress") ??
    requireNonNegativeInteger(board.value, "review") ??
    requireNonNegativeInteger(board.value, "needsInput") ??
    requireNonNegativeInteger(board.value, "done");
  if (boardError) {
    return boardError;
  }

  for (const task of sprintEngine.value.tasks as unknown[]) {
    const taskError = validateTaskSnapshot(task);
    if (taskError) {
      return taskError;
    }
  }

  for (const artifact of sprintEngine.value.artifacts as unknown[]) {
    const artifactError = validateArtifactSnapshot(artifact);
    if (artifactError) {
      return artifactError;
    }
  }

  return (
    validateOptionalRoster(sprintEngine.value.roster, "snapshot.sprintEngine.roster") ??
    validateOptionalRecordSummary(sprintEngine.value.runSummary, "snapshot.sprintEngine.runSummary") ??
    validateOptionalRecordSummary(sprintEngine.value.planReview, "snapshot.sprintEngine.planReview") ??
    validateOptionalLockState(sprintEngine.value.locks, "snapshot.sprintEngine.locks") ??
    validateOptionalActivitySummary(sprintEngine.value.activity, "snapshot.sprintEngine.activity") ??
    validateOptionalProjectionCounts(sprintEngine.value.counts, "snapshot.sprintEngine.counts")
  );
}

function validateOptionalLockState(input: unknown, fieldName: string): string | null {
  if (input === undefined) {
    return null;
  }
  const lockState = validateObject(input, fieldName);
  if (lockState.ok === false) {
    return lockState.error;
  }
  if (lockState.value.locks !== undefined) {
    const locksError = requireArray(lockState.value, "locks");
    if (locksError) return `${fieldName}.${locksError}`;
    for (const [index, entry] of (lockState.value.locks as unknown[]).entries()) {
      const lockReport = validateObject(entry, `${fieldName}.locks[${index}]`);
      if (lockReport.ok === false) return lockReport.error;
      const reportError =
        requireString(lockReport.value, "name") ??
        optionalNullableNumber(lockReport.value, "ageSeconds");
      if (reportError) return `${fieldName}.locks[${index}].${reportError}`;
    }
  }
  if (lockState.value.warnings !== undefined) {
    const warningsError = requireArray(lockState.value, "warnings");
    if (warningsError) return `${fieldName}.${warningsError}`;
    for (const [index, entry] of (lockState.value.warnings as unknown[]).entries()) {
      const warning = validateObject(entry, `${fieldName}.warnings[${index}]`);
      if (warning.ok === false) return warning.error;
      const warningError =
        requireString(warning.value, "name") ??
        requireString(warning.value, "message") ??
        optionalNullableNumber(warning.value, "ageSeconds");
      if (warningError) return `${fieldName}.warnings[${index}].${warningError}`;
    }
  }
  return null;
}

function validateOptionalActivitySummary(input: unknown, fieldName: string): string | null {
  if (input === undefined) {
    return null;
  }
  const summary = validateObject(input, fieldName);
  if (summary.ok === false) {
    return summary.error;
  }
  const summaryError = requireNonNegativeInteger(summary.value, "count");
  if (summaryError) return `${fieldName}.${summaryError}`;
  if (summary.value.latest === undefined) return null;
  const latest = validateObject(summary.value.latest, `${fieldName}.latest`);
  if (latest.ok === false) return latest.error;
  return (
    optionalString(latest.value, "id") ??
    optionalString(latest.value, "type") ??
    optionalString(latest.value, "timestamp") ??
    optionalString(latest.value, "actor") ??
    optionalString(latest.value, "message")
  );
}

function validateOptionalProjectionCounts(input: unknown, fieldName: string): string | null {
  if (input === undefined) {
    return null;
  }
  const counts = validateObject(input, fieldName);
  if (counts.ok === false) {
    return counts.error;
  }
  const readyError = counts.value.ready === undefined ? null : requireNonNegativeInteger(counts.value, "ready");
  if (readyError) return `${fieldName}.${readyError}`;
  const needsInputError = counts.value.needsInput === undefined ? null : requireNonNegativeInteger(counts.value, "needsInput");
  if (needsInputError) return `${fieldName}.${needsInputError}`;
  return null;
}

function validateOptionalRoster(input: unknown, fieldName: string): string | null {
  if (input === undefined) {
    return null;
  }
  const roster = validateObject(input, fieldName);
  if (roster.ok === false) {
    return roster.error;
  }
  for (const [agentId, value] of Object.entries(roster.value)) {
    const entry = validateObject(value, `${fieldName}.${agentId}`);
    if (entry.ok === false) {
      return entry.error;
    }
    const entryError =
      optionalString(entry.value, "role") ??
      optionalString(entry.value, "status") ??
      optionalNullableString(entry.value, "currentTaskId");
    if (entryError) {
      return `${fieldName}.${agentId}.${entryError}`;
    }
  }
  return null;
}

function validateOptionalRecordSummary(input: unknown, fieldName: string): string | null {
  if (input === undefined) {
    return null;
  }
  const record = validateObject(input, fieldName);
  if (record.ok === false) {
    return record.error;
  }
  for (const [key, value] of Object.entries(record.value)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) {
      return `${fieldName}.${key} must be a string, number, boolean, or null`;
    }
  }
  return null;
}

function validateTaskSnapshot(input: unknown): string | null {
  const task = validateObject(input, "snapshot.task");
  if (task.ok === false) {
    return task.error;
  }

  return (
    requireString(task.value, "taskId") ??
    requireString(task.value, "title") ??
    requireString(task.value, "role") ??
    requireLiteral(task.value, "status", taskStatuses) ??
    optionalString(task.value, "ownerAgentId") ??
    requireArray(task.value, "dependsOn") ??
    validateStringArray(task.value.dependsOn, "task.dependsOn") ??
    validateOptionalNeedsInput(task.value.needsInput) ??
    validateOptionalTaskEvidence(task.value.evidence) ??
    validateOptionalTaskFeedback(task.value.feedback) ??
    validateOptionalReviewSignals(task.value.reviewSignals) ??
    validateOptionalTaskRelease(task.value.release) ??
    validateOptionalArray(task.value.latestComments, "task.latestComments", validateTaskCommentSummary) ??
    validateOptionalArray(task.value.latestOpenFeedback, "task.latestOpenFeedback", validateTaskCommentSummary) ??
    validateOptionalArray(task.value.recordedArtifacts, "task.recordedArtifacts", validateRecordedArtifactSummary)
  );
}

function validateOptionalNeedsInput(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  const needsInput = validateObject(input, "task.needsInput");
  if (needsInput.ok === false) {
    return needsInput.error;
  }
  return (
    optionalLiteral(needsInput.value, "kind", needsInputKinds, "task.needsInput.kind") ??
    optionalString(needsInput.value, "reason") ??
    optionalString(needsInput.value, "question") ??
    optionalString(needsInput.value, "suggestedResolution") ??
    optionalString(needsInput.value, "artifactId")
  );
}

function validateOptionalTaskEvidence(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  const evidence = validateObject(input, "task.evidence");
  if (evidence.ok === false) {
    return evidence.error;
  }
  return (
    optionalString(evidence.value, "summary") ??
    optionalNonNegativeInteger(evidence.value, "touchedFileCount") ??
    optionalNonNegativeInteger(evidence.value, "commandCount") ??
    optionalNonNegativeInteger(evidence.value, "resultCount")
  );
}

function validateOptionalTaskFeedback(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  const feedback = validateObject(input, "task.feedback");
  if (feedback.ok === false) {
    return feedback.error;
  }
  return (
    optionalPercentage(feedback.value, "confidencePct") ??
    optionalPercentage(feedback.value, "hallucinationRiskPct")
  );
}

function validateOptionalReviewSignals(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  const review = validateObject(input, "task.reviewSignals");
  if (review.ok === false) {
    return review.error;
  }
  return (
    optionalNonNegativeInteger(review.value, "findingCount") ??
    optionalNonNegativeInteger(review.value, "issueCount") ??
    optionalString(review.value, "verdict")
  );
}

function validateOptionalTaskRelease(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  const release = validateObject(input, "task.release");
  if (release.ok === false) {
    return release.error;
  }
  return optionalString(release.value, "requestedBy") ?? optionalString(release.value, "reason");
}

function validateTaskCommentSummary(input: unknown, fieldName: string): string | null {
  const comment = validateObject(input, fieldName);
  if (comment.ok === false) {
    return comment.error;
  }
  return (
    requireString(comment.value, "id") ??
    optionalLiteral(comment.value, "type", taskCommentTypes, `${fieldName}.type`) ??
    requireString(comment.value, "actor") ??
    optionalString(comment.value, "authorRole") ??
    requireString(comment.value, "body") ??
    optionalIsoDate(comment.value, "createdAt")
  );
}

function validateRecordedArtifactSummary(input: unknown, fieldName: string): string | null {
  const artifact = validateObject(input, fieldName);
  if (artifact.ok === false) {
    return artifact.error;
  }
  return (
    requireString(artifact.value, "id") ??
    optionalString(artifact.value, "kind") ??
    optionalString(artifact.value, "title") ??
    optionalString(artifact.value, "path") ??
    optionalIsoDate(artifact.value, "createdAt")
  );
}

function validateArtifactSnapshot(input: unknown): string | null {
  const artifact = validateObject(input, "snapshot.artifact");
  if (artifact.ok === false) {
    return artifact.error;
  }

  return (
    requireString(artifact.value, "artifactId") ??
    requireString(artifact.value, "title") ??
    requireString(artifact.value, "kind") ??
    requireLiteral(artifact.value, "status", artifactStatuses) ??
    optionalString(artifact.value, "taskId") ??
    optionalString(artifact.value, "path")
  );
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
    case "sprintengine": {
      const board = validateObject(data.value.board, "workspace.detail.data.board");
      if (board.ok === false) {
        return board.error;
      }
      return (
        requireString(data.value, "sprintEngineId") ??
        requireString(data.value, "snapshotVersion") ??
        validateBoardCounts(board.value, "workspace.detail.data.board") ??
        validateOptionalRoster(data.value.roster, "workspace.detail.data.roster") ??
        validateOptionalRecordSummary(data.value.runSummary, "workspace.detail.data.runSummary") ??
        validateOptionalRecordSummary(data.value.planReview, "workspace.detail.data.planReview")
      );
    }
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
    case "multiloop":
      return (
        optionalString(data.value, "loopId") ??
        optionalNonNegativeInteger(data.value, "milestoneCount") ??
        optionalNonNegativeInteger(data.value, "blockerCount") ??
        optionalString(data.value, "linkedSprintEngineId") ??
        validateOptionalArray(data.value.milestones, "workspace.detail.data.milestones", validateMultiloopMilestoneSummary) ??
        validateOptionalArray(data.value.blockers, "workspace.detail.data.blockers", validateMultiloopBlockerSummary)
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

function validateMultiloopMilestoneSummary(input: unknown, fieldName: string): string | null {
  const milestone = validateObject(input, fieldName);
  if (milestone.ok === false) {
    return milestone.error;
  }
  return (
    requireString(milestone.value, "milestoneId") ??
    requireString(milestone.value, "title") ??
    optionalString(milestone.value, "status") ??
    optionalIsoDate(milestone.value, "updatedAt") ??
    optionalString(milestone.value, "linkedSprintEngineId")
  );
}

function validateMultiloopBlockerSummary(input: unknown, fieldName: string): string | null {
  const blocker = validateObject(input, fieldName);
  if (blocker.ok === false) {
    return blocker.error;
  }
  return (
    requireString(blocker.value, "blockerId") ??
    requireString(blocker.value, "title") ??
    optionalString(blocker.value, "status") ??
    optionalIsoDate(blocker.value, "updatedAt")
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

function optionalPercentage(record: Record<string, unknown>, field: string): string | null {
  if (record[field] === undefined) {
    return null;
  }
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? null
    : `${field} must be a number between 0 and 100 when provided`;
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

function validateBoardCounts(board: Record<string, unknown>, fieldName: string): string | null {
  return (
    requireNonNegativeInteger(board, "todo") ??
    requireNonNegativeInteger(board, "ready") ??
    requireNonNegativeInteger(board, "inProgress") ??
    requireNonNegativeInteger(board, "review") ??
    requireNonNegativeInteger(board, "needsInput") ??
    requireNonNegativeInteger(board, "done")
  )?.replace(/^/, `${fieldName}.`) ?? null;
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
