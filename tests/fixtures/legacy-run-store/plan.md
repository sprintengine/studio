# Architect Plan — Mobile relay traffic: pay for signal, not polling

**Run:** `mobile-relay-traffic-efficiency2` · single repo `primary` = `multicode` (desktop)
**Goal:** Mobile relay traffic — pay for signal, not polling.
**Source (canonical, read in place):** `backlog/epics/mobile-relay-traffic-efficiency.md` (epic MC-1597).

---

## 1. Situation: most of this epic is already landed

The epic audit (2026-07-14) is real, but the code has moved since it was written. Verified
current state across the three repos (`../multicode`, `../multicode-mobile`, `../multiauth`):

| Child | What | Repo(s) | Current state (verified in code) |
|---|---|---|---|
| 1598 | Demand-gate the 2 s desktop poll + idle backoff | multicode | **DONE.** `shouldPollCommands()` = `hasActivePairedDevice() \|\| pairingChallenge` gates `pollRelayCommands`; backoff ladder 2 s→30 s ceiling over a 150 s attention window is live (`bridge/index.ts:970,1058-1069,1004-1010`). |
| 1603 | Transport spike (decision doc) | analysis | **DONE.** Recommendation: ship status-quo+adaptive now, fix `snapshotVersion` first, then long-poll; reject websocket/push. Filed 1605–1609. |
| 1599 | `knownSnapshotVersion` "unchanged" fast-path — desktop half | multicode | **Built but INERT.** `dispatchSnapshotRequest` already returns `{ok, unchanged:true, snapshotVersion}` on match (`snapshot-request.ts:64-66`). It never fires in steady state — see §2. |
| 1600 | Scoped snapshots + leaner default — desktop half | multicode | **Landed.** `sprintEngineId`/`workspacePath`/`include` scoping + `filterToDefaultSnapshotStatePaths` exist end-to-end desktop-side (`snapshot-request.ts:84-122`). No mobile caller sends a scope yet. |
| 1601 | Client cadence hygiene | multicode-mobile | Ready. Phone-only. |
| 1602 | Relay ledger/token purge + entitlement cache | multiauth | Ready. Relay-only. |
| 1606 | Long-poll desktop commands | multiauth + multicode | Ready. Needs the relay route first. |
| 1607 | Delete dead push/activity/publishSnapshot scaffolding | all three | Ready. Cross-repo, dead code (zero runtime cost). |
| 1608 | Phone half of 1599 (`knownSnapshotVersion`) | multicode-mobile | Ready. Depends on 1605. |
| 1609 | Phone half of 1600 (scoped requests + cache merge) | multicode-mobile | Ready. |

**The one critical, cleanly-multicode item that is not done and blocks the dominant byte win is
1605.** That is this run's centerpiece.

---

## 2. The load-bearing bug: `snapshotVersion` is not content-stable

`buildSnapshotVersion` (`src/main/mobile/sprintengine/snapshot.ts:1432`) is
`snap_${sha256(JSON.stringify(value)).slice(0,24)}` — content-derived, good. **But** the
top-level `value` folds `updatedAt: generatedAt`, where `generatedAt = new Date().toISOString()`
is stamped fresh on every read (`snapshot.ts:281,318-323`). So the top-level version changes on
every single generation even when nothing changed.

Consequence: the phone's If-None-Match (`knownSnapshotVersion`) can **never** match on a full
snapshot, so the 1599 fast-path (`snapshot-request.ts:64-66`) is dead in steady state. An idle
foregrounded phone re-ships the full ~8 KB snapshot every 20 s forever — the epic's #2 ranked
cost driver. Per-engine sub-versions (`snapshot.ts:450-458`) already hash their own run mtime and
*are* content-stable; only the top-level fold is wrong.

Two secondary gaps that would silently break change-detection if we naively drop `generatedAt`:
the top-level hash currently **omits `backlog` and `automations`**, so a backlog-only or
automations-only change would stop bumping the version once the wall-clock is removed. 1605 must
add those into the hashed content in the same change.

---

## 3. Scope decision (load-bearing) — single repo, 1605-centric

