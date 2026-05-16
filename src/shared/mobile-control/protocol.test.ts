import assert from "node:assert/strict";
import {
  mobileControlProtocolVersion,
  mobileControlWorkspaceSnapshotVersion,
  validateMobileControlCapabilities,
  validateMobileControlCommand,
  validateMobileControlDevice,
  validateMobileControlError,
  validateMobileControlEvent,
  validateMobileControlSnapshot,
  type MobileControlCommand,
  type MobileControlSnapshot,
} from "./protocol";

const now = "2026-04-28T19:00:00.000Z";

const validCommand: MobileControlCommand = {
  protocolVersion: mobileControlProtocolVersion,
  commandId: "cmd_1",
  type: "artifact.requestChanges",
  issuedAt: now,
  deviceId: "device_1",
  idempotencyKey: "mobile:device_1:cmd_1",
  expectedSnapshotVersion: "snap_1",
  payload: {
    sprintEngineId: "mobile-sprintengine-companion-integration",
    artifactId: "A1",
    feedback: "Clarify the acceptance criteria.",
  },
};

const validSnapshot: MobileControlSnapshot = {
  protocolVersion: mobileControlProtocolVersion,
  generatedAt: now,
  desktopSessionId: "desktop_session_1",
  snapshotVersion: "snap_root_1",
  commands: [
    "snapshot.request",
    "artifact.read",
    "sprintengine.create",
    "task.start",
    "artifact.approve",
    "artifact.requestChanges",
    "agent.followUp",
    "device.revoke",
  ],
  sprintEngines: [
    {
      sprintEngineId: "mobile-sprintengine-companion-integration",
      name: "Mobile Sprint Engine Companion Integration",
      workspacePath: "/workspace/multicode",
      statePath: "/workspace/multicode/.multi-code/sprintengine/state.yaml",
      planPath: "/workspace/multicode/.multi-code/sprintengine/plan.md",
      snapshotVersion: "snap_1",
      updatedAt: now,
      board: {
        todo: 1,
        ready: 2,
        inProgress: 3,
        changesRequested: 0,
        needsInput: 0,
        blocked: 0,
        done: 4,
      },
      tasks: [
        {
          taskId: "T3",
          title: "Define shared mobile-control protocol",
          role: "developer",
          status: "in_progress",
          ownerAgentId: "developer-2",
          dependsOn: ["T1"],
        },
      ],
      artifacts: [
        {
          artifactId: "A2",
          title: "Architect Plan",
          kind: "architect_plan",
          status: "approved",
          taskId: "T1",
          path: ".multi-code/sprintengine/mobile-sprintengine-companion-integration/plan.md",
        },
      ],
    },
  ],
  workspaces: [
    {
      workspaceId: "mobile-sprintengine-companion-integration",
      kind: "sprintengine",
      name: "Mobile Sprint Engine Companion Integration",
      workspacePath: "/workspace/multicode",
      statePath: "/workspace/multicode/.multi-code/sprintengine/state.yaml",
      updatedAt: now,
      capabilities: ["summary.read", "detail.read", "logs.read"],
      detailVersion: mobileControlWorkspaceSnapshotVersion,
      summary: {
        status: "running",
        headline: "2 ready, 0 needs input",
        counts: {
          ready: 2,
          needsInput: 0,
        },
      },
      detail: {
        kind: "sprintengine",
        data: {
          sprintEngineId: "mobile-sprintengine-companion-integration",
          snapshotVersion: "snap_1",
          board: {
            todo: 1,
            ready: 2,
            inProgress: 3,
            changesRequested: 0,
            needsInput: 0,
            blocked: 0,
            done: 4,
          },
        },
      },
    },
    {
      workspaceId: "switchboard-main",
      kind: "switchboard",
      name: "Switchboard",
      updatedAt: now,
      capabilities: ["summary.read", "detail.read"],
      detailVersion: mobileControlWorkspaceSnapshotVersion,
      summary: {
        status: "idle",
        counts: {
          inbox: 3,
          activeExecutions: 0,
        },
      },
      detail: {
        kind: "switchboard",
        data: {
          inboxCount: 3,
          laneCounts: {
            todo: 2,
            doing: 1,
          },
          activeExecutionCount: 0,
          tasks: [
            {
              taskId: "task_1",
              identifier: "TASK-1",
              title: "Ready task",
              status: "ready",
              lane: "ready",
              updatedAt: now,
              source: { type: "manual", externalKey: null },
              priority: null,
              claimedBy: null,
            },
          ],
          inboxItems: [
            {
              taskId: "task_inbox",
              identifier: "TASK-INBOX",
              title: "Inbox task",
              status: "todo",
              lane: "inbox",
              updatedAt: now,
              source: { type: "watchtower", externalKey: "WT-1" },
            },
          ],
          comments: [
            {
              taskId: "task_1",
              commentId: "comment_1",
              kind: "comment",
              body: "Looks good.",
              createdAt: now,
              authorName: "Reviewer",
              confidencePct: 90,
            },
          ],
          evidence: [
            {
              taskId: "task_1",
              summary: "Verified.",
              artifactCount: 1,
              commandCount: 2,
              touchedFileCount: 3,
              updatedAt: now,
            },
          ],
          logs: [
            {
              taskId: "task_1",
              executionId: "exec_1",
              status: "completed",
              agentId: "developer-1",
              startedAt: now,
              completedAt: now,
              summary: "Done.",
            },
          ],
        },
      },
    },
    {
      workspaceId: "watchtower-main",
      kind: "watchtower",
      name: "Watchtower",
      updatedAt: now,
      capabilities: ["summary.read", "detail.read", "logs.read"],
      detailVersion: mobileControlWorkspaceSnapshotVersion,
      summary: {
        status: "complete",
      },
      detail: {
        kind: "watchtower",
        data: {
          activeRunCount: 0,
          latestRunStatus: "passed",
          generatedInboxCount: 1,
          runs: [
            {
              runId: "run_1",
              status: "completed",
              preset: "standard",
              createdAt: now,
              completedAt: now,
              validCount: 1,
              invalidCount: 0,
              generatedInboxCount: 1,
              agentCount: 2,
            },
          ],
          generatedInboxItems: [
            {
              runId: "run_1",
              taskId: "task_watchtower_1",
              source: "watchtower",
            },
          ],
        },
      },
    },
    {
      workspaceId: "multiloop-main",
      kind: "multiloop",
      name: "Multiloop",
      updatedAt: now,
      capabilities: ["summary.read", "detail.read"],
      detailVersion: mobileControlWorkspaceSnapshotVersion,
      summary: {
        status: "blocked",
      },
      detail: {
        kind: "multiloop",
        data: {
          loopId: "loop_1",
          milestoneCount: 4,
          blockerCount: 1,
          linkedSprintEngineId: "mobile-sprintengine-companion-integration",
          milestones: [
            {
              milestoneId: "milestone_1",
              title: "Milestone one",
              status: "active",
              updatedAt: now,
              linkedSprintEngineId: "mobile-sprintengine-companion-integration",
            },
          ],
          blockers: [
            {
              blockerId: "blocker_1",
              title: "Needs validation",
              status: "active",
              updatedAt: now,
            },
          ],
        },
      },
    },
  ],
};

