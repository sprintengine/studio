# T11 Archive-epic rollup — Nuclear Review

Verdict: approved (GA-002 re-review). Prior GA-001 Blocking (C2) confirmed fixed.

## C2 (prior Blocking) — collision rename decoupled epic from children — RESOLVED

The GA-001 finding: epic↔child grouping keys on the epic's mutable filename stem
(`epicSlug`), so a `backlog/archived/<stem>.md` collision renamed the archived
epic to `<stem>-2.md` and orphaned its children into an "Unknown epic" scatter,
regressing AC2 in the exact branch AC3's collision naming feeds.

Fix verified in source + behavior:

- The collision/repoint logic was extracted into a **pure** planner,
  `planEpicArchive(epic, children, existingArchivedPaths)`
  (`src/renderer/src/utils/backlogEpics.ts:194`). It reserves the epic's
  collision-safe target **first** (so its final stem is known up front and no
  child can steal its name), derives `epicArchivedSlug`, sets `slugChanged`, and
  — only when the stem changed — marks every child `repointEpic: <new stem>`.
- `archiveEpicRollup` (`src/renderer/src/components/panels/BacklogPanel.tsx:761`)
  rewrites each flagged child's `epic:` frontmatter via `updateBacklogEpic`
  **before** `moveItemToArchive`, so the archived child copy carries the matching
  pointer and stays grouped. No-collision path re-points nothing.
- Tests now cover the previously-untested branch behaviorally
  (`backlogEpics.test.ts`): no-collision (no re-point), collision
  (`epic→auth-2`, both children `repointEpic: 'auth-2'`), and `groupItemsByEpic`
  over the post-rename state asserting **one** epic group, not empty-epic +
  Unknown scatter.

Ran locally: `npm run typecheck` (0 errors), `test:renderer:backlog-epics`
(15 ok, incl. the 3 above), `test:renderer:backlog-row` (rollup wiring ok).

## Acceptance

- AC1 — "Archive epic" swaps in for "Archive" on epic rows (context menu +
  detail overflow), rolls up active children then the epic. ✓
- AC2 — archived epic + children render as one group, default-collapsed in the
  archived lens; holds in the collision branch. ✓
- AC3 — reuses `moveItemToArchive` / `nextArchiveRelativePath`; no new archive
  mechanism. ✓
- AC4 — tests cover the rollup; typecheck + suites pass. ✓

## Maintainability

- Single-item archive and the rollup share one `moveItemToArchive` helper — no
  drift, partial-write cleanup preserved.
- The genuinely complex collision/repoint logic lives in the small pure
  `backlogEpics.ts` (DOM/IPC-free, unit-tested), not bloating the panel — correct
  decomposition. `EpicArchiveMove.repointEpic: string | null` is explicit and
  documented, not a hidden mode.
- Children-first ordering + re-scan-on-failure keeps a mid-batch failure
  recoverable.

## Residual risk

- `BacklogPanel.tsx` is 1992 lines — already oversized before T11 (net +~61 here).
  Not introduced by this task and decomposing the panel is out of scope; flagged
  for a future split, not blocking.
- `collapsedGroups` means "flipped from default" with the default keyed on `view`;
  a slug toggled while active carries its flip into the archived lens. Minor UX
  quirk, not blocking.
- Live IPC file-move path not exercised end-to-end; covered by source contracts +
  the pre-existing single-item archive path. Acceptable for this gate.