**Decision: scope this run to the `primary` (multicode) repo and deliver 1605 as the one
substantive change, plus its verification and before/after traffic evidence.**

Rationale:
- The run is provisioned with exactly one VCS repo (`sprintengine.vcs.status` → `repos:[primary]`).
  `multicode-mobile` and `multiauth` are separate sibling git checkouts this worktree cannot commit to.
- 1605 is the highest-leverage remaining item and is 100 % inside multicode. Landing it activates
  the already-shipped 1599 desktop fast-path, removing the epic's dominant per-read byte cost with
  no wire/protocol change and no re-pair.
- Every other open item is either phone-only (1601/1608/1609), relay-only (1602), needs a relay
  counterpart first (1606), or is cross-repo dead-code hygiene with no traffic impact (1607).

**Rejected alternative — expand this run to all three repos via `sprintengine.vcs.request_repo`**
and also take 1601/1602/1606/1608/1609. Rejected: it multiplies scope and risk well beyond what
this run was provisioned for; those items are independently tracked backlog items best executed in
their own repo-scoped sprints (especially 1606, which must first prove Railway/Next.js held-request
limits); and 1605 delivers the dominant win on its own. The follow-ups are enumerated in §7 so the
epic thread stays intact. **If the reviewer wants the broader multi-repo scope, send this plan back
and I will re-plan with `request_repo` expansion.**

**Autonomy note:** auto-run is active and this plan is written without a live user round-trip. The
single-repo scope above is the conservative default chosen rather than asking; the plan gate is the
intended checkpoint for redirecting it. No questions were withheld beyond that scope choice.

---

## 4. Pinned contracts (do not re-invent)

These are the exact seams the impl must respect. All are already on the wire; 1605 changes only how
the **top-level** version token is computed — no shape, field, protocol-version, or scope change.

**Protocol / wire (frozen):**
- `mobileControlProtocolVersion = 2` — **stays v2.** No new field, no new relay scope, no re-pair.
- `snapshot.request` payload (all optional, additive; unchanged by this run):
  `{ sprintEngineId?: string, workspacePath?: string, knownSnapshotVersion?: string, include?: MobileSnapshotCollection[] }`.
- Unchanged fast-path response (already implemented, `snapshot-request.ts:64-66`):
  `{ ok: true, unchanged: true, snapshotVersion: string }` (~419 B) vs a full ~8 KB payload.

**Version primitive (the only thing 1605 edits):**
- Keep `buildSnapshotVersion(value) => snap_${sha256(JSON.stringify(value)).slice(0,24)}`
  (`snapshot.ts:1432`) as the hash primitive — do **not** change its signature or the `snap_` prefix.
- Remove wall-clock from the **top-level** hashed value: the hash input must not include
  `generatedAt`/any per-read timestamp (`snapshot.ts:281,318-323`). `generatedAt` may still appear
  in the emitted snapshot object for display; it just must not feed the hash.
- Add `backlog` and `automations` content into the top-level hashed value so those-only changes
  still bump the version.
- Preserve per-engine sub-version hashing (`snapshot.ts:450-458`) and the MC-1567 invariant: a
  sprint-engine task/artifact/status change still changes the top-level version (it already folds
  the per-engine versions, which are content-stable — keep that path).

**Snapshot composition (frozen — 1600 already did this, do not touch):**
- `filterToDefaultSnapshotStatePaths` (unscoped default: live runs + 3 most-recent terminal) stays.
- Shedding ladder order (roles → automations `recentRuns` → whole engines newest-kept-first) is the
  contract; scoped requests skip both the terminal filter and the ladder. 1605 does not alter either.

**Out of bounds for this run (other repos):** `mobileControlClient.ts` / `SessionDataProvider.tsx`
(multicode-mobile) and `relay.ts` / `store.ts` / migrations (multiauth). Not committable here.

---

## 5. Execution approach & task graph

Roles available: architect, developer, frontend, ui_ux_reviewer, tester, nuclear_reviewer,
spec_reviewer. This is desktop main-process TypeScript with no UI surface (the only diagnostics
line shipped with 1598), so **frontend and ui_ux_reviewer are not scheduled** — no work matches them.

