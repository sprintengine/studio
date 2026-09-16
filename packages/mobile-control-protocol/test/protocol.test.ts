import assert from "node:assert/strict";
import {
  mobileControlMinSupportedProtocolVersion,
  mobileControlProtocolVersion,
  mobileControlSupportedProtocolVersions,
  validateMobileControlCapabilities,
  validateMobileControlCommand,
  validateMobileControlDevice,
  validateMobileControlError,
  validateMobileControlEvent,
  validateMobileControlSnapshot,
  type MobileControlCommand,
  type MobileControlSnapshot,
} from "../src/index";

const now = "2026-04-28T19:00:00.000Z";

const validCommand: MobileControlCommand = {
  protocolVersion: mobileControlProtocolVersion,
  commandId: "cmd_1",
  type: "backlog.update",
  issuedAt: now,
  deviceId: "device_1",
  idempotencyKey: "mobile:device_1:cmd_1",
  expectedSnapshotVersion: "snap_1",
  payload: {
    workspacePath: "ws_multicode",
    relativePath: "backlog/2026-04-28-example.md",
    status: "in_progress",
  },
};

const validSnapshot: MobileControlSnapshot = {
  protocolVersion: mobileControlProtocolVersion,
  generatedAt: now,
  desktopSessionId: "desktop_session_1",
  snapshotVersion: "snap_root_1",
  commands: [
    "snapshot.request",
    "device.revoke",
    "backlog.update",
    "backlog.create",
    "automations.control",
  ],
  backlog: [
    {
      workspaceId: "backlog:ws_multicode",
      workspacePath: "ws_multicode",
      projectKey: "ws_multicode",
      workspaceName: "multicode",
      updatedAt: now,
      items: [
        {
          itemId: "MC-1",
          relativePath: "backlog/2026-04-28-example.md",
          title: "Example",
          status: "ready",
        },
      ],
    },
  ],
  automations: [
    {
      automationId: "auto_1",
      projectKey: "ws_multicode",
      name: "nightly",
      status: "enabled",
      triggerKind: "schedule",
      cadence: "Daily 06:00",
      lastRunStatus: "completed",
      recentRuns: [{ runId: "run_1", status: "completed", startedAt: now, completedAt: now }],
    },
  ],
};

const validAutomationsControlCommand: MobileControlCommand = {
  protocolVersion: mobileControlProtocolVersion,
  commandId: "cmd_automations_control",
  type: "automations.control",
  issuedAt: now,
  deviceId: "device_1",
  payload: {
    workspacePath: "ws_multicode",
    automationId: "auto_1",
    action: "runNow",
  },
};

assert.equal(validateMobileControlCommand(validCommand).ok, true);
assert.equal(validateMobileControlCommand(validAutomationsControlCommand).ok, true);
assert.equal(validateMobileControlSnapshot(validSnapshot).ok, true);

// ── The Sprint Engine is off the wire (protocol v3) ──────────────────────────
//
// This block is the inverse of what this file asserted at v2, and deliberately
// so. `sprintEngines` was a REQUIRED member of the snapshot, the nine sprint
// commands were valid command types, and `sprintengine` was a workspace kind.
// The desktop stopped being able to serve any of it when the Sprint Engine left
// the app as a module (MC-2575), and kept emitting the empty shapes only because
// a paired phone demanded them. Pre-release there is no such phone, so the
// shapes are gone rather than hollowed out, and what used to pass must now fail.

// `sprintEngines` is not merely optional now — there is no such collection. A
// snapshot that omits it is the ORDINARY snapshot, which is the whole point:
// requiring it is what would have broken every read on the phone.
assert.equal(
  "sprintEngines" in validSnapshot,
  false,
  "the wire snapshot no longer declares a sprintEngines collection",
);
assert.equal(validateMobileControlSnapshot(validSnapshot).ok, true);

for (const retired of [
  "sprintengine.create",
  "task.start",
  "artifact.read",
  "artifact.approve",
  "artifact.requestChanges",
  "agent.followUp",
  "backlog.startSprintEngine",
  "sprintengine.openPullRequest",
  "sprintengine.setAutomationMode",
]) {
  assertInvalid(
    `retired sprint command ${retired}`,
    validateMobileControlCommand({ ...validCommand, type: retired, payload: {} }),
  );
}

for (const retired of [
  "artifacts.read",
  "sprintengines.create",
  "tasks.start",
  "artifacts.review",
  "agents.followUp",
  "backlog.start",
  "sprintengines.pr",
  "sprintengines.automation",
]) {
  assertInvalid(
    `retired sprint capability ${retired}`,
    validateMobileControlCapabilities({
      protocolVersion: mobileControlProtocolVersion,
      deviceId: "device_1",
      commands: ["snapshot.request"],
      capabilities: [retired],
      snapshotTtlMs: 15000,
    }),
  );
}

// ── The members nothing produced are off the wire (protocol v4) ──────────────
//
// The `workspaces` collection (always `[]` from the desktop), its
// switchboard/watchtower kinds and capabilities, the `roadmaps` rider and the
// `python_tool_failed` error code had no producer once the Sprint Engine left.

