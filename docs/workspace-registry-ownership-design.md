# Workspace Registry Ownership — Design

Working design for MC-2158 (`backlog/2026-08-06-workspace-registry-ownership-to-main.md`),
the load-bearing child of the `main-owned-orchestration` epic: move the workspace
registry out of the renderer's zustand/localStorage store into a main-process
store persisted under userData, and turn every renderer store into a subscriber
mirror.

This document is MC-2158's brief. It is written against the code as of
`94d6ab9b` on `sprintengine/main-owned-orchestration`, which is `main@89d2cac0`
(PR #87, the headless-core epic) plus two backlog-only commits — no `src/`
difference. Every file:line below is at that commit.

It reuses the cross-phase principles of `docs/sprint-runtime-ownership-design.md`
verbatim; §0 restates them and names what each one decides here.

---

## 0. Cross-phase principles (from `docs/sprint-runtime-ownership-design.md`)

These are not restated in this document's own words: each is quoted verbatim from
the template's "Cross-phase principles", with `[…]` marking text specific to that
epic's subject matter. **Here:** says what the principle decides for the registry.

1. > **One authoritative store per fact, owned by main.** The renderer may hold a
   > mirror for display and optimistic UI, but reconciles against main's value
   > and never re-asserts a stale one (guarded by a monotonic revision on the
   > authoritative store, mirroring the mobile `snapshotVersion` guard).

   **Here:** the registry file's `revision`, and the mirror's revision guard. §1, §2.

2. > **Engine boundary respected.** The app never writes `run.yaml` or
   > `projection.json`. […] app-owned state the engine neither reads nor
   > validates.

   **Here:** the registry is a userData file, never anything inside a team
   directory, and `sprintEngineState` (a cache of `projection.json`) stays out of
   it. §1.3.

3. > **Pure logic in `src/shared/`[…],** imported by main, renderer, and tests.
   > No electron, no `window`, no `src/main` imports. Impure seams (clock,
   > […] audit sink, […]) are injected ports.

   **Here:** `src/shared/workspace-registry.ts` holds the record math;
   `src/main/workspace-registry-store.ts` holds fs, clock, and broadcast. §1.2, §1.5.

4. > **Single writer path.** Desktop UI, phone, and any future CLI all converge
   > on the main-process […] service call; audit is emitted in main so parity is
   > structural, not disciplinary.

   **Here:** UI, gateway, automations, capability modules, mobile, and any future
   remote caller converge on the registry service. §1.4.

5. > **No runtime behavior flags** (project policy […]): the Sprint Engine lands
   > policy changes directly in small revertible commits — safety comes from
   > pre-release validation, never dual-path toggles. […] there is no shadow
   > mode, no […] toggle, and the end state is a single owner.

   **Here:** no `registryOwner` switch, no dual-write of the legacy key beyond
   the frozen-snapshot rule. §3.3, §3.5, §6.

### Ground truth (verified at the pinned commit, not assumed)

- **Main's registry today is explicitly non-authoritative.** Restart survivors
  are rebuilt as `workspace-sync-routing-placeholder` records with
  `mode: 'standard'`, an empty layout, and `agents: {}`
  (`src/main/workspace-sync-service.ts:15-19`, `:283-310`). Three separate call
  sites branch on that sentinel to refuse or degrade work
  (`src/main/automation/automation-tools.ts:294-299`, `:392`, `:549-551`) and a
  fourth hides such workspaces from module views
  (`src/shared/modules/workspace-view.ts:27-32`).
- **Creation is a renderer round-trip with a 7s confirmation poll.**
  `createWorkspaceConfirmed` delegates to the primary window and then polls the
  sync snapshot until the id appears (`src/main/workspace-create.ts:14`, `:37-79`).
  With no window the delegate fails `no_primary_window` before the poll
  (`src/main/automation/renderer-delegate.ts:35-41`).
- **The layout templates are already portable.** `src/renderer/src/layouts/templates.ts:1`
  has a single type-only import; `LAYOUT_TEMPLATES` (`:43`) is plain FlexLayout
  `IJsonModel` data. Relocation to `src/shared/` is mechanical, not a rewrite.
- **The event-bus machinery main needs already exists and is proven.**
  `src/shared/workspace-sync.ts:168-190` is a pure reducer with monotonic
  sequences, duplicate/stale rejection, and explicit gap reporting;
  `:192-200` applies a snapshot resync. Main already owns sequencing, a bounded
  replay log, and command validation (`src/main/workspace-sync-service.ts:44-99`,
  `:565-579`), and broadcasts on `workspace-sync:event`
  (`src/main/ipc/workspace-sync-ipc.ts:23-46`).
- **The userData store pattern is proven 1× and is the template.**
  `src/main/sprintengine-launch-settings-mirror.ts` gives serialized atomic
  writes with per-attempt temp files (`:91-118`), commit-with-revision
  (`:120-135`), content-identical no-op (`:153-160`), and hydrate-once
  (`:162-172`). Its record shape (`schemaVersion` / `revision` / payload /
  `changedAt` / `lastWrite`) is at `src/shared/sprintengine/launch-settings.ts:56-67`,
  with the revision math at `:218-231`.
- **Per-field last-write-wins already ships.** `SprintRuntimeAgentConfig`
  (`src/shared/sprintengine/runtime-bridge.ts:78-91`) defines the exact rule this
  design generalizes: an absent field means "no opinion", an explicit `null` is a
  tombstone, and `configEditedAt` gates whether a lagging window's push may
  overwrite a newer edit.
- **The renderer's wipe guard is load-bearing and must survive.**
  `src/renderer/src/store/workspaceStore.ts:603-656` refuses to let an empty
  in-memory snapshot overwrite a non-empty persisted registry unless an explicit
  `workspaceRegistryEmptyState` intent record proves the user meant it; the
  classification it uses is `src/renderer/src/store/slices/persistenceSlice.ts:325-361`.
  This is the single most important thing the migration must not lose.
- **Exactly what is durable today is already defined.**
  `normalizeWorkspaceForPartialize` (`src/renderer/src/store/slices/normalizers.ts:241-296`)
  is the authoritative list of what survives a restart and what is stripped
  (`sprintEngineState`, the `sprintengine` module-state entry, stream buffers,
  live status, `cliRestartNonce`, session-only spawn intent). The registry schema
  is derived from it, not invented.
- **The mobile path has already been half-inverted.** MC-2153 made the phone's
  workspace scope read main's own snapshot rather than a renderer push
  (`src/main/modules/mobile-relay-module.ts:37-45`), and the desktop workspace
  summaries are read from disk per root
  (`src/main/mobile/sprintengine/snapshot.ts:411-421`). The remaining coupling is
  that those roots come from placeholder records whose folder only survives
  because the routing snapshot persists a `workspaceFolderPaths` side-map
  (`src/shared/workspace-sync.ts:127-150`).

### Corrections to MC-2158's item (paths drifted since it was written)

- `src/main/automation/workspace-create.ts:6-12` → **`src/main/workspace-create.ts:5-12`**.
  The file is at `src/main/`, not under `automation/`; it is shared by the
  gateway tool and the capability-module `WorkspaceService`
  (`src/main/modules/module-workspace-service.ts:31`) and the automations
  executor (`src/main/automations/executor-local.ts:413`). The epic's
  decision-of-record 1 carries the same stale path and is corrected in the same
  publish.
- `src/shared/automation.ts:6-14` → **`:4-14`** (the declaration starts one line
  earlier).
- `workspacesSlice.ts:1006-1011` → the reuse logic is now two branches:
  **switchboard at `:1020-1051`** and **host-mode (automations-host /
  reviews-host) at `:1052-1105`**. Both must move, not one.
- `mobile-bridge-ipc.ts` does not exist. The mobile seam is
  `src/main/modules/mobile-relay-module.ts:43-45` (see above).

---

## 1. Store schema

### 1.1 Location and file

`<userData>/workspace-registry.json`, resolved through `app.getPath('userData')`
exactly like the routing snapshot (`src/main/workspace-sync-routing-snapshot.ts:6`,
`:17`) and the launch-settings mirror
(`src/main/sprintengine-launch-settings-mirror.ts:38`, `:67-69`). Main is the only
process that opens it.

**One file, not one per workspace.** A single mutation routinely spans several
workspaces (closing a window re-homes every workspace it held —
`src/main/workspace-sync-service.ts:590-596`), so per-workspace files would need a
cross-file transaction to stay consistent. One file + tmp-and-rename is one
atomic transaction, and it is the shape both existing userData stores already use.

### 1.2 Record

Pure shapes and math in `src/shared/workspace-registry.ts` (no fs, no electron),
mirroring `src/shared/sprintengine/launch-settings.ts:56-67`:

```jsonc
{
  "schemaVersion": 1,
  // Monotonic write counter, bumped once per accepted mutation. Broadcasts
  // carry it; a mirror ignores anything at or below the revision it already
  // applied, so a slow echo can never re-assert a stale value.
  "revision": 137,
  "changedAt": 1817000000000,
  "lastWrite": { "actor": "ui", "at": "ISO" },  // ui | gateway | automation | module | mobile | system
  "workspaces": [ /* WorkspaceRegistryRecord[] — see below */ ],
  "workspaceWindows": [ /* WorkspaceWindowState[], verbatim from types/workspace.ts */ ],
  "primaryWorkspaceWindowId": "primary",
  "activeWorkspaceId": "ws_...",
  // The explicit "the user really did remove everything" record. Absent with an
  // empty `workspaces` array is a fault, never an intent (§3.2).
  "registryEmptyState": null,
  // Ids removed recently, so a lagging window's optimistic edit against a
  // deleted workspace is rejected rather than resurrecting it. Pruned on write
  // past 200 entries or 24h, whichever comes first — a window offline longer
  // than that has already lost the replay window (§4 case 3) and resyncs from a
  // full snapshot, which cannot contain the deleted record at all.
  "tombstones": [ { "id": "ws_...", "removedAt": 1817000000000, "revision": 129 } ]
}
```

`WorkspaceRegistryRecord` is `Workspace` (`src/renderer/src/types/workspace.ts:935-999`)
minus the fields §1.3 leaves in the renderer, plus:

```jsonc
{
  "id": "ws_...",
  "revision": 129,            // revision of the last accepted write to THIS record
  "fieldEditedAt": {          // per-field LWW stamps for user-editable fields (§2.4)
    "name": 1817000000000,
    "layoutModel": 1816999000000,
    "folderPath": 1816000000000,
    "memory": 0,
    "settledAt": 0,
    "settledOverride": 0
  }
}
```

Per-agent LWW keeps using the field that already exists — `AgentState.configEditedAt`,
the stamp `SprintRuntimeAgentConfig` gates on
(`src/shared/sprintengine/runtime-bridge.ts:86-91`) — rather than a second
mechanism inside `fieldEditedAt`.

### 1.3 What the registry owns, and what stays renderer-persisted

**Main owns (durable domain state):** `id`, `name`, `titleLocked`, `mode`,
`folderPath`, `folderMissing`, `worktree`, `worktreeState`, `sprintEngineContext`,
`templateId`, `layoutModel`, `agents` (the roster, normalized exactly as
`normalizers.ts:271-296` normalizes it today), `memory`,
`sprintEngineRoleCliDefaults`, `sprintEngineRosterSessions`,
`sprintEngineAutoState` (**mirror only** — `automation.json` stays the authority
for run intent; see resolved question 10), `moduleState` (minus the stripped
`sprintengine` entry), `guidedBriefState`, `createdAt`, `settledAt`,
`settledOverride` (settled-chats, 2026-09-07; the retired `archivedAt` heals into
`settledAt` on read), `highlight`, `lastTerminalActivityAt`, `lastTurnEndedAt` —
plus the routing block (`workspaceWindows`,
`primaryWorkspaceWindowId`, `activeWorkspaceId`), which main already persists in
the routing snapshot.

**The renderer keeps (per-window presentation), in localStorage keyed by
workspace id:** `editorState`, `fileExplorerState`, `backlogState`,
`gitPanelState`, focus, and which tab is visible inside a pane.

*Decision, with the alternative recorded:* moving panel view state into the
registry too was rejected. Those fields change on every scroll, expand, and file
open; each change would bump the monotonic revision and rewrite the whole file.
That is precisely the write-storm `sprintEngineState: null` was introduced to
stop (`normalizers.ts:249-257`). The two homes are disjoint field sets, not two
copies of one fact, so this is not dual authority. Renderer view-state entries
are garbage-collected when a `workspace.removed` broadcast arrives.

**`layoutModel` is renderer-*authored*, main-*persisted*.** This refines — does
not overturn — the epic's decision-of-record 4 ("the renderer keeps
presentation"). Only the renderer computes a layout change (FlexLayout lives
there); it sends the result as a command and main stores it. Main needs the field
because MC-2158's headless acceptance is "gateway `workspace.create` with zero
windows yields a workspace that a subsequently opened window renders correctly" —
a workspace with no layout is not fully formed. The alternative (main stores only
`templateId`; the first window to open the workspace materializes and pushes a
layout) was rejected: it leaves every layout edit with no durable home until some
window happens to open, which is the split-brain this epic exists to end.

