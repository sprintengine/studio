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
  | "backlog.create"
  | "sprintengine.openPullRequest"
  | "sprintengine.setAutomationMode"
  | "automations.control";

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
  | "backlog.create"
  | "sprintengines.pr"
  | "sprintengines.automation"
  // Control the desktop's automations (src/main/automations). A SEPARATE
  // capability from `sprintengines.automation`, which is a false friend: that
  // one is a Sprint Engine RUN's automation mode — a different subsystem, a
  // different store. Reusing it would have handed every already-paired device
  // the power to fire agent runs on the desktop, a privilege nobody consented
  // to at pair time. Scopes are frozen at pairing, so this one is paid for with
  // a deliberate re-pair (relay scope `relay:automations:control`).
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

export type MobileControlWorkspaceKind = "sprintengine" | "switchboard" | "watchtower";

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

// Snapshot collections a `snapshot.request` may scope down to (item 1600).
// `desktopWorkspaces` is the switchboard/watchtower projections; it is
// the one collection absent from the default set, so a phone surface that wants
// those monitors must name it explicitly. The rest ship by default.
export const mobileSnapshotCollections = [
  "sprintEngines",
  "desktopWorkspaces",
  "backlog",
  "roleCatalogs",
  "automations",
] as const;
export type MobileSnapshotCollection = (typeof mobileSnapshotCollections)[number];

