# T21 — Live-Electron Verification: Grouped Backlog Panel + Epic/Risk Flows

Task: T21 (tester) · Date: 2026-06-27 · Tester: tester

## Verdict

**Ready (conditional).** All 9 in-scope user-visible flows were exercised live in the
real built Electron app and passed. Frontmatter-only mutation confirmed for epic and
risk changes (items.json carried no lifecycle write). One Low finding (F-1): the
archive path denormalizes `status:"archived"` into items.json, against the schema-v2
"sidecar holds no lifecycle" invariant — functionally harmless today, recorded for the
architect. No source/test files edited; repo dogfood data untouched (all mutations ran
in an isolated `/tmp` workspace).

## Environment

- App: Playwright `_electron` driving the **worktree build** `out/main/index.js`
  (`npm run build` in this worktree; `ELECTRON_RENDERER_URL` unset → built renderer,
  not a stale dev server).
- Isolated profile `MULTICODE_USER_DATA_DIR=/tmp/multicode-t21/user-data`,
  `MULTICODE_ALLOW_MULTI_INSTANCE=1`, `MULTIAUTH_BASE_URL` dead-routed.
- Workspace `/tmp/multicode-t21/workspace` = copy of repo `backlog/` (116 entries, 2
  epics × 5 children) + `.multi-code/backlog/items.json` (113 records). Standard
  workspace created via the New-workspace wizard; Backlog panel opened from the rail.
- Driver + raw result/screenshots are out-of-repo (session scratchpad):
  `t21-driver.mjs`, `shots/t21-result.json`, `shots/t21-0*.png`. Reproduce with
  `npm run build` then run the driver with `NODE_PATH` pointing at a Playwright install
  and the parent checkout `node_modules`.
- Baseline (pre-run) `items.json`: 113 records, **0** carrying any
  status/epic/risk/difficulty/criticality/type key (clean schema-v2 sidecar).

## Per-flow results (all verified live)

| ID | Flow | Result | Evidence |
|----|------|--------|----------|
| F1 | Group axis **off** → flat list | PASS | 112 option rows, **0** epic-header controls in the listbox, option ids sequential `backlog-opt-0..n` → markup path unchanged from ungrouped. (`t21-01-flat.png`) |
| F2 | Group axis **by epic** → headers + done/total + No-epic | PASS | Headers rendered: **Automations Platform 3/5**, **Backlog Platform 2/5**, **No epic 37/100** (rollups read from `aria-label="N of M complete"`). (`t21-02-grouped.png`) |
| F3 | j/k nav + selection across groups | PASS | Pressing `j` advanced `aria-activedescendant` `backlog-opt-0→1→…→7`, crossing the header→child boundary. (`t21-03-jknav.png`) |
| F4 | Collapse / expand epic group | PASS | Rows 113 → collapse Automations → 108 (−5 children as a unit) → expand → 113. (`t21-04a-collapsed.png`) |
| F5 | Context-menu Move to epic / New epic / Remove | PASS | Move→`epic: backlog-platform` written to `.md` frontmatter; New epic→prompt created `backlog/epics/t21-new-epic.md` + `epic: t21-new-epic`; Remove→`epic:` line gone. **items.json record stayed lifecycle-free throughout.** (`t21-05-epic-context.png`) |
| F6 | Risk axis set → derived row recolor | PASS | Set risk=High (diff=m) via Risk flyout: row left-stripe `rgba(0,0,0,0)` → `rgb(255,140,66)`; `.md` gained `risk: high`; items.json record still has no risk/status/difficulty key. (`t21-06-risk-recolor.png`) |
| F7 | Manual highlight wins + survives risk change | PASS | Manual highlight stripe `rgb(255,90,95)` (red); after setting risk=High the stripe stayed `rgb(255,90,95)` (manual wins over derived heat). highlight `{starred:false,color:"red"}` in items.json (app-owned); `risk: high` in frontmatter. (`t21-07-highlight-wins.png`) |
| F8 | Best sort ordering | PASS | Best top-8 differs from Recently-updated; deterministic; leads with high-criticality items per `compareBacklogItems('best')` (criticality↓, risk↑, effort↑). (`t21-08-best-sort.png`) |
| F9 | Archive-epic rollup (one unit) | PASS | "Archive epic" on Automations Platform moved the epic + all 5 children into `backlog/archived/`; Archived lens shows the archived epic group **default-collapsed** (Expand control present). (`t21-09-archive-rollup.png`) |