`sprintEngineState` and the `moduleState.sprintengine` entry stay **excluded**, on
the same reasoning as today — they are a cache of `projection.json`, and
principle 2 forbids a second source of truth for engine-owned data.

### 1.4 The service

`src/main/workspace-registry-service.ts`, registered as
`WorkspaceRegistryToken` on the existing module service bus alongside
`WorkspaceSyncServiceToken` (`src/main/module-host/service-tokens.ts:50-52`) —
per the epic's decision-of-record 2, no new API mechanism. `WorkspaceServiceToken`
and `WorkspaceContextToken` (`:84`, `:87`) keep their public keys and are re-pointed
at it, so third-party modules resolving the SDK token are unaffected.

Surface (every caller converges here — principle 4):

- `getSnapshot()` / `getRecord(id)` — synchronous reads; the gateway, the
  scheduler, the automations executor, and the mobile roots resolver use these.
- `create(input, actor)` → `{ workspaceId, workspace, revision }`. Resolves the
  template (§5.2), applies the reuse rules (§5.3), mints the record, assigns it to
  a window, bumps the revision, persists, broadcasts. **Synchronous authority:**
  the id it returns is observable in the same call, which is what retires the 7s
  confirmation poll.
- `applyCommand(command, source)` — the renderer-originated edits of §2.3.
- `remove(id, actor)`, `moveToWindow(...)`, `setActive(...)`, `updatePlacement(...)`,
  `closeWindow(...)` — the routing commands `workspace-sync-service.ts:321-338`
  already validates, moved onto the authoritative store.