```
T0  architect   Plan + graph approval gate .......................... (this task)
T1  developer   1605: content-stable snapshotVersion + unit tests + KG note
T2  tester      Verify 1605 + measure before/after idle-read traffic ... depends: T1
T3  nuclear_reviewer  Final nuclear sign-off ......................... depends: T1, T2
T4  spec_reviewer     Final spec/contract sign-off ................... depends: T1, T2
```

- **T1 (developer):** implement §4's version change in `snapshot.ts`; ship unit tests proving
  determinism and change-detection; update the KG protocol note (see §6). Owns `snapshot.ts`,
  its test file, and the two KG notes.
- **T2 (tester):** independent verification + the epic-mandated **measured before/after traffic
  evidence** for one idle foregrounded phone: prove the top-level version is now stable across
  consecutive idle reads and that the 1599 fast-path fires (full read ≈ 8 KB → unchanged ≈ 419 B).
  Confirm backlog-only and automations-only changes each still bump the version.
- **T3 / T4 (reviewers):** nuclear_reviewer audits correctness/regression risk (esp. the MC-1567
  change-detection invariant and the shedding ladder being untouched); spec_reviewer confirms the
  wire contract is unchanged (still v2, no new field/scope, response shapes intact) and the KG note
  matches the code. Both depend on all impl+test.

---

## 6. KG updates required in the same publish (T1 owns)

Per the epic's cross-cutting acceptance, the notes 1605 invalidates must be updated in the same
publish (these files live in `docs/`, so they are editable from this repo):
- `docs/multicode-mobile/protocol.md` — the item-1599 section says the fast-path "cannot fire
  in steady state" because `readSnapshot` folds wall-clock `generatedAt` and omits
  backlog/automations. After 1605, update it to: top-level version is content-derived and
  content-complete (incl. backlog + automations, excl. wall-clock); fast-path now fires. Still v2.
- `docs/multicode/mobile-bridge.md` — refresh any `snapshotVersion` precondition wording so it
  states the version is content-stable across idle reads.

Do **not** edit `docs/multiauth/relay.md` or `docs/multicode-mobile.md` push/ledger
claims — those correspond to relay/mobile code this run does not change; editing them would make the
KG lie about code that still exists.

---

## 7. Out of scope for this run — follow-ups to keep the epic thread intact

These remain open and are correctly tracked as their own backlog items; each needs its own
repo-scoped run (or a `request_repo` expansion of this one):
- **1608** (multicode-mobile) — phone sends `knownSnapshotVersion`, handles `unchanged`. **Directly
  unblocked by 1605**; the natural next step to realize the phone-side byte win.
- **1609** (multicode-mobile) — phone requests scoped snapshots + merges into cache.
- **1601** (multicode-mobile) — result-poll backoff, drop redundant re-reads, lightweight fleet.
- **1602** (multiauth) — ledger/token purge jobs + ~60 s entitlement cache + cheaper idle poll.
- **1606** (multiauth + multicode) — long-poll the desktop command endpoint (verify held-request
  limits first).
- **1607** (all three) — delete dead `publishSnapshot`/`MobileSprintEngineActivityPublisher`/push
  scaffolding. Hygiene only; no traffic impact.

---

## 8. Decision ledger

- **Confirmed by source/KG:** protocol stays v2; scopes frozen at pair time; shedding-ladder order
  is contract; 1598 & 1603 done; 1599/1600 desktop halves shipped.
- **Repo-answered (read from code):** `snapshotVersion` top-level hash folds wall-clock
  `generatedAt` and omits backlog/automations → 1599 fast-path inert; scoping already threaded
  desktop-side; desktop push/activity paths are dead (no production callers).
- **Defaulted (autonomy, conservative):** single-repo scope; 1605-centric graph; frontend/ux
  reviewer roles unused; per-engine version path left intact.
- **Open questions / for reviewer:** (a) accept single-repo scope, or expand to 3 repos for
  1601/1602/1606/1608/1609? (b) include the multicode slice of 1607 dead-code deletion in this run?
  Default is no — it reduces no traffic and can't be coherently completed cross-repo from here.
