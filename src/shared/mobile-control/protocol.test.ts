import assert = require("node:assert/strict");
import {
  mobileControlProtocolVersion,
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
    swarmId: "mobile-swarm-companion-integration",
    artifactId: "A1",
    feedback: "Clarify the acceptance criteria.",
  },
};

const validSnapshot: MobileControlSnapshot = {
  protocolVersion: mobileControlProtocolVersion,
  generatedAt: now,
  desktopSessionId: "desktop_session_1",
  swarms: [
    {
      swarmId: "mobile-swarm-companion-integration",
      name: "Mobile Swarm Companion Integration",
      workspacePath: "/workspace/multicode",
      statePath: "/workspace/multicode/swarm/state.yaml",
      planPath: "/workspace/multicode/swarm/plan.md",
      snapshotVersion: "snap_1",
      updatedAt: now,
      board: {
        todo: 1,
        ready: 2,
        inProgress: 3,
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
          path: "swarm/mobile-swarm-companion-integration/plan.md",
        },
      ],
    },
  ],
};

assert.equal(validateMobileControlCommand(validCommand).ok, true);
assert.equal(validateMobileControlSnapshot(validSnapshot).ok, true);

assertInvalid("unknown protocol version", validateMobileControlCommand({ ...validCommand, protocolVersion: 2 }));
assertInvalid("unknown command type", validateMobileControlCommand({ ...validCommand, type: "terminal.write" }));
assertInvalid(
  "missing command payload field",
  validateMobileControlCommand({
    ...validCommand,
    payload: {
      swarmId: "mobile-swarm-companion-integration",
      artifactId: "A1",
    },
  }),
);
assertInvalid(
  "invalid task-start worktree policy",
  validateMobileControlCommand({
    ...validCommand,
    type: "task.start",
    payload: {
      swarmId: "mobile-swarm-companion-integration",
      taskId: "T3",
      role: "developer",
      worktreeIsolation: "sometimes",
    },
  }),
);
assertInvalid(
  "invalid snapshot board count",
  validateMobileControlSnapshot({
    ...validSnapshot,
    swarms: [
      {
        ...validSnapshot.swarms[0],
        board: {
          ...validSnapshot.swarms[0].board,
          ready: -1,
        },
      },
    ],
  }),
);
assertInvalid(
  "invalid task dependency list",
  validateMobileControlSnapshot({
    ...validSnapshot,
    swarms: [
      {
        ...validSnapshot.swarms[0],
        tasks: [
          {
            ...validSnapshot.swarms[0].tasks[0],
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