- `subscribe(listener)` — the seam the broadcaster and the mobile/gateway readers
  attach to (same shape as
  `src/main/sprintengine-launch-settings-mirror.ts:174-177`).

### 1.5 Write discipline

Copied from the proven mirror rather than re-derived:

- **Atomic:** `mkdir -p` → write `<file>.tmp-<pid>-<n>` → `rename`, with the temp
  path carrying a per-attempt sequence so two writes in one tick cannot race on a
  shared temp name, and `unlink` on failure
  (`src/main/sprintengine-launch-settings-mirror.ts:97-118`).
- **Serialized:** every write chains onto one `writeQueue`, so revisions land in
  order.
- **Debounced at 250 ms**, matching the routing snapshot's default
  (`src/main/workspace-sync-service.ts:117-124`), with a `flush()` awaited on
  `before-quit` — the same guarantee `flushRoutingSnapshot`
  (`:101-108`) provides today.
- **Content-identical writes are a no-op:** no revision bump, no write, no
  subscriber wake (`sprintengine-launch-settings-mirror.ts:153-160`).
- **A failed write is a warning diagnostic, not a crash:** in-memory state stays
  authoritative for the session and the next write retries
  (`:106-114`). It is never a silent success — the diagnostic names the file.

---

## 2. The sync protocol