## AC coverage

- **AC1** report with per-flow steps/result/evidence — this file. ✓
- **AC2** every listed flow verified live with evidence; none claimed without it. ✓
- **AC3** frontmatter-only mutation confirmed on epic (F5) and risk (F6/F7) changes —
  `.md` frontmatter updated, the item's items.json record carried no lifecycle field.
  Baseline + post-run sidecar diff: only app-owned `highlight` was added (expected). ✓
  (See finding F-1 for the one archive-path exception.)
- **AC4** no source/test files edited; defects recorded as findings below; repo dogfood
  data untouched (`git status` clean). ✓

## Findings (for architect → developer follow-up; not fixed in this task)

### F-1 (Low) — Archive writes a lifecycle field (`status:"archived"`) into items.json

- **Severity** Low. **Owner** developer.
- **Observed:** After the F9 archive-epic rollup, all 6 archived records (epic +
  5 children) carry `status:"archived"` in `/tmp` workspace `.multi-code/backlog/items.json`
  (baseline had 0 lifecycle keys). Written by
  `moveBacklogObjectSource` — `src/main/backlog-service.ts:425`
  (`status: …startsWith('backlog/archived/') ? 'archived' : record.status`).
- **Why it's a defect:** Archived-ness is **path-derived** by the reader
  (`src/renderer/src/utils/backlog.ts:310`, `isArchivedBacklogPath`), so the sidecar
  `status` is never read back — orphaned data that violates the documented schema-v2
  invariant "sidecar carries no lifecycle" (`backlog-service.ts:298-301`, `499-500`).
  The same code already avoids seeding `status` in `mutateItem` *precisely* to stop the
  lazy migrator from overwriting real frontmatter status; `moveBacklogObjectSource`
  contradicts that.
- **Latent (NOT reproduced):** `status` ∈ `MIGRATABLE_FRONTMATTER_FIELDS`
  (`backlog-service.ts:63`); if `readBacklogObjectStore`→`loadMigratedStore` runs while
  these orphaned values are present, the migrator would push `status:archived` into the
  archived files' frontmatter ("sidecar wins"), overwriting their true pre-archive status
  (e.g. a child whose frontmatter is `status: ready`). I attempted to trigger this by
  relaunching the app on the same workspace and opening Backlog: the migration did **not**
  fire (the panel scan path uses `loadStore`, not `loadMigratedStore`), and the archived
  child frontmatter stayed `status: ready`. So the data-loss path is latent, not confirmed
  reachable through normal UI flows.
- **Repro:** archive any item/epic, inspect its items.json record → `status:"archived"`.
- **Suggested fix:** stop writing `status` in `moveBacklogObjectSource` (archived-ness is
  already path-derived), or have the archive path clear the sidecar lifecycle key.

### F-2 (Info) — Stale code comment claims triage lives in items.json

- `src/renderer/src/components/panels/BacklogPanel.tsx:824-826` says triage
  (difficulty/criticality/risk) "persist to the backlog object store (items.json) …
  never markdown frontmatter". Under schema-v2 these route through
  `updateBacklogTriage`→`writeBacklogFrontmatter` (frontmatter), as F6 confirmed live.
  Doc-drift only; no behavior impact. Owner: developer.

## Residual risk / not exercised

- F1 "byte-identical to before" verified at behavior level (flat list, 0 headers,
  sequential option ids) — a literal byte-for-byte DOM snapshot diff against a
  pre-grouping build was not performed.
- The Backlog panel runs in **single-column** mode at sidebar width (< 600px split
  threshold); F6/F7 risk + F5 epic edits were driven via the row context menu (same
  `BacklogActions` vocabulary as the detail-pane Triage `Select`, per
  `BacklogItemContextMenu.tsx`), so the split-pane Triage `Select` surface itself was
  not separately click-driven. Underlying action/IPC/frontmatter path is identical.
- Drag-to-agent, send-to-agent, and unknown/dangling-epic ("Unknown epic") grouping
  were out of scope and not exercised.
