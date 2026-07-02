# T8 Nuclear Review — attach machinery (gate: nuclear_reviewer, GA-001)

Reviewed commits: `4d4ced09` (package.json wiring) + `76e1e009` (attach core, IPC, preload, shared
types). The KG note update (`knowledge/multicode/design-system-bundle.md` "Attach" section) rode
T7's commit `1e9d821b` via shared-worktree scooping — content verified correct on the branch tip.

Verdict: **approved** (no blocking findings; two advisory notes below).

## What holds up well

- `src/main/design-system/attach.ts` (178 lines) is a single-purpose, Electron-free module that
  takes `libraryRoot` as an argument (no hidden globals) and **reuses the canonical readers**
  instead of duplicating validation: library sources resolve through
  `readDesignSystemLibraryEntry` (which already guards name/version path composition), and every
  manifest touch goes through `parseDesignSystemManifest`. No casts, no `any`, no optional churn.
- The failure contract is an explicit discriminated union
  (`DesignSystemAttachResult`, stages `request | source | target | conflict | copy`) with the
  stage taxonomy documented at the type. Every failure path verified in tests to leave the
  workspace untouched — right fallback discipline, no invented success.
- The conflict-never-overwrite invariant is structural, not incidental: existing dir *or* plain
  file at `design-system/` refuses before staging; a mid-copy appearance of the target is
  re-checked in the error path and reported as `conflict` rather than a generic copy error.
- Source immutability is real: the provenance stamp is written into the staging copy only, and a
  test asserts the source bundle byte-state survives. Unknown top-level and provenance manifest
  fields survive the stamp round-trip (asserted).
- IPC (`design-system:attach`) and preload additions follow `design-system-ipc.ts` /
  `preload/api/design-system.ts` conventions exactly (unknown-shaped args guarded at the boundary,
  typed `request` refusals instead of throws).
- KG-independence acceptance verified by read and by grep: the module imports only `fs/promises` /
  `path`; zero `process.env` reads anywhere in the attach path.
- Evidence re-verified here: attach suite 5/5 (real temp dirs), library-registry suite green
  (no regression), unknown-field assertions present at `attach.test.ts:86-87`.

## Advisory (not blocking)

1. **Staged-copy idiom now exists twice in the directory** — `attach.ts:145-175` mirrors
   `library-registry.ts:205-235` (rm staging → cp → rename; on error rm staging, re-check final
   path for a concurrent-appearance conflict, typed copy failure; then manifest read-back
   verification). The two differ in real ways (release mkdirs the parent and stages per-version;
   messages carry flow-specific recovery copy), each is self-contained and independently tested,
   and unlike a shared contract nothing breaks silently if they drift — so this sits at the
   rule-of-three boundary rather than over it. Acceptance condition: the **next** consumer of
   atomic bundle placement (re-attach/update is already deferred backlog) must extract a canonical
   staged-copy helper in this directory rather than adding a third inline copy; either flow's
   author touching this block should do the same.
2. **Fourth private fs-probe helper in `src/main/design-system/`** — `statKind` (attach.ts:26)
   joins three per-file `pathExists` copies (library-registry.ts:36, bundle-scaffold.ts:86,
   derived-file-runner.ts:41). The per-module-private convention predates T8 and `statKind` is a
   genuinely richer probe, so no action required on T8 — but a directory-local fs-util module
   would delete three duplicates whenever someone is next in here.

## Residual risk

- Two concurrent attaches into the same workspace share one staging dirname
  (`.design-system-attach-staging`); interleaved rm/cp could corrupt the loser's staging before
  the winner's rename. Single-user single-renderer action makes this practically unreachable in
  v1; noting it so the future extraction (advisory 1) can pick unique staging names.
- Live IPC exercise from the T9 entry-point UI is that task's scope; this review verified the
  machinery via its node-level suite plus the handler's argument guards by read.
