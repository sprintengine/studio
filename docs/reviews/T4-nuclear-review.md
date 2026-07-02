# T4 Nuclear Review — live catalog generator (gate: nuclear_reviewer, attempt GA-001)

Reviewed: commit `18645e39` plus the uncommitted companion edits still in the worktree.
Verdict: **changes_requested** — one blocking finding, and it is about the publish, not the code.

The generator itself clears the nuclear bar comfortably. `build-catalog.mjs` is a dependency-free,
bundle-traveling template whose header documents the full emission contract, including *why* the nav is
radio-driven rather than fragment links (fragment navigation verified destructive in a scripts-off
srcdoc iframe, and the `<base>` workaround breaks standalone use — the failure analysis lives in the
artifact where the next maintainer will read it). Output is a pure function of the bundle files —
byte-identical regen is golden-tested. Failures are loud with distinct exit codes; the empty bundle is
a designed state, not an error page. Template and example copies verified byte-identical (`cmp`). Both
test suites re-run green here: build-catalog 12/12, derived-file-runner 8/8, and the 12 cases exercise
the real acceptance surface (self-containment, auto-appear, skeleton, scoped demo CSS, mode-patch
restore). At 992 lines the script sits just under the large-file bar; single-file is the portability
contract, and the internal sectioning (tokens → CSS scoping → embed extraction → markdown → section
builders → main) keeps it scannable. The runner's alphabetical→declaration-order change is the minimal
correct mechanism for the tokens-before-catalog dependency, documented at the code site and in the KG.

## Blocking

1. **Three claimed deliverables are not committed.** T4's publish commit `18645e39` captured only
   `resources/design-system/` (the task's owned paths). Still uncommitted in the shared worktree:
   `src/main/design-system/derived-file-runner.ts` (the declaration-order fix),
   `src/main/design-system/derived-file-runner.test.ts`, and
   `src/shared/design-system/build-catalog.test.ts` — all listed as delivered evidence, all outside
   the owned paths, exactly the orphan-path publish gap. At the current branch tip a clean checkout is
   broken three ways: (a) `verify:app` fails — `package.json` (committed via the T5 sweep) wires
   `test:shared:design-system-build-catalog` to a test file that is not in git; (b) the committed
   runner still runs generators alphabetically, so regeneration runs build-catalog *before*
   build-tokens and inlines a stale `tokens.css` — the acceptance-relevant regen order only exists
   uncommitted; (c) the committed KG note documents declaration-order runner behavior the committed
   code does not have — contract drift at tip. Required: commit the three files under T4
   (`sprintengine.vcs.commit` with explicit paths, or expand ownedPaths) so the branch tip matches the
   evidence. The evidence itself was honest about the package.json sweep; the gap is only that the
   companion files never landed.

## Important

2. **Silent dark-mode degradation on tokens.css format drift.** The mode toggle is built by
   `parseTokensCss` re-parsing the derived `foundations/tokens.css` line format (a documented pinned
   contract — and the right call: parsing the *resolved* CSS avoids reimplementing build-tokens' alias
   resolution). But if that emission format ever drifts, the parse yields an empty `dark` set and the
   toggle silently becomes a no-op — no error, a checkbox that does nothing. The script already reads
   `tokens.tokens.json` and has `tokenIsModeVarying`; add the one cross-check: fail loudly when the
   token source declares mode-varying tokens but the parsed dark override set is empty.

## Minor

3. `ds-embed-component-${escapeHtml(component.name)}` HTML-escapes the name inside the class
   attribute while `scopeCss(..., `.ds-embed-component-${component.name}`)` uses it raw in the
   selector — the two diverge for any name containing an escapable character. Names are lint-
   constrained to kebab-case, so use the raw validated name in both (or assert the constraint);
   escaping one side implies non-conforming names are supported when they are not.

## Residual risk

- The regex CSS splitter (`splitRules`/`scopeCss`) will mis-split on `{}` inside quoted strings
  (e.g. `content: "}"`) in demo CSS. Acceptable for designer-authored demo styles in a zero-dependency
  script; noting so nobody hardens it into a general CSS parser later — if it ever needs that, the
  answer is a real parser at the app layer, not more regex here.
- Declaration-order execution relies on JSON key order surviving `JSON.parse` — spec-guaranteed and
  now documented in code + KG + scaffold (which writes tokens first), but it is an implicit contract
  every future manifest author inherits.
- Playwright srcdoc/standalone interaction claims accepted on the evidence narrative plus the header's
  recorded failure analysis; I did not re-drive the browser harness. Suites, determinism, template
  parity, and runner order were re-verified here directly.
- No export/PNG affordance found anywhere in the diff (acceptance) — the stray `catalog-*.png`
  screenshots from the developer's verification were cleaned up before publish.
