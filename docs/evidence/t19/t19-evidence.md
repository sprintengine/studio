# T19 evidence — attach/runner hardening + catalog stage overflow

## F1 — symlink confinement (attach + library release)

- `src/main/design-system/bundle-copy-confinement.ts`: `findEscapingSymlink` walks the bundle; refuses absolute link targets, relative links whose realpath escapes the bundle, and unresolvable links. Relative links confined to the bundle stay allowed (they survive a verbatim copy correctly).
- `src/main/design-system/attach.ts` refuses before the staging copy (stage `source`); `src/main/design-system/library-registry.ts` refuses at the top of the release pipeline, before lint/stamp/regen run any bundle script (new stage `source` in `src/shared/design-system/library.ts`).
- Tests: `src/main/design-system/attach.test.ts` ("a bundle with symlinks escaping the source…" — absolute + `../` shapes refused, workspace empty, confined internal link still attaches); `src/main/design-system/library-registry.test.ts` ("a bundle with a symlink escaping the source refuses the release…").

## F3 — derived script confinement

- `src/main/design-system/derived-file-runner.ts`: `isConfinedBundleScript` — bundle-relative, no empty/`.`/`..` segments, `.mjs` only — checked before `join`+fork; refusal is a `failed` run with `exitCode: null` and a `refused…` stderr, result message says `refused: escapes the bundle`.
- Test: `src/main/design-system/derived-file-runner.test.ts` — `derived: {x: "../../evil.mjs"}` with a real planted script writing a marker file: run refused, marker never written; absolute and non-`.mjs` shapes also refused.

## F4 — minimal env allowlist

- `src/main/design-system/bundle-script-env.ts`: `BUNDLE_SCRIPT_ENV_ALLOWLIST` (PATH, HOME, TMPDIR + Windows equivalents; no `NODE_*` — NODE_OPTIONS is an injection vector). `utility-process-fork.ts` passes `env: bundleScriptEnv(process.env)` to `utilityProcess.fork`.
- Test: forks a real node process under the projection with planted fake secrets; only allowlisted keys (plus macOS libc-injected `__CF_USER_TEXT_ENCODING`) reach the script.

## T17 LOW — catalog stage overflow

- `.catalog-stage` gains `overflow-x: auto` in `resources/design-system/templates/scripts/build-catalog.mjs` and the example mirror (byte-identical, verified by diff); example `catalog/index.html` regenerated (3-line CSS diff only).
- Regenerated page: 0 `<script>` tags, 0 external refs (grep).
- 390x844 Chromium render over local http, Button view: stage computes `overflow-x: auto`, `scrollWidth 364 > clientWidth 348` (scrollable). Screenshots:
  - `docs/evidence/t19/t19-button-390x844-default.png` — fourth (disabled) variant peeking, stage scrollable.
  - `docs/evidence/t19/t19-button-390x844-scrolled.png` — stage scrolled to end, all four variants fully visible.

## Verification

- `npm run typecheck` exit 0; `npm run lint` 0 violations.
- Design-system suites green: attach, library, derived-runner, bundle-scaffold, bundle-lint-run, schema, lint, build-tokens, build-catalog, renderer release, renderer attach-step.

## Residual

- The env allowlist is verified via the projection applied to a real node fork; the live Electron `utilityProcess` path itself is exercised only in-app (scripts are stdlib-only and use no env, all suites green).