export type SnapshotRequestCommand = MobileControlCommandBase<
  "snapshot.request",
  {
    sprintEngineId?: string;
    /**
     * The `snapshotVersion` the client already holds. When it equals the
     * version the desktop would ship, `dispatchSnapshotRequest` skips the
     * payload and answers `{ ok: true, unchanged: true, snapshotVersion }`
     * (item 1599) — an If-None-Match on the read path. Additive and
     * old-client-safe: a client that omits it gets the full snapshot exactly
     * as before, so the protocol stays v2 with no re-pair.
     *
     * This is skip-on-match, the opposite of the base `expectedSnapshotVersion`
     * (a reject-on-mismatch mutation guard) — do not fold the two together.
     */
    knownSnapshotVersion?: string;
    /**
     * Scope the snapshot to a single project root (item 1600). The value is the
     * relay-safe workspace token the phone already holds as `projectKey` on every
     * collection (deriveWorkspaceId output); the desktop resolves it back to the
     * real root and returns only that root's sprint engines, backlog and
     * automations. Like `sprintEngineId`, a scoped request skips the size-shedding
     * ladder. Additive and old-client-safe.
     */
    workspacePath?: string;
    /**
     * Restrict the payload to these collections (item 1600) so a list screen can
     * skip the ones it does not render. Absent means the default set — sprint
     * engines, backlog, role catalogs and automations; `desktopWorkspaces`
     * (switchboard/watchtower) is off by default and ships only when
     * named here. Additive and old-client-safe.
     */
    include?: MobileSnapshotCollection[];
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

/**
 * Sprint configuration a phone may attach to either create command. Scope is
 * exactly what the desktop's CLI bootstrap path (`handover`) genuinely honors:
 * the team name and an explicit roster. Presence of `roleCounts` means the
 * user composed the roster; absence means the architect picks the team
 * (`rosterConfigured: false` engine-side). Automation mode, permission
 * presets, max-parallel, and workflow phases are desktop-app runner state the
 * main-process command path cannot reach — they stay on the
 * mobile-control-parity epic (MC-1497 et al.) and must not be added here
 * until a desktop honor path exists.
 *
 * Worktree mode is deliberately NOT here: only the backlog-start path
 * establishes it (see `BacklogStartSprintEngineCommand.useWorktrees`), so a
 * field on the shared config would be a knob that silently does nothing on
 * `sprintengine.create`.
 */
export interface SprintEngineCreateConfig {
  /** Engine-slugified; creating an existing team is rejected with a clear error. */
  teamName?: string;
  /** Role id → seat count (1–10). Role ids are validated by the engine's registry. */
  roleCounts?: Record<string, number>;
}

export type SprintEngineCreateCommand = MobileControlCommandBase<
  "sprintengine.create",
  {
    workspacePath: string;
    productPrompt: string;
    config?: SprintEngineCreateConfig;
  }
>;

export type TaskStartCommand = MobileControlCommandBase<
  "task.start",
  {
    sprintEngineId: string;
    taskId: string;
    role: string;
    /**
     * Deprecated and ignored: the desktop session orchestrator spawns every
     * mobile-started task in the current workspace and has no worktree
     * plumbing on this path. Clients send "preferred" for wire compatibility;
     * no UI offers the choice. Revisit when the desktop honors it.
     */
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

/**
 * Hand a backlog item to an agent team (MC-1493). Payload-only growth on purpose:
 * a NEW command type would need a new relay scope, and scopes are frozen at pair
 * time — the owner's phone would have to be re-paired. Extending this payload
 * needs none of that.
 */
export type BacklogStartSprintEngineCommand = MobileControlCommandBase<
  "backlog.startSprintEngine",
  {
    workspacePath: string;
    relativePath: string;
    config?: SprintEngineCreateConfig;
    /**
     * Work the item's whole epic: the desktop resolves every active leaf child
     * pointing up at this epic and seeds them as the run's source bundle, so the
     * architect plans across the epic rather than the container alone. Ignored
     * when the item is not an epic. Absent means the desktop decides — and it
     * launches an epic as an epic, which is what tapping an epic means.
     */
    epic?: boolean;
    /**
     * Run the team in one shared git worktree + branch. A non-worktree run has no
     * branch, so the engine refuses `vcs pr` on it outright — worktree mode is the
     * precondition for this command ever producing a pull request.
     *
     * Absent means the desktop decides: on wherever it is possible, off in a
     * workspace with no git repository at its root (there is nothing to branch
     * from, and failing the start there would be a pointless regression). An
     * explicit value always wins and is allowed to fail loudly.
     */
    useWorktrees?: boolean;
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

// Open (or return the existing) pull request for a completed worktree run
// (MC-1496). Idempotent: a second call returns the same URL without a second PR.
export type SprintEngineOpenPullRequestCommand = MobileControlCommandBase<
  "sprintengine.openPullRequest",
  {
    sprintEngineId: string;
  }
>;

// Set the run's three-state automation mode (MC-1497). The mode is the authority
// the desktop supervisor reads; the executor routes to the desktop session.
export type SprintEngineSetAutomationModeCommand = MobileControlCommandBase<
  "sprintengine.setAutomationMode",
  {
    sprintEngineId: string;
    mode: MobileControlAutomationMode;
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
  | ArtifactReadCommand
  | SprintEngineCreateCommand
  | TaskStartCommand
  | ArtifactApproveCommand
  | ArtifactRequestChangesCommand
  | AgentFollowUpCommand
  | DeviceRevokeCommand
  | BacklogUpdateCommand
  | BacklogStartSprintEngineCommand
  | BacklogCreateCommand
  | SprintEngineOpenPullRequestCommand
  | SprintEngineSetAutomationModeCommand
  | AutomationsControlCommand;

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

/**
 * The backlog item a task delivers (MC-2060). The engine's task record carries
 * `backlogRef: { projectRelativePath, displayKey? }`; this is the same pointer
 * under the wire's own vocabulary, so a reader joins `relativePath` straight to
 * `MobileControlBacklogItemSnapshot.relativePath`.
 *
 * MC-1848 made the referenced item the worker's canonical brief, so this is not
 * decoration — it is how a board task reaches its specification.
 *
 * Additive and old-client-safe: a phone that ignores it renders exactly as before.
 * The path is repo-relative and therefore relay-safe; no absolute path rides here.
 *
 * **Joining across collections uses `projectKey`, never `workspacePath`.**
 * `sanitizeMobileSnapshotForRelay` encodes each collection's path differently, so
 * a `sprintEngines[].workspacePath` and a `backlog[].workspacePath` for one repo
 * are not comparable — see the note on `MobileControlSprintEngineSnapshot.projectKey`.
 */
export interface MobileControlTaskBacklogRef {
  /** Repo-relative path of the backlog item, e.g. `backlog/2026-07-30-example.md`. */
  relativePath: string;
  /** The item's display id when it has one, e.g. `MC-2020`. */
  displayKey?: string;
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
  // Optional since MC-2057 (run schema v5, "roleless runs"), which made a task's
  // role optional in the engine and deleted the `general` role. It stayed
  // REQUIRED here for one release, and the snapshot producer met that contract by
  // substituting `'developer'` — so every roleless task, including the
  // coordinator seat's, reached the phone labelled Developer. A field that is
  // required but sometimes fabricated is worse than an optional one: nothing
  // downstream can tell the forged values from the real ones.
  //
  // Making it optional is additive and old-client-safe, so the wire stays v2 —
  // no re-pair, no new scope. A reader renders the ABSENCE (no glyph, no accent),
  // never a stand-in role, which would only restate the lie one shade quieter.
  role?: string;
  status: "todo" | "ready" | "in_progress" | "review" | "needs_input" | "done" | "canceled";
  ownerAgentId?: string;
  /** The backlog item this task delivers (MC-2060), when it names one. */
  backlogRef?: MobileControlTaskBacklogRef;
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

// The three-state Sprint Engine automation mode, mirroring the renderer's
// `SprintEngineAutomationMode` (renderer/src/types/workspace.ts). Carried on the
// snapshot so the phone control renders the truth; set by
// `sprintengine.setAutomationMode` (MC-1497).
export type MobileControlAutomationMode = "manual" | "run_agents" | "run_agents_and_approve_artifacts";

// One project a run works in, mirroring the engine's `vcs.repos` entry (MC-1613)
// trimmed to what a phone can render. Phone-shaped, like the vcs block below: run
// worktree paths, base refs and commit shas stay on the desktop, which is why this
// is not the engine's entry verbatim.
export interface MobileControlSprintEngineRepo {
  /** The project id the run declares and its tasks target: `primary`, or a name like `multicode-mobile`. */
  id: string;
  /** Workspace-relative project root: `.` for the primary project, `../multicode-mobile` for the rest. */
  root: string;
  /** The run branch in this project (every project of a run shares one branch name). */
  branch: string;
  /** This project's run-worktree state (`not_created` · `ready` · …); absent until the engine records one. */
  status?: string;
}

// Worktree / pull-request state for a run, mirroring the desktop `SprintEngineVcs`
// (renderer/src/types/workspace.ts). Present only for worktree runs; the phone
// uses it to decide "Open pull request" vs "View pull request" (MC-1496/MC-1498).
export interface MobileControlSprintEngineVcsState {
  /** True when the run executes on its own git worktree/branch. */
  worktree: boolean;
  /** The run branch, when a worktree has been initialized. */
  branch?: string;
  pullRequestUrl?: string;
  /** Merge/lifecycle state of the PR: open · merged · closed (from `pullRequestState`/`status`). */
  pullRequestStatus?: string;
  /** Reason the last PR-open attempt failed, surfaced with a Retry affordance. */
  pullRequestError?: string;
  /**
   * Every project a multi-repo run works in, the primary one first (MC-1613).
   *
   * Additive: the fields above keep describing the primary project, so a client
   * that never reads this list renders a two-project run exactly as it renders a
   * one-project run. Absent for single-repo runs — their one project IS the block
   * above — and absent from a desktop older than MC-1613, so a client that wants
   * the list reads `repos ?? [the primary block]` and handles both.
   */
  repos?: MobileControlSprintEngineRepo[];
}

// One "Started from" provenance row — a real on-disk seed document the run was
// launched from. Mirrors the desktop `SprintEngineSeedRow`
// (renderer .../sprintEngineStartedFrom.ts), trimmed to what the phone renders.
export interface MobileControlSprintEngineStartedFromRow {
  /** Project-relative on-disk path (read/previewed via `artifact.read`). */
  path: string;
  fileName: string;
  kindLabel: string;
  role: "primary" | "epic-child" | "supporting";
  isPrimary: boolean;
  /** ISO capture time, surfaced only for reference-mode rows. */
  capturedAt?: string;
  /** Project-relative `backlog/…` path when the row is a backlog item/epic child. */
  backlogPath?: string;
}

// The run's launch provenance (the desktop Inbox "Started from" section). Rows are
// capped at the desktop's "4 + show more" convention; bodies are fetched on
// demand, never shipped inline.
export interface MobileControlSprintEngineStartedFrom {
  /** True when the launch seed is a backlog epic (children nest under it). */
  epic: boolean;
  subtitle: string;
  rows: MobileControlSprintEngineStartedFromRow[];
  /** Rows omitted past the cap, for a "show N more on desktop" hint. */
  omitted?: number;
}

export interface MobileControlSprintEngineSnapshot {
  sprintEngineId: string;
  name: string;
  workspacePath: string;
  /**
   * The repo this record belongs to, as a relay-safe token (MC-1583).
   *
   * The one identifier the phone can join `workspaces`, `sprintEngines` and
   * `backlog` on. It exists because `workspacePath` cannot serve as that key:
   * `sanitizeMobileSnapshotForRelay` must strip absolute paths before they cross
   * the relay, and it necessarily encodes each collection's copy differently
   * (dropped / basename / token). Joining on it split one repo into two projects.
   * Absent from a desktop older than MC-1583 — callers fall back to the path.
   */
  projectKey?: string;
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
  /** Current automation mode (MC-1497), so the phone control renders the truth. */
  automationMode?: MobileControlAutomationMode;
  /** Worktree/PR state for the run (MC-1496/MC-1498); absent for non-worktree runs. */
  vcs?: MobileControlSprintEngineVcsState;
  /** Launch provenance — the "Started from" seed docs (MC-1498). */
  startedFrom?: MobileControlSprintEngineStartedFrom;
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

export type MobileControlWorkspaceDetail =
  | { kind: "sprintengine"; data: MobileControlSprintEngineWorkspaceDetail }
  | { kind: "switchboard"; data: MobileControlSwitchboardWorkspaceDetail }
  | { kind: "watchtower"; data: MobileControlWatchtowerWorkspaceDetail };

export interface MobileControlWorkspaceSnapshot {
  workspaceId: string;
  kind: MobileControlWorkspaceKind;
  name: string;
  workspacePath?: string;
  /** The repo this workspace belongs to. See MobileControlSprintEngineSnapshot.projectKey. */
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
  /**
   * The Sprint Engine run working this item, from its `execution` link. Keyed the
   * same as `MobileControlSprintEngineSnapshot.sprintEngineId`, so the phone can
   * join an item to its live run — and reach that run's board.
   */
  sprintEngineId?: string;
  /**
   * The pull request the item's run opened, from its `sprintengine.pullRequest`
   * link. A URL only: the relay's result-summary filter is fine with one, and no
   * diff content may ever ride this wire.
   *
   * PR *status* is deliberately not denormalized here — it lives on the run
   * (`MobileControlSprintEngineSnapshot.pullRequestStatus`), which is where it is
   * kept fresh. The phone joins on `sprintEngineId` rather than reading a copy
   * that would go stale the moment the PR merged.
   */
  pullRequestUrl?: string;
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

// Registry layer a role was resolved from, in the desktop's precedence order
// (workspace -> plugin -> user -> bundled). Deliberately widened with `string`:
// the desktop names a plugin layer `plugin:<id>`, and a client that hard-rejects
// an unrecognised layer would break the moment a new one is added. The phone
// groups on it at most; it never gates behaviour on it.
export type MobileControlRoleSource = "bundled" | "user" | "workspace" | "plugin" | (string & {});

// One role the desktop's Sprint Engine role registry resolved for a workspace
// (MC-1543). Roles are JSON manifests discovered at runtime across four layers,
// so the phone cannot know them ahead of a release — it has to be told. This is
// the picker's whole vocabulary: what to show, how to label it, and whether it
// is a fix-forward sweep. Directives, skills, and prompts are deliberately NOT
// here: the phone stages a roster, it does not compose an agent.
export interface MobileControlRoleDescriptor {
  /** Registry-resolved id — an open string, the key `roleCounts` is keyed by. */
  roleId: string;
  /** Manifest `label`. Always present; the producer humanizes a missing one. */
  label: string;
  /** Manifest `summary`, truncated to `sprintEngineRoleSummaryMaxChars`. */
  summary?: string;
  /** True when the manifest declares a `sweep` block (audits the finished work). */
  sweep?: boolean;
  /** Registry layer, for grouping and for showing "custom" provenance. */
  source?: MobileControlRoleSource;
}

export interface MobileControlBacklogWorkspaceSnapshot {
  workspaceId: string;
  workspacePath: string;
  /** The repo this backlog group belongs to. See MobileControlSprintEngineSnapshot.projectKey. */
  projectKey?: string;
  workspaceName: string;
  updatedAt: string;
  items: MobileControlBacklogItemSnapshot[];
  /** Epic metadata for the workspace's epics (MC-1498). */
  epics?: MobileControlBacklogEpicSnapshot[];
  // The workspace's resolved role registry (MC-1543), so the phone's sprint-launch
  // picker offers exactly the roles that workspace has — including user-, plugin-,
  // and workspace-authored ones it can't know at build time.
  //
  // It rides the *backlog* workspace because that is the record both launch
  // surfaces already key off: `sprintengine.create` and `backlog.startSprintEngine`
  // both carry a `workspacePath`, and both pick it from this list.
  //
  // ABSENT AND EMPTY MEAN DIFFERENT THINGS, and a reader must honour the
  // difference:
  //
  // - absent → unknown. The registry could not be read, the catalog was shed by
  //   the size ladder, or the desktop predates this field. A reader may fall back
  //   to a bundled list, and should say that it is doing so.
  // - `[]`   → known empty. The registry was read and this workspace has no roles.
  //   MC-1587 un-shipped the bundled role pack, so roles now come only from an
  //   installed pack or a user manifest, and having none is an ordinary state.
  //   A reader must NOT fall back here: those invented ids would become the run's
  //   `configuredRoles` (the legal role set `plan.add_task` enforces) and nothing
  //   would be able to staff them.
  roles?: MobileControlRoleDescriptor[];
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
  /** The repo this automation belongs to. See MobileControlSprintEngineSnapshot.projectKey. */
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
  lanes: MobileControlRoadmapLaneRider[];
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
  // Flat across the desktop's automations store, grouped by each entry's
  // `projectKey` the way `backlog` groups by repo. Capped by construction —
  // see `automationsPerProjectMax`.
  automations?: MobileControlAutomationSnapshot[];
  // Read-only roadmap progress riders (MC-1620), one per active roadmap. Additive
  // and omitted when there are none, so a phone that predates roadmaps is untouched.
  roadmaps?: MobileControlRoadmapRider[];
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
  "sprintengine.openPullRequest",
  "sprintengine.setAutomationMode",
  "automations.control",
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
  "sprintengines.pr",
  "sprintengines.automation",
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
const workspaceKinds = ["sprintengine", "switchboard", "watchtower"] as const;
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

export const sprintEngineTeamNameMaxChars = 64;
export const sprintEngineRoleCountMax = 10;
export const sprintEngineRosterMaxRoles = 12;

// Bounds on the published role catalog (MC-1543). The snapshot's only size-shedding
// pass drops whole sprint engines (src/main/mobile/bridge/snapshot-request.ts), so a
// catalog it cannot shed must stay small by construction or it eats the relay's
// result-summary budget. 15 bundled roles ship today; 48 leaves room for a
// well-stocked user/workspace registry, and a summary is a picker subtitle, not prose.
export const sprintEngineRoleCatalogMaxRoles = 48;
export const sprintEngineRoleSummaryMaxChars = 160;

// Bounds on the automations projection (item 47), for the same reason as the role
// catalog above: the shedding pass in src/main/mobile/bridge/snapshot-request.ts
// drops role catalogs and then whole sprint engines, and knows nothing about
// automations — so an unbounded automations collection cannot be shed and would
// eat the relay's result-summary budget out from under the runs it cannot drop.
// The producer enforces these; the wire types cannot.
export const automationsPerProjectMax = 24;
export const automationRecentRunsMax = 5;
export const automationRunTextMaxChars = 160;

// Shared by sprintengine.create and backlog.startSprintEngine: both bootstrap
// a team through the same desktop CLI path, so they carry the same config.
function validateSprintEngineCreateConfig(payload: Record<string, unknown>): string | null {
  const config = payload.config;
  if (config === undefined) {
    return null;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return "config must be an object";
  }

  const record = config as Record<string, unknown>;

  if (record.teamName !== undefined) {
    if (typeof record.teamName !== "string" || record.teamName.trim().length === 0) {
      return "config.teamName must be a non-empty string";
    }
    if (record.teamName.trim().length > sprintEngineTeamNameMaxChars) {
      return `config.teamName must be ${sprintEngineTeamNameMaxChars} characters or less`;
    }
  }

  if (record.roleCounts !== undefined) {
    if (typeof record.roleCounts !== "object" || record.roleCounts === null || Array.isArray(record.roleCounts)) {
      return "config.roleCounts must be an object of role id to seat count";
    }
    const entries = Object.entries(record.roleCounts as Record<string, unknown>);
    if (entries.length === 0) {
      return "config.roleCounts must name at least one role when present";
    }
    if (entries.length > sprintEngineRosterMaxRoles) {
      return `config.roleCounts must name ${sprintEngineRosterMaxRoles} roles or fewer`;
    }
    for (const [role, count] of entries) {
      if (role.trim().length === 0) {
        return "config.roleCounts role ids must be non-empty";
      }
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > sprintEngineRoleCountMax) {
        return `config.roleCounts values must be integers from 1 to ${sprintEngineRoleCountMax}`;
      }
    }
  }

  return null;
}

function validateCommandPayload(type: MobileControlCommandType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "snapshot.request":
      return (
        optionalString(payload, "sprintEngineId") ??
        optionalString(payload, "knownSnapshotVersion") ??
        optionalString(payload, "workspacePath") ??
        optionalSnapshotCollections(payload, "include")
      );
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
        // Tolerated for older clients; the desktop never read it.
        optionalString(payload, "requestedRole") ??
        validateSprintEngineCreateConfig(payload)
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
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "relativePath") ??
        optionalBoolean(payload, "epic") ??
        optionalBoolean(payload, "useWorktrees") ??
        validateSprintEngineCreateConfig(payload)
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
    case "sprintengine.openPullRequest":
      return requireString(payload, "sprintEngineId");
    case "sprintengine.setAutomationMode":
      return requireString(payload, "sprintEngineId") ?? requireLiteral(payload, "mode", automationModeValues);
    case "automations.control":
      return (
        requireString(payload, "workspacePath") ??
        requireString(payload, "automationId") ??
        requireLiteral(payload, "action", automationActionValues)
      );
  }
}

const automationModeValues = ["manual", "run_agents", "run_agents_and_approve_artifacts"] as const;

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
    // Optional since MC-2057 — see MobileControlTaskSnapshot.role. A desktop that
    // omits it is describing a roleless task, not sending a malformed snapshot.
    optionalString(task.value, "role") ??
    requireLiteral(task.value, "status", taskStatuses) ??
    optionalString(task.value, "ownerAgentId") ??
    validateOptionalTaskBacklogRef(task.value.backlogRef) ??
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

function validateOptionalTaskBacklogRef(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  const ref = validateObject(input, "task.backlogRef");
  if (ref.ok === false) {
    return ref.error;
  }
  // `relativePath` is required: a reference with only a display key points at
  // nothing this phone can open, and the engine normalizes that case away too.
  return requireString(ref.value, "relativePath") ?? optionalString(ref.value, "displayKey");
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