// Asking for the retired collection is refused, not silently ignored: a v3 phone
// that named it must learn that it is talking to a v4 desktop.
for (const retired of ["desktopWorkspaces", "sprintEngines", "roleCatalogs"]) {
  assertInvalid(
    `retired snapshot collection ${retired}`,
    validateMobileControlCommand({
      ...validCommand,
      type: "snapshot.request",
      payload: { include: ["backlog", retired] },
    }),
  );
}
assert.equal(
  validateMobileControlCommand({
    ...validCommand,
    type: "snapshot.request",
    payload: { include: ["backlog", "automations"] },
  }).ok,
  true,
);

for (const retired of ["summary.read", "detail.read", "tasks.move", "runner.pause", "execution.cancel"]) {
  assertInvalid(
    `retired workspace capability ${retired}`,
    validateMobileControlCapabilities({
      protocolVersion: mobileControlProtocolVersion,
      deviceId: "device_1",
      commands: ["snapshot.request"],
      capabilities: [retired],
      snapshotTtlMs: 15000,
    }),
  );
}

assertInvalid(
  "retired python_tool_failed error code",
  validateMobileControlError({
    protocolVersion: mobileControlProtocolVersion,
    code: "python_tool_failed",
    message: "Nope.",
    retryable: false,
  }),
);

// A snapshot with neither retired key is the ordinary snapshot.
assert.equal("workspaces" in validSnapshot, false);
assert.equal("roadmaps" in validSnapshot, false);

// The version stamp, not a field check, is what keeps an older snapshot out. A
// v3 snapshot is inside the command window but outside what a reader of the
// desktop's own payloads accepts, so it is refused at the door rather than read
// part-way through a shape this build no longer has a type for.
assertInvalid(
  "a v3 snapshot",
  validateMobileControlSnapshot({ ...validSnapshot, protocolVersion: 3 as never }),
);
assertInvalid(
  "a v2 snapshot",
  validateMobileControlSnapshot({ ...validSnapshot, protocolVersion: 2 as never }),
);

// ── The protocol version window ──────────────────────────────────────────────
//
// The desktop and the phone are separate installs, and the phone's update goes
// through a store review this tree does not control. Exact equality — which is
// what this check was — made the gap between a desktop bump and the phone's
// build clearing review an outage for every paired phone. The window is one
// version of slack; outside it the refusal is unchanged.

for (const version of mobileControlSupportedProtocolVersions) {
  assert.equal(
    validateMobileControlCommand({ ...validCommand, protocolVersion: version }).ok,
    true,
    `protocol version ${version} is inside the window`,
  );
}

assert.equal(
  mobileControlSupportedProtocolVersions.at(-1),
  mobileControlProtocolVersion,
  "the window must end at the version this build stamps on everything it sends",
);

assertInvalid("unknown protocol version", validateMobileControlCommand({ ...validCommand, protocolVersion: 999 }));
assertInvalid(
  "a version below the window",
  validateMobileControlCommand({
    ...validCommand,
    protocolVersion: (mobileControlMinSupportedProtocolVersion - 1) as never,
  }),
);
assertInvalid(
  "no version at all",
  validateMobileControlCommand({ ...validCommand, protocolVersion: undefined as never }),
);

{
  // A refusal has to name both numbers, or its reader cannot tell which of the
  // two installs is the one to update.
  const refused = validateMobileControlCommand({ ...validCommand, protocolVersion: 999 });
  assert.equal(refused.ok, false);
  const message = refused.ok === false ? refused.error.message : "";
  assert.equal(refused.ok === false && refused.error.code, "unsupported_protocol_version");
  assert.match(message, /\b999\b/u);
  assert.match(
    message,
    new RegExp(`${mobileControlMinSupportedProtocolVersion}.${mobileControlProtocolVersion}`, "u"),
  );
  // And the error itself is stamped with what THIS build speaks, not with the
  // version that was refused.
  assert.equal(refused.ok === false && refused.error.protocolVersion, mobileControlProtocolVersion);
}

assertInvalid("unknown command type", validateMobileControlCommand({ ...validCommand, type: "terminal.write" }));
assertInvalid(
  "missing command payload field",
  validateMobileControlCommand({
    ...validAutomationsControlCommand,
    payload: {
      workspacePath: "ws_multicode",
      automationId: "auto_1",
    },
  }),
);
assertInvalid(
  "missing command payload field",
  validateMobileControlCommand({
    ...validCommand,
    payload: {
      workspacePath: "ws_multicode",
    },
  }),
);
// The advertised command list is part of a device's capabilities, not of a
// snapshot — a snapshot carrying a stray `commands` key is simply a snapshot
// with an unknown field, which the validator ignores. What must fail closed is
// a device advertising a command this protocol version does not define.
assertInvalid(
  "invalid advertised command",
  validateMobileControlCapabilities({
    protocolVersion: mobileControlProtocolVersion,
    deviceId: "device_1",
    commands: ["backlog.update", "terminal.write"],
    capabilities: ["snapshots.read"],
    snapshotTtlMs: 15000,
  }),
);
assertInvalid(
  "invalid automation run status",
  validateMobileControlSnapshot({
    ...validSnapshot,
    automations: [
      {
        ...validSnapshot.automations![0],
        recentRuns: [{ runId: "run_1", status: "not_a_status" as never }],
      },
    ],
  }),
);
assertInvalid(
  "invalid automation status",
  validateMobileControlSnapshot({
    ...validSnapshot,
    automations: [{ ...validSnapshot.automations![0], status: "off" as never }],
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