const validTaskStartCommand: MobileControlCommand = {
  protocolVersion: mobileControlProtocolVersion,
  commandId: "cmd_task_start",
  type: "task.start",
  issuedAt: now,
  deviceId: "device_1",
  payload: {
    sprintEngineId: "mobile-sprintengine-companion-integration",
    taskId: "T3",
    role: "developer",
    worktreeIsolation: "preferred",
  },
};

assert.equal(validateMobileControlCommand(validCommand).ok, true);
assert.equal(validateMobileControlCommand(validTaskStartCommand).ok, true);
assert.equal(validateMobileControlSnapshot(validSnapshot).ok, true);

assertInvalid("unknown protocol version", validateMobileControlCommand({ ...validCommand, protocolVersion: 2 }));
assertInvalid("unknown command type", validateMobileControlCommand({ ...validCommand, type: "terminal.write" }));
assertInvalid(
  "missing command payload field",
  validateMobileControlCommand({
    ...validTaskStartCommand,
    payload: {
      sprintEngineId: "mobile-sprintengine-companion-integration",
      taskId: "T3",
      role: "developer",
    },
  }),
);
assertInvalid(
  "missing command payload field",
  validateMobileControlCommand({
    ...validCommand,
    payload: {
      sprintEngineId: "mobile-sprintengine-companion-integration",
      artifactId: "A1",
    },
  }),
);
assertInvalid(
  "invalid snapshot board count",
  validateMobileControlSnapshot({
    ...validSnapshot,
    sprintEngines: [
      {
        ...validSnapshot.sprintEngines[0],
        board: {
          ...validSnapshot.sprintEngines[0].board,
          ready: -1,
        },
      },
    ],
  }),
);
assertInvalid(
  "invalid workspace detail version",
  validateMobileControlSnapshot({
    ...validSnapshot,
    workspaces: [
      {
        ...validSnapshot.workspaces![0],
        detailVersion: 1,
      },
    ],
  }),
);
assertInvalid(
  "invalid workspace detail kind",
  validateMobileControlSnapshot({
    ...validSnapshot,
    workspaces: [
      {
        ...validSnapshot.workspaces![0],
        detail: {
          kind: "switchboard",
          data: {},
        },
      },
    ],
  }),
);
assertInvalid(
  "invalid workspace detail collection",
  validateMobileControlSnapshot({
    ...validSnapshot,
    workspaces: [
      {
        ...validSnapshot.workspaces![1],
        detail: {
          kind: "switchboard",
          data: {
            tasks: [
              {
                taskId: "task_1",
                identifier: "TASK-1",
                title: "Ready task",
                status: "ready",
                lane: "ready",
                updatedAt: "not-a-date",
                source: { type: "manual" },
              },
            ],
          },
        },
      },
    ],
  }),
);
assertInvalid(
  "invalid snapshot command",
  validateMobileControlSnapshot({
    ...validSnapshot,
    commands: ["artifact.approve", "terminal.write"],
  }),
);
assertInvalid(
  "invalid task dependency list",
  validateMobileControlSnapshot({
    ...validSnapshot,
    sprintEngines: [
      {
        ...validSnapshot.sprintEngines[0],
        tasks: [
          {
            ...validSnapshot.sprintEngines[0].tasks[0],
            dependsOn: ["T1", 42],
          },
        ],
      },
    ],
  }),
);
assertInvalid(
  "invalid device platform",
  validateMobileControlDevice({
    protocolVersion: mobileControlProtocolVersion,
    deviceId: "device_1",
    displayName: "Ari's iPhone",
    platform: "desktop",
    appVersion: "1.0.0",
    pairedAt: now,
    capabilities: ["snapshots.read"],
  }),
);
assertInvalid(
  "invalid capability",
  validateMobileControlCapabilities({
    protocolVersion: mobileControlProtocolVersion,
    deviceId: "device_1",
    commands: ["snapshot.request"],
    capabilities: ["terminal.write"],
    artifactPreviewModes: ["text"],
    maxFollowUpCharacters: 1000,
    snapshotTtlMs: 15000,
  }),
);
assertInvalid(
  "invalid event payload",
  validateMobileControlEvent({
    protocolVersion: mobileControlProtocolVersion,
    eventId: "evt_1",
    type: "command.rejected",
    emittedAt: now,
    payload: {
      commandId: "cmd_1",
      error: {
        protocolVersion: mobileControlProtocolVersion,
        code: "not_a_real_error",
        message: "Nope.",
        retryable: false,
      },
    },
  }),
);
assertInvalid(
  "invalid stable error detail",
  validateMobileControlError({
    protocolVersion: mobileControlProtocolVersion,
    code: "invalid_payload",
    message: "Nope.",
    retryable: false,
    detail: {
      nested: { notAllowed: true },
    },
  }),
);

function assertInvalid(label: string, result: ReturnType<typeof validateMobileControlCommand>): void;
function assertInvalid(label: string, result: ReturnType<typeof validateMobileControlSnapshot>): void;
function assertInvalid(label: string, result: ReturnType<typeof validateMobileControlDevice>): void;
function assertInvalid(label: string, result: ReturnType<typeof validateMobileControlCapabilities>): void;
function assertInvalid(label: string, result: ReturnType<typeof validateMobileControlEvent>): void;
function assertInvalid(label: string, result: ReturnType<typeof validateMobileControlError>): void;
function assertInvalid(label: string, result: { ok: boolean }): void {
  assert.equal(result.ok, false, label);
}
