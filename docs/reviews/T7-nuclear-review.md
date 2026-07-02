# T7 Nuclear Review — "Save as design system" completion action (gate: nuclear_reviewer)

## GA-002 addendum — rework verified, approved

Rework commit `aecf80d1` resolves both C2 required actions; verified against the diff, not the
claims:

1. `releaseDesignSystemBundle` now delegates its lint gate to `runDesignSystemBundleLint`
   (`library-registry.ts:122-136`): the duplicated fork block and the dead `BUNDLE_LINT_SCRIPT`
   const are gone (−13 net lines), only the release-specific findings copy stays in the
   `stage: 'lint'` mapping, and the misconfiguration/missing-script messages pass through from the
   single implementation. The lint exit contract now exists exactly once, so the studio preview
   and the release gate structurally cannot drift.
2. `GuidedBriefStartBuildError` gains a dedicated `'design-system-preset'` code, thrown directly —
   no post-construction message mutation. Better than the minimum asked: the exhaustive
   `guidedBriefStartBuildErrorMessage` switch in `NewWorkspacePanel.tsx` (a required companion
   edit — typecheck forced it) now carries real user copy for the refusal alongside every other
   code, and the copy chain to the flow is intact (`NewWorkspacePanel.tsx:1977` maps the code
   before rethrowing). The controllers test asserts the code, not the message string.

Re-verified here: library-registry 6/6 (lint failure still blocks with findings, nothing
copied/stamped), bundle-lint-run 3/3, new-workspace-controllers ok, typecheck exit 0, lint 0
violations, worktree clean. No new structural issues in the rework diff — it is a pure
deletion/delegation plus a union extension. The two GA-001 advisories (GuidedBriefFlow.tsx size
trajectory; unwired slice/flow test scripts) stand as non-blocking notes. **Verdict: approved.**

---

# Original review (GA-001)

Reviewed commits: `1e9d821b` (T7 publish) + `85ac7ffa` (frontend-gate a11y fix, committed under T7)
plus the T7-authored main/preload/shared surface that was scooped into the T8 commit `76e1e009`
(`src/main/design-system/bundle-lint-run.ts`, the `design-system:lint-bundle` IPC in
`src/main/ipc/design-system-ipc.ts`, `src/preload/api/design-system.ts`, `src/shared/electron-api.ts`)
— shared-worktree commit attribution, all changes are on the branch tip.

Verdict: **changes_requested** (1 blocking structural finding, 1 minor required fix, 2 advisory notes).

## What holds up well

- The phase model is the right shape: `designSystemRelease.ts` is a pure discriminated union
  (`idle | validating | releasing | released | lint-failed | error`) with every transition mapped
  from an observed IPC result — no timers, no invented success, no boolean sprawl. The UI file
  holds only orchestration + JSX; the logic is unit-tested where it lives.
- No new special-case leak into shared paths: the design-system branch in `GuidedBriefFlow.tsx`
  swaps the whole primary action via the existing `isDesignSystemPreset` seam the file already
  has; `renderPrimaryAction` and the other presets' tails are untouched (controllers/flow suites
  re-run green here).
- `designSystemLastRelease` persistence follows the slice's established normalize-or-null pattern
  (`normalizeDesignSystemSeedSource` twin), preset-scoped so other presets can never carry it;
  round-trip/malformed/off-preset all asserted.
- The start-build refusal for the preset is a loud typed error, not a silent no-op — right
  fallback discipline for an unreachable-by-design path.
- Boundary types are explicit end-to-end (`DesignSystemBundleLintRunResult` shared type, no casts
  on the IPC seam beyond the file's standard `unknown` argument guards).
- KG notes (`knowledge/multicode/guided-brief.md`, `knowledge/multicode/design-system-bundle.md`)
  updated in the same publish and match the shipped behavior.

## Blocking

1. **Duplicated lint exit-contract interpretation** —
   `src/main/design-system/bundle-lint-run.ts:17-38` re-implements, line for line, the lint gate
   that already lives inside `releaseDesignSystemBundle`
   (`src/main/design-system/library-registry.ts:125-150`): resolve `scripts/lint.mjs`, missing-file
   → "not a complete design-system bundle" error, fork, exit 0 = clean, exit 1 = findings on
   stdout, anything else = misconfiguration with the same stderr/stdout/no-output fallback chain.
   The template lint's exit contract is now encoded twice in the same directory; the two copies
   already diverge in message text and one uses `stat`-try/catch while the other uses `pathExists`.
   If the contract ever moves (new exit code, findings on stderr, renamed script) one copy will be
   fixed and the other missed — and the "preview is never a bypass" invariant breaks silently,
   because preview and gate would then disagree about the same bundle.
   **Required:** one canonical runner — have `releaseDesignSystemBundle` call
   `runDesignSystemBundleLint(bundleDir, fork)` and map `DesignSystemBundleLintRunResult` onto its
   `stage: 'lint'` returns (findings → `lintFindings`, error → message; the release-specific
   "Fix them and release again." copy can stay in the mapping). Both suites
   (`bundle-lint-run.test.ts`, `library-registry.test.ts`) exist to keep this honest.

## Important (required, minor)

2. **Typed refusal filed under the `'unknown'` catch-all** —
   `guidedBriefController.ts:151-155` constructs `GuidedBriefStartBuildError('unknown')` and then
   mutates `.message` post-construction. `'unknown'` exists for genuinely unclassified failures
   (line 239); this is the opposite — the most deliberate, documented refusal in the function.
   It works only because the flow's catch falls back to `error.message`; any caller branching on
   `code` sees noise. **Required:** add a dedicated code (e.g. `'design-system-preset'`) to the
   union and construct it directly, no message mutation.

## Advisory (not blocking)

- `GuidedBriefFlow.tsx` grew 1656 → 1806 lines. The pure model was correctly extracted, and the
  local `renderDesignSystemReleaseAction` helper matches the file's existing convention
  (`renderPrimaryAction`), so this is consistent — but the module is far past comfortable scanning
  size and each preset feature accretes here. When next touched, the design-system release cluster
  (action renderer + findings strip + footer status branch, ~130 lines) is a clean candidate to
  move to a sibling component file next to `designSystemRelease.ts`. Filing as trajectory, not a
  T7 defect.
- `guidedBriefSlice.test.ts` and `guidedBriefFlow.test.ts` still have no `package.json` script
  (run ad-hoc via esbuild→node; both re-run green here). Pre-existing gap, noted for whichever
  task next touches the suite wiring; the two suites T7 added are properly wired into
  `verify:app`.

## Verification re-run for this review

`test:renderer:design-system-release` ok; `test:main:design-system-bundle-lint-run` 3/3 ok;
`test:renderer:new-workspace-controllers` ok (incl. the preset refusal); guidedBriefSlice +
guidedBriefFlow ad-hoc bundles exit 0. Claimed evidence matched observed behavior; no
hallucinated files or tests. Live end-to-end release remains T12's exercise, as declared.
