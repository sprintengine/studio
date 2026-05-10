import assert from "node:assert/strict";
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
    sprintEngineId: "mobile-sprintengine-companion-integration",
    artifactId: "A1",
    feedback: "Clarify the acceptance criteria.",
  },
};

const validSnapshot: MobileControlSnapshot = {
  protocolVersion: mobileControlProtocolVersion,
  generatedAt: now,
  desktopSessionId: "desktop_session_1",
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
