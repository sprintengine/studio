# T5 Nuclear Review — design-system authoring preset (gate: nuclear_reviewer, attempt GA-001)

Reviewed commit: `3b46e596` (29 files, +1229/−114). Verdict: **changes_requested**.

Overall the change is well-seamed: the main-process scaffold is Electron-free and port-injected
(`src/main/design-system/bundle-scaffold.ts` + `templates-path.ts` split), failures are explicit
(`ok:false` with cause, no partial-success masking, manifest self-check + read-back), the never-overwrite
resume invariant is tested, the dedicated role prompt is real (no shared Soul fetch, USAGE.md-bound,
own `DESIGN_SYSTEM_READY` marker), and both KG notes were updated in the same publish. Tests are
meaningful, not smoke: I re-ran bundle-scaffold (5/5), new-workspace-controllers, guidedBriefFlow,
guidedBriefSlice, and sessionAdapter (esm) — all green.

The findings below are structural-decay vectors, filed now because T7/T9/T10 build directly on these
exact seams.

## Blocking

1. **Cross-boundary constant duplication** —
   `src/renderer/src/components/workspace/guidedBrief/designArtifacts.ts:74` redefines
   `DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME = 'design-system'`, already exported by
   `src/main/design-system/bundle-scaffold.ts:21`. The main process *writes* that directory; the
   renderer *indexes and watches* it (`useDesignerSession.ts`) and the session adapter derives the
   marker-detection artifact path from it. If they drift, the scaffold writes one tree and the studio
   silently watches another — no error surfaces. `sessionAdapter.ts` also hardcodes
   `'design-system.json'` instead of `DESIGN_SYSTEM_MANIFEST_FILENAME` from
   `src/shared/design-system/manifest.ts`. The canonical home already exists:
   `src/shared/design-system/bundle-scaffold.ts`. Move the directory-name constant there, import it
   from both processes, and reuse the shared manifest-filename constant in the adapter.

2. **Runtime-state literal duplicated across controllers** —
   `controllers/designSystemController.ts:70–95` copies the ~25-field `GuidedBriefRuntimeState`
   literal (and the verbatim `GuidedBriefWorkspaceError` catch-and-wrap block) from
   `controllers/guidedBriefController.ts:79–91,124–149`. Required fields are type-enforced, but
   *optional* fields are not: `acceptedProductOverview`/`acceptedArchitectureOverview` are already
   optional fields the two literals could diverge on, and every future optional runtime field will
   silently ship half-initialized in one preset. Extract a shared initial-runtime-state builder
   (defaults + per-preset overrides) and a shared error-wrap helper both controllers call. The task
   card's "following the runGuidedBriefScaffold shape" justifies the separate controller file, not the
   copied literal.

## Important

3. **Preset copy resolved by repeated nested ternaries** — `NewWorkspacePanel.tsx` `GuidedIdeaStep`
   (~3010–3160): the third preset is threaded through five separate
   `isDesignSystemPreset ? … : isDesignPreset ? … : …` chains (field label, placeholder, hint text,
   role-toggle title/body, skip note, footer note), plus the double-negative
   `active={isDesignPreset && !isDesignSystemPreset}` where `preset === 'frontend-design'` says it
   directly. This is the "repeated conditionals signaling a missing model" pattern: a per-preset copy
   record keyed by `GuidedBriefPreset` collapses all five chains and makes the fourth preset a
   one-entry addition instead of five more ternary layers. `isDesignPreset` now actually means
   "design-only studio preset" — rename or derive it from the copy table.

4. **T4 wiring swept into T5's commit** — `package.json` in this commit adds
   `test:shared:design-system-build-catalog` and wires it into `verify:app`, but
   `src/shared/design-system/build-catalog.test.ts` and
   `resources/design-system/templates/scripts/build-catalog.mjs` are **not in the commit** — they are
   in-flight uncommitted worktree files owned by T4 (shared-worktree concurrency sweep). At `3b46e596`
   standalone, `verify:app` fails on a missing test file. This self-heals when T4 publishes, but if T4
   is reworked or renamed the dangling wiring lands on main under T5's name. Confirm with T4/the
   architect that the catalog files ship before epic merge, or move the script wiring into T4's
   publish.

## Residual risk

- `NewWorkspacePanel.tsx` is 4030 lines and grew +154. Placement was task-directed ("in
  GuidedIdeaStep… not a new mode-grid card"), so not a T5 finding, but the file is far past
  decomposition size; `GuidedIdeaStep` is a clean extraction candidate for a follow-up.
- The `designSystem` optional-mode threading (`useDesignerSession` boolean →
  `sessionAdapter`/`specialistActions` optional object) is a nullable mode by the letter of the bar,
  but it is the task-directed design ("traced through sessionAdapter.ts kind:'designer'"), each branch
  is small and local, and defaults leave the two existing presets untouched — acceptable. If a fourth
  designer variant ever appears, promote it to a real variant kind rather than a second optional.
- The scaffolded manifest's `derived` map declares `scripts/build-catalog.mjs` before that template
  exists; verified the derived-file runner records a missing generator as observable `missing` status,
  not a failure — intentional authoring-time state, fine.
- Not re-run: `npm run typecheck` / `npm run lint` (implementer evidence claims 0/0; five test suites
  re-run green above corroborate). Runtime studio flow (three-pane render, DesignFilesPane, preview)
  not driven end-to-end here — that is the tester gate's scope.
