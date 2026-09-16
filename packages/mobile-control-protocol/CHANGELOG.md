# Changelog

## 4.0.0

**Breaking: the members nothing produces leave the wire.** `mobileControlProtocolVersion`
moves 3 -> 4 and the support window moves with it, to `[3, 4]`.

The Sprint Engine removal (3.0.0) left several members that no desktop could
produce any more. They are deleted, with no deprecated alias and no compatibility
shim:

- `MobileControlSnapshot.workspaces` — the desktop emitted it as `[]` on every
  snapshot. With it went everything that existed only to describe it:
  `MobileControlWorkspaceSnapshot` (and its always-`undefined` `statePath`),
  `MobileControlWorkspaceKind` (`switchboard`, `watchtower`),
  `MobileControlWorkspaceCapability` (`summary.read`, `detail.read`, `logs.read`,
  `comments.create`, `inbox.promote`, `tasks.move`, `runner.pause`,
  `runner.resume`, `execution.cancel`), `MobileControlWorkspaceSummary`,
  `MobileControlWorkspaceDetail`, every `MobileControlSwitchboard*` and
  `MobileControlWatchtower*` shape, their validators,
  `mobileControlWorkspaceSnapshotVersion` and its type.
- The `desktopWorkspaces` member of `mobileSnapshotCollections`. A
  `snapshot.request` whose `include` names it is now `invalid_payload`. It was
  documented as returning the Switchboard and Watchtower monitors; no desktop
  since those modules were retired ever did.
- `MobileControlSnapshot.roadmaps`, `MobileControlRoadmapRider` and
  `MobileControlRoadmapLaneRider`. No desktop produced them.
- The `python_tool_failed` error code. No desktop produced it.

Snapshot-body keys a validator does not know are still ignored rather than
refused, so a stray `workspaces` or `roadmaps` key does not fail a v4 snapshot;
it just has no type.

Pre-release, with no paired devices and no published consumer, so there is no
migration and nothing reads the v3 shape. See `docs/compatibility.md`.

## 3.0.0

**Breaking: the Sprint Engine leaves the wire.** `mobileControlProtocolVersion`
moves 2 -> 3 and the support window moves with it, to `[2, 3]`.

Removed, with no deprecated alias and no compatibility shim:

- `MobileControlSnapshot.sprintEngines` — a REQUIRED member, and its removal is
  what makes this a major. With it went the whole run type tree
  (`MobileControlSprintEngineSnapshot` and every `MobileControlTask*`,
  `MobileControlArtifactSnapshot`, `MobileControlRosterEntry`, lock, activity,
  counts, repo, vcs and started-from shape under it) and `snapshotLimits`, whose
  only member reported shed sprint engines.
- The nine sprint commands — `sprintengine.create`, `task.start`,
  `artifact.read`, `artifact.approve`, `artifact.requestChanges`,
  `agent.followUp`, `backlog.startSprintEngine`,
  `sprintengine.openPullRequest`, `sprintengine.setAutomationMode` — with their
  payload types, `SprintEngineCreateConfig` and its validator.
- The eight sprint capabilities: `artifacts.read`, `sprintengines.create`,
  `tasks.start`, `artifacts.review`, `agents.followUp`, `backlog.start`,
  `sprintengines.pr`, `sprintengines.automation`.
- The role catalogue: the `roleCatalogs` collection, `MobileControlRoleDescriptor`,
  `MobileControlRoleSource`, `roles` / `rolesUnavailable` on the backlog
  workspace, and the `sprintEngineRole*` / `sprintEngineTeamName*` ceilings.
- The `sprintengine` member of `MobileControlWorkspaceKind` and its detail shape.
- `MobileControlCapabilities.artifactPreviewModes` and `maxFollowUpCharacters`,
  along with `ArtifactPreviewMode`: both described commands that no longer exist,
  and the desktop had already been reporting them as `[]` and `0` — the second of
  which its own validator required to be positive.
- The `artifact.reviewUpdated` event; the `artifact.ready`, `task.needs_input`
  and `sprintengine.complete` notification categories; the `artifact`, `task` and
  `sprintEngine` notification targets and the stray `sprintEngineId` on the
  `command` target and on the `notification.created` payload.
- The `sprintengine_not_found` and `artifact_not_found` error codes, and the
  `sprintEngineId` scope on `snapshot.request` and on a backlog item, along with
  a backlog item's `pullRequestUrl`.

`task_not_ready` is deliberately kept despite its name: the desktop's automations
controller answers a run already in flight with it.

Pre-release, with no paired devices and no published consumer, so there is no
migration and nothing reads the v2 shape. See `docs/compatibility.md`.

## 2.0.0

First published version. The module is unchanged — it is the file both
repositories were already maintaining as byte-identical copies, extracted
verbatim so the sha256 pin that guards the phone's remaining copy still holds
while the phone's build works its way through store review.

The version is `2.0.0` rather than `0.1.0` or `1.0.0` because the npm major
tracks `mobileControlProtocolVersion`, which is `2`. See the README.

Contents: the mobile-control command, event and snapshot types, the runtime
validators (`validateMobileControlCommand`, `…Event`, `…Snapshot`, `…Device`,
`…Capabilities`, `…Error`), the protocol version window
(`mobileControlSupportedProtocolVersions`,
`isSupportedMobileControlProtocolVersion`,
`unsupportedMobileControlProtocolVersion`) and the payload size and count
ceilings the relay budget depends on.