### 2.1 Shape: generalize the bus that already exists

The broadcast is the existing `workspace-sync` event bus with main promoted from
relay to writer. Nothing about the wire mechanics is new: monotonic sequence,
duplicate/stale rejection, explicit gap reporting, snapshot resync — all already
implemented and tested in `src/shared/workspace-sync.ts:157-200`.

What changes is who mints events. Today a renderer applies locally and then asks
main to record the fact (`workspace-sync-service.ts:68-99`). After this item, a
renderer *asks* and main *decides*; the accepted event is the authoritative
record of what happened.

New event types, added to `WorkspaceSyncEventType`
(`src/shared/workspace-sync.ts:65-72`):

| Event | Payload |
|---|---|
| `workspace.registry_snapshot` | full record set + `revision` (resync only) |
| `workspace.created` | the full minted record (exists today; payload becomes main's record, not the renderer's) |
| `workspace.renamed` | `{ id, name, titleLocked, editedAt }` |
| `workspace.layout_updated` | `{ id, layoutModel, editedAt }` |
| `workspace.fields_updated` | `{ id, patch, editedAt }` — folderPath, memory, settledAt, settledOverride, highlight, worktree, lastTerminalActivityAt, lastTurnEndedAt (the two clocks only ever advance) |
| `workspace.agents_updated` | `{ id, agentId, patch \| null, configEditedAt }` |
| `workspace.removed` | `{ id, removedAt }` |

The existing routing events (`workspace_window.*`, `workspace.moved_to_window`,
`agent_terminal.*`) keep their names and payloads unchanged.

### 2.2 Renderer mirror application

The renderer store's apply actions already exist and are already wired through a
single configured client
(`src/renderer/src/store/workspaceStore.ts:1544-1561`). Each new event type gets
one more apply action registered the same way. Rules:

1. **Revision-guarded.** A mirror tracks the last applied `revision` and ignores
   anything at or below it. A sequence gap re-fetches the full snapshot
   (`workspace-sync:get-events-after` → gap → `get-snapshot`), which is what
   `applyWorkspaceSyncSnapshot` (`src/shared/workspace-sync.ts:192-200`) exists for.
2. **Apply actions never dispatch.** The no-echo contract stays exactly as it
   is, but simplifies:
   once the registry is not in localStorage, the `suppressNextPersistWrite`
   plumbing and the dedup baseline
   (`workspaceStore.ts:1517-1543`) are no longer needed for registry fields, only
   for the settings key. They retire with the registry key (§5.1).
3. **Broadcast still skips the source window**
   (`src/main/ipc/workspace-sync-ipc.ts:36-46`). The source learns the
   authoritative outcome from the invoke result, which carries the accepted event
   (including any value main normalized) or the rejection. This keeps the existing
   fan-out and avoids a redundant round-trip.
