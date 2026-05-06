export const mobileControlProtocolVersion = 1 as const;

export type MobileControlProtocolVersion = typeof mobileControlProtocolVersion;

export type MobileControlCommandType =
  | "snapshot.request"
  | "artifact.read"
  | "sprintengine.create"
  | "task.start"
  | "artifact.approve"
  | "artifact.requestChanges"
  | "agent.followUp"
  | "device.revoke";

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
  | "swarms.create"
  | "tasks.start"
  | "artifacts.review"
  | "agents.followUp"
  | "devices.revoke";

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
  | "swarm_not_found"
  | "task_not_ready"
  | "artifact_not_found"
  | "path_not_allowed"
  | "python_tool_failed"
  | "internal_error";

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
    swarmId?: string;
  }
>;

export type ArtifactReadCommand = MobileControlCommandBase<
  "artifact.read",
  {
    swarmId: string;
    artifactId: string;
    previewMode: ArtifactPreviewMode;
  }
>;

export type SwarmCreateCommand = MobileControlCommandBase<
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
    swarmId: string;
    taskId: string;
    role: string;
  }
>;

export type ArtifactApproveCommand = MobileControlCommandBase<
  "artifact.approve",
  {
    swarmId: string;
    artifactId: string;
    feedback?: string;
  }
>;

export type ArtifactRequestChangesCommand = MobileControlCommandBase<
  "artifact.requestChanges",
  {
    swarmId: string;
    artifactId: string;
    feedback: string;
  }
>;

export type AgentFollowUpCommand = MobileControlCommandBase<
  "agent.followUp",
  {
    swarmId: string;
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

export type MobileControlCommand =
  | SnapshotRequestCommand
  | ArtifactReadCommand
  | SwarmCreateCommand
  | TaskStartCommand
  | ArtifactApproveCommand
  | ArtifactRequestChangesCommand
  | AgentFollowUpCommand
  | DeviceRevokeCommand;

export interface MobileControlTaskSnapshot {
  taskId: string;
  title: string;
  role: string;
  status: "todo" | "ready" | "in_progress" | "needs_input" | "blocked" | "done";
  ownerAgentId?: string;
  dependsOn: string[];
}

export interface MobileControlArtifactSnapshot {
  artifactId: string;
  title: string;
  kind: string;
  status: "draft" | "ready_for_review" | "approved" | "changes_requested";
  taskId?: string;
  path?: string;
}

export interface MobileControlSwarmSnapshot {
  swarmId: string;
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
    needsInput: number;
    blocked: number;
    done: number;
  };
  tasks: MobileControlTaskSnapshot[];
  artifacts: MobileControlArtifactSnapshot[];
}

export interface MobileControlSnapshot {
  protocolVersion: MobileControlProtocolVersion;
  generatedAt: string;
  desktopSessionId: string;
  swarms: MobileControlSwarmSnapshot[];
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
    swarmId: string;
    artifactId: string;
    status: MobileControlArtifactSnapshot["status"];
  }
>;

export type NotificationCreatedEvent = MobileControlEventBase<
  "notification.created",
  {
    swarmId?: string;
    title: string;
    body: string;
    severity: "info" | "warning" | "error";
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
  "swarms.create",
  "tasks.start",
  "artifacts.review",
  "agents.followUp",
  "devices.revoke",
] as const satisfies readonly MobileControlCapability[];

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
  "swarm_not_found",
  "task_not_ready",
  "artifact_not_found",
  "path_not_allowed",
  "python_tool_failed",
  "internal_error",
] as const satisfies readonly MobileControlErrorCode[];