4. **Rejection rolls back.** A command main rejects returns
   `{ ok: false, reason, snapshot? }` (the shape
   `WorkspaceSyncCommandResult` already has —
   `src/shared/workspace-sync.ts:153-155`); the renderer reverts its optimistic
   apply to main's value. It never keeps a local value main refused.

### 2.3 Command surface for renderer-originated edits

Renderer slice actions apply optimistically, then dispatch. One command per
user-editable fact, so two concurrent edits to different fields never contend:

| Command | Raised by |
|---|---|
| `workspace.rename` `{ id, name, editedAt }` | `renameWorkspace` (`workspacesSlice.ts:1338-1347`), `autoTitleWorkspaceFromPrompt` (`:1349-1365`) |
| `workspace.update_layout` `{ id, layoutModel, editedAt }` | FlexLayout model change |
| `workspace.update_fields` `{ id, patch, editedAt }` | `setFolderPath`, memory root, settle/un-settle and the rest sweep, the activity clocks, highlight, worktree |
| `workspace.update_agent` `{ id, agentId, patch \| null, configEditedAt }` | agent rename, runtime override, queued startup prompt |
| `workspace.create` `{ template, name?, folderPath?, mode?, windowId }` | the new-workspace wizard and every UI creation path |
| `workspace.remove` `{ id }` | row context menu / close |

`editedAt` is stamped by the *originating window* at the moment of the user
gesture, not on arrival in main — a stamp assigned on arrival would make ordering
depend on IPC latency, which is exactly the bug the LWW rule prevents.

### 2.4 Per-field last-write-wins

For each user-editable field, main applies a command only when
`command.editedAt >= record.fieldEditedAt[field]`; otherwise it drops the write
and re-broadcasts the current value so the lagging window converges. This is the
`configEditedAt` rule from `runtime-bridge.ts:86-91`, generalized:

- **absent field** = "this window has no opinion" — never clears main's copy.
- **explicit `null`** = tombstone, "the user cleared this".
- **equal stamps** = main's arrival order decides. Main is single-threaded, so
  this is deterministic, and the window that loses converges on the next
  broadcast.

Non-user-editable fields (session assignment, launch flags, scheduler-owned
roster records) are not LWW: they are written by main's own subsystems through
the service and carry no stamp.

---

## 3. The localStorage migration

### 3.1 One-time hydrate

Precedent: `hydrateAutomationMode`
(`src/main/sprintengine-automation-service.ts:385`) and
`sprintengine:launch-settings:hydrate`
(`src/main/sprintengine-launch-settings-mirror.ts:162-172`) — seed only when no
record exists, actor `system`, no audit, and a **no-op** once main has written
anything.

Channel `workspace-registry:hydrate`. On boot, a window that finds a
`multicode-workspaces` key offers its **post-migrate-ladder** state — the value
after zustand's `migrate` chain has run up to `WORKSPACE_STORE_VERSION`
(currently 71, `src/renderer/src/store/slices/persistenceSlice.ts:59-61`). Main
must never store a pre-v71 shape, because the ladder lives in the renderer and
would not be re-run against main's file.

Main's `hydrate(payload)`:

1. If a record already exists → return it unchanged, `changed: false`. A second
   window racing the first is a no-op, not a merge.
2. Classify the payload with the existing guard, ported to
   `src/shared/` alongside the rest of the record math:
   `classifyPersistedWorkspaceState`
   (`persistenceSlice.ts:325-361`) plus `isDangerousEmptyClassification`.
3. Seed only on the `present` classification, or on an empty payload that
   carries an explicit `registryEmptyState` intent record.

### 3.2 Partial or corrupt renderer state

Explicit failure over silent fallback:

| Renderer state | Classification | Main's action |
|---|---|---|
| Non-empty, parses | `present` | seed the registry, `revision: 1`, actor `system` |
| Empty **with** `workspaceRegistryEmptyState` | intentional empty | seed an empty registry — the user really did remove everything |
| Empty **without** that record | `dangerous_empty_no_workspaces` | **refuse to seed.** Leave the registry absent, write a warning diagnostic naming the classification, retry on the next boot |
| Key missing | `dangerous_empty_missing_storage` | refuse to seed; try the main-side registry backup (`src/main/ipc/workspace-backup-ipc.ts`) before falling through to a genuinely fresh install |
| Key present but unparseable | `dangerous_empty_unreadable` | refuse to seed; same backup path |
| Individual record fails per-record validation | — | drop that record, keep the rest, one diagnostic per dropped id with the id and the failing field |

A refusal is loud (diagnostic) and recoverable (the untouched legacy key is still
there next boot). A refusal is never an empty registry presented as success — the
existing wipe guard (`workspaceStore.ts:603-656`) exists because that failure
mode has already bitten this codebase once.

### 3.3 The legacy key

`multicode-workspaces` is **frozen, not deleted, for one release**: after the
inversion the renderer stops writing it and leaves the last written value in
place as the rollback artifact. The following release deletes it, in its own
commit.

*Accepted trade, stated:* a user who downgrades after one release loses workspace
changes made during that release. The alternative — dual-writing the legacy key —
is exactly the dual authority the epic rejected, and a stale dual-write is worse
than a clean frozen snapshot because it would silently lose the *newer* state on
the way back up.

`multicode-app-settings` (`persistenceSlice.ts:60`) is untouched by this item;
its migration is MC-2154's, already landed.

### 3.4 Corrupt registry file at boot

Do not start empty. In order: the registry file → the most recent main-side
backup → the frozen legacy localStorage key → a genuinely empty registry with a
loud diagnostic. Only the last of these presents an empty workspace list, and it
says so.

### 3.5 Verification against a real profile

Before the commit lands:

1. Copy a real profile's userData directory (`app.getPath('userData')`) to a
   scratch directory — this includes the Chromium `Local Storage` LevelDB that
   holds `multicode-workspaces`.
2. Launch the built app against the copy with Electron's `--user-data-dir`.
3. Dump main's `workspace-registry.json` and compare, per workspace id, against
   the pre-migration localStorage value: `name`, `folderPath`, `mode`, and the
   agent roster (agent ids, `kind`, `cli`, `specialistId`, `cliSessionId`,
   `cliResumeAvailable`) must match byte-for-byte after normalization.
4. Confirm the legacy key is still present and unmodified.
5. Repeat against a profile with two windows' worth of routing, and against a
   profile with `workspaces: []` — the second must land in the "refuse to seed"
   row of §3.2, not in an empty registry.

A comparison script under `scripts/` makes step 3 repeatable; the run is recorded
as MC-2158 evidence, since it is the only check that exercises a real user's data
rather than a fixture.

---

## 4. Multi-window reconciliation

Every case below is a test in §6.

| # | Race | Resolution |
|---|---|---|
| 1 | Rename in A, layout drag in B, same workspace | Both apply. Different commands, different `fieldEditedAt` slots, no contention. Each window receives only the other's field. |
| 2 | Rename in A and B, same workspace | LWW on `fieldEditedAt.name`. The later gesture wins regardless of arrival order; the loser converges on main's broadcast. `titleLocked` travels with the winning name. |
| 3 | Window offline during an edit (suspended, or missed a broadcast) | On the next event, `applyWorkspaceSyncEvent` reports `sequence_gap` (`src/shared/workspace-sync.ts:174-182`); the mirror re-fetches `get-events-after`, and if the replay window has rolled past (bounded at 500 events, `workspace-sync-service.ts:14`) it takes a full `workspace.registry_snapshot`. |
| 4 | Two windows editing the same agent's config | Per-agent `configEditedAt` LWW — the rule already shipped in `runtime-bridge.ts:86-91`. Absent field = no opinion; explicit `null` = clear. |
| 5 | Two windows both request the reuse-eligible host for folder F (automations-host / switchboard / reviews-host) | Main resolves reuse under its single writer and returns **the same id to both**. This is the class of bug the current renderer-side `set()`-scoped check (`workspacesSlice.ts:1052-1058`) can only prevent within one window; across windows it cannot, and main can. |
| 6 | A removes a workspace while B is editing it | B's command is rejected `unknown_workspace` against the tombstone list (§1.2); B rolls back the optimistic edit on the rejection. Without tombstones the edit would resurrect a deleted record. |
| 7 | A window closes with a command in flight | Main applies it and broadcasts; the dropped reply is harmless because main is authoritative. No orphaned optimistic state survives — the window is gone. |
| 8 | App quits during the 250 ms write debounce | `flush()` on `before-quit`, awaited, same guarantee as `flushRoutingSnapshot` (`workspace-sync-service.ts:101-108`). |
| 9 | Two windows drag the same workspace to different windows | First accepted wins; the second is rejected `workspace_not_in_source_window` by the ownership validation that already exists (`workspace-sync-service.ts:565-579`), unchanged. |
| 10 | A headless creation (gateway/automation/scheduler) lands while a window is mid-edit | The create is a new record and touches nothing the edit touches; the window receives `workspace.created` and adds it. Membership assignment is main's, so the workspace lands in a real window rather than waiting for one to claim it. |

---

## 5. Retirement plan

### 5.1 The routing-placeholder model

Delete `ROUTING_PLACEHOLDER_TEMPLATE_ID` and every branch on it:

- `src/main/workspace-sync-service.ts:19`, `:283-310` (`createRoutingPlaceholderWorkspace`),
  `:486` (the "accept a re-offer over a placeholder" exception, whose only reason
  to exist is the placeholder).
- `src/main/automation/automation-tools.ts:91`, `:294-299` (the
  `workspace_without_folder` refusal), `:392` (`detail: 'routing-only'`),
  `:549-551` (the visibility filter that hides placeholders from `workspace.list`).