const artifactPreviewModes = ["text", "markdown", "restrictedHtml"] as const satisfies readonly ArtifactPreviewMode[];
const devicePlatforms = ["ios", "android", "web"] as const satisfies readonly MobileControlDevicePlatform[];
const taskStatuses = ["todo", "ready", "in_progress", "needs_input", "blocked", "done"] as const;
const artifactStatuses = ["draft", "ready_for_review", "approved", "changes_requested"] as const;
const presenceValues = ["online", "offline", "revoked"] as const;
const severityValues = ["info", "warning", "error"] as const;

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
    requireArray(snapshot.value, "swarms");
  if (baseError) {
    return invalidPayload(baseError);
  }

  for (const sprintengine of snapshot.value.swarms as unknown[]) {
    const error = validateSwarmSnapshot(sprintengine);
    if (error) {
      return invalidPayload(error);
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
      return optionalString(payload, "swarmId");
    case "artifact.read":
      return (
        requireString(payload, "swarmId") ??
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
        requireString(payload, "swarmId") ??
        requireString(payload, "taskId") ??
        requireString(payload, "role")
      );
    case "artifact.approve":
      return requireString(payload, "swarmId") ?? requireString(payload, "artifactId") ?? optionalString(payload, "feedback");
    case "artifact.requestChanges":
      return requireString(payload, "swarmId") ?? requireString(payload, "artifactId") ?? requireString(payload, "feedback");
    case "agent.followUp":
      return requireString(payload, "swarmId") ?? requireString(payload, "agentId") ?? requireString(payload, "text");
    case "device.revoke":
      return requireString(payload, "deviceId") ?? optionalString(payload, "reason");
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
        requireString(payload, "swarmId") ??
        requireString(payload, "artifactId") ??
        requireLiteral(payload, "status", artifactStatuses)
      );
    case "notification.created":
      return (
        optionalString(payload, "swarmId") ??
        requireString(payload, "title") ??
        requireString(payload, "body") ??
        requireLiteral(payload, "severity", severityValues)
      );
  }
}

function validateSwarmSnapshot(input: unknown): string | null {
  const sprintengine = validateObject(input, "snapshot.sprintengine");
  if (sprintengine.ok === false) {
    return sprintengine.error;
  }

  const baseError =
    requireString(sprintengine.value, "swarmId") ??
    requireString(sprintengine.value, "name") ??
    requireString(sprintengine.value, "workspacePath") ??
    requireString(sprintengine.value, "statePath") ??
    optionalString(sprintengine.value, "planPath") ??
    requireString(sprintengine.value, "snapshotVersion") ??
    requireString(sprintengine.value, "updatedAt") ??
    requireIsoDate(sprintengine.value, "updatedAt") ??
    requireArray(sprintengine.value, "tasks") ??
    requireArray(sprintengine.value, "artifacts");
  if (baseError) {
    return baseError;
  }

  const board = validateObject(sprintengine.value.board, "sprintengine.board");
  if (board.ok === false) {
    return board.error;
  }

  const boardError =
    requireNonNegativeInteger(board.value, "todo") ??
    requireNonNegativeInteger(board.value, "ready") ??
    requireNonNegativeInteger(board.value, "inProgress") ??
    requireNonNegativeInteger(board.value, "needsInput") ??
    requireNonNegativeInteger(board.value, "blocked") ??
    requireNonNegativeInteger(board.value, "done");
  if (boardError) {
    return boardError;
  }

  for (const task of sprintengine.value.tasks as unknown[]) {
    const taskError = validateTaskSnapshot(task);
    if (taskError) {
      return taskError;
    }
  }

  for (const artifact of sprintengine.value.artifacts as unknown[]) {
    const artifactError = validateArtifactSnapshot(artifact);
    if (artifactError) {
      return artifactError;
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
    validateStringArray(task.value.dependsOn, "task.dependsOn")
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

function validateCapabilityArray(input: unknown, fieldName: string): string | null {
  return validateStringLiteralArray(input, capabilities, fieldName);
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

function requireLiteral<const Values extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  allowed: Values,
): string | null {
  return isOneOf(record[field], allowed) ? null : `${field} must be one of: ${allowed.join(", ")}`;
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