- `src/shared/modules/workspace-view.ts:27-32`.

`src/main/workspace-sync-routing-snapshot.ts` retires with it: routing is part of
the registry record (`workspaceWindows`, `primaryWorkspaceWindowId`,
`activeWorkspaceId`), so its `workspaceNames` / `workspaceFolderPaths` /
`workspaceModes` side-maps (`src/shared/workspace-sync.ts:127-150`) — each added
to patch a specific placeholder gap — have nothing left to patch. The registry
file's hydrate reads the routing snapshot once if no registry exists and no
localStorage state can be had, then never again.

`src/renderer/src/store/workspaceStore.ts:1398-1502` (the opt-in `storage`-event
cross-window sync, gated behind `multicode.workspaceStorageLiveSync`) is deleted:
it is the rollback path for a localStorage registry that no longer exists.

### 5.2 The three renderer-authority declarations

Updated in the same publish (epic decision-of-record 1, with §0's path
correction):

- **`src/main/workspace-create.ts:5-12`** — the file is deleted.
  `createWorkspaceConfirmed`, `WORKSPACE_CREATE_CONFIRM_TIMEOUT_MS = 7_000`
  (`:14`), and the poll loop (`:57-79`) go with it. Its three callers
  (`src/main/automation/automation-tools.ts:598`,
  `src/main/modules/module-workspace-service.ts:31`,
  `src/main/automations/executor-local.ts:413`) call
  `workspaceRegistry.create(...)` and get the record synchronously. The
  `workspaceMode` overlay (`src/shared/automation.ts:216-230`) is deleted — it
  exists only to paper over the placeholder's wrong mode.
- **`src/main/workspace-sync-service.ts:15-19`** — the comment is replaced by the
  authoritative-registry statement, and the service becomes the broadcast/replay
  layer over the registry rather than a state machine with its own snapshot.
- **`src/shared/automation.ts:4-14`** — the "mutation tools are delegated to the
  primary window's renderer" paragraph is corrected for `workspace.create`, and
  `kind: 'workspace.create'` (`:34-43`) leaves `AutomationRendererRequest`. The
  delegate keeps `agent.launch` / `agent.dispose` / `sprint.create` until MC-2159
  and MC-2160 take them; deleting the delegate itself is MC-2161.

Layout templates move to `src/shared/layouts/templates.ts` (a re-export shim at
`src/renderer/src/layouts/templates.ts` keeps existing import sites green, the
established pattern), so `create()` can resolve a real template headless.
`createAutomationsTemplate` (`src/renderer/src/modules/automations-workspace-types.ts`)
moves with it, because `useAutomationRequests.ts:798-806` shows the
automations-host path depends on it — a host created without it lands on a bare
standard layout.

### 5.3 Reuse semantics — must move intact

Both branches, semantics-preserving:

- **Switchboard reuse** (`workspacesSlice.ts:1020-1051`): an existing
  `switchboard`-mode workspace with the same normalized folder key is reused, its
  `folderMissing` cleared, and it is activated in the target window.
- **Host reuse** (`:1052-1105`): the same rule for `automations-host` and
  `reviews-host`, keyed by mode + folder.

In main these become one `resolveReuseTarget(mode, folderPath)` on the registry
service, run inside the same critical section as the mint. The renderer-side
comment about why the check must live inside `set()` (`:1052-1058` — two calls in
one tick each reading before either writes) is the same hazard main's single
writer removes structurally; carry the reasoning into the new code's comment so
the next reader knows why the check is where it is.

Two behaviours must not be lost in the move: `folderMissing` is cleared on reuse,
and the reused workspace is added to the requesting window's membership if it is
not already there. The "offer the reused host back to main to heal a placeholder"
step (`:1091-1103`) is deleted — there is no placeholder left to heal.

### 5.4 Mobile

`src/main/modules/mobile-relay-module.ts:43-45` keeps its shape but reads real
records; the renderer push (`mobileWorkspaceRoots`) becomes redundant and is
removed in this item, since its only remaining job is to supply folders the
placeholder model lost.

---

## 6. Test plan

Node `--test` via the esbuild-bundle pattern every `test:main:*` / `test:shared:*`
script in `package.json` uses, added to `verify:app`.

**Pure (`src/shared/workspace-registry.ts`)** — `test:shared:workspace-registry`:
- record parse/normalize/serialize round-trip; unknown `schemaVersion` → null.
- revision math: monotonic bump; content-identical write does not bump.
- per-field LWW: older `editedAt` dropped, equal accepted, absent vs explicit
  `null` (the tombstone distinction from `runtime-bridge.ts:78-91`).
- tombstone rejection of a command naming a removed id, and tombstone pruning at
  both bounds (200 entries, 24h) — including that a prune never drops a tombstone
  still inside the 500-event replay window.
- classification port: every row of §3.2's table.

**Service (`src/main/workspace-registry-service.ts`)** — `test:main:workspace-registry-service`,
against a real tmpdir:
- create → the returned id is readable from `getSnapshot()` **in the same tick**
  (the property that retires the 7s poll).
- atomic write: no partial file after a mid-write failure; the temp file is
  cleaned up; a write failure logs a warning and leaves in-memory state usable.
- serialized writes: two mutations in one tick land in revision order.
- debounce + `flush()` on quit persists the last mutation.
- reuse: switchboard and both host modes, each with the `folderMissing`-cleared
  and window-membership assertions; two concurrent create calls for the same
  host folder return one id (case 5).
- hydrate-once: seeds from a payload, then no-ops; refuses every dangerous-empty
  row; per-record validation drops one bad record and keeps the rest.

**Reconciliation** — `test:main:workspace-registry-reconciliation`, two simulated
window sources against one service: cases 1–10 of §4, each asserting both the
accepted state and that no echo loop occurs (a fixed number of broadcasts per
command).

**Headless integration** — `test:main:workspace-registry-headless`, no
BrowserWindow at all:
- gateway `workspace.create` with zero windows yields a complete record
  (mode, layout, folder, roster), and a window attaching afterwards receives it
  via `workspace.registry_snapshot` and renders it.
- restart with no window: the registry reloads complete — assert no record has
  the retired placeholder shape and every one has a non-empty `layoutModel`.
- gateway tools that today refuse placeholders
  (`automation-tools.ts:294-299`, `:549-551`) operate on restart survivors with
  no live agent terminal.

**Migration fixtures** — `test:main:workspace-registry-migration`: a captured
post-v71 localStorage payload with several workspaces (roster, worktree, sprint
context) seeds an identical registry; an empty payload with an intent record
seeds empty; an empty payload without one refuses; a truncated payload refuses
and reports; a payload with one malformed record keeps the others.

**Renderer** — the existing suites stay green and are extended rather than
replaced: `workspaceStore.activeSync.test.ts` and `workspaceSyncClient.test.ts`
cover the new apply actions and the revision guard;
`workspaceStore.persistence.test.ts` is reworked to assert the registry fields are
*no longer* written to localStorage while the settings key still is.

**End-to-end on a running app**, per the epic's verification bar: create a
workspace from the gateway with the app running and no window; open a window and
confirm it renders; rename in one window while dragging the layout in a second
and confirm both survive; quit and relaunch and confirm the registry is intact.

---

## Open questions — resolved

No item on this list is deferred; each names the chosen default and what it costs.

1. **Panel view state in the registry?** No — renderer-persisted, keyed by
   workspace id (§1.3). Cost: two persistence homes for one workspace, mitigated
   by disjoint field sets and GC on `workspace.removed`.
2. **Who owns `layoutModel`?** Renderer-authored, main-persisted (§1.3). Cost: a
   refinement of epic decision 4 that must be read as written, hence the explicit
   paragraph.
3. **One registry file or one per workspace?** One (§1.1). Cost: whole-file
   rewrites; bounded by the 250 ms debounce and the content-identical no-op.
4. **Full-snapshot broadcasts or deltas?** Deltas over the existing sequenced bus,
   with a snapshot only on gap/resync (§2.1). Cost: more event types; offset by
   reusing a reducer that already handles gaps.
5. **Does the source window get its own broadcast?** No — it learns from the
   invoke result (§2.2.3). Cost: the result path must carry normalization and
   rejection, which it already does.
6. **Legacy localStorage key.** Frozen for one release, then deleted (§3.3).
   Cost: a downgrade after one release loses that release's changes.
7. **Empty renderer state on hydrate.** Refuse and retry, never seed empty
   (§3.2). Cost: a user who genuinely removed every workspace without the intent
   record sees one extra boot before the registry seeds — acceptable against the
   alternative of silently wiping a real profile.
8. **Roster shape in the registry.** The full durable `AgentState` subset today's
   partialize keeps (`normalizers.ts:271-296`), not a slim roster. Cost: a larger
   file; the alternative loses `cliSessionId` / `cliResumeAvailable`, which are
   load-bearing for `claude --resume` and `codex resume`.
9. **Where does `revision` live — store or record?** Both: one store-level
   counter orders broadcasts, one per-record copy answers "is this record newer
   than mine" after a partial apply (§1.2).
10. **`sprintEngineAutoState` in the registry vs the automation sidecar.** The
    sidecar (`automation.json`) stays the authority for run intent — it is what
    the scheduler and the mobile snapshot read. The registry's copy is the display
    mirror the renderer already holds, written from the same broadcast. No third
    home, no new authority.
