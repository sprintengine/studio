# Contributing

Thanks for wanting to work on SprintEngine Studio. This file covers how to get
the app running, which gates have to be green before a pull request is ready,
and the terms your contribution comes in under.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

You need **Node 22** and npm. The repository carries a `.nvmrc`, so `nvm use`
picks the right version; CI runs Node 22 as well.

```
git clone https://github.com/sprintengine/studio.git
cd studio
npm ci
npm run dev
```

`npm ci` runs a postinstall step that restores the executable bit on the
`node-pty` spawn helper on macOS — that is expected, and terminals will not
start without it.

`npm run dev` starts the Electron main process and the renderer dev server
together. It takes port 5173 by default; if that port is busy it moves to the
next free one and gives that instance its own user-data directory, so you can
run more than one dev build side by side. Set `SPRINTENGINE_RENDERER_PORT` to
pin a port, or `SPRINTENGINE_USER_DATA_DIR` to pin a profile. Every variable the
app owns was spelled `MULTICODE_*` before the 2026-09-08 rename and is still
read under that name, so an old export in your shell profile keeps working.

The toolchain is Node and nothing else. No gate in this repository needs a
Python on your machine, and the app neither ships nor resolves one.

To produce a build:

```
npm run build         # compile main, preload and renderer, then check the bundle budget
npm run dist:mac      # or dist:win / dist:linux — packages an installer
```

The `dist:*` scripts download the bundled agent runtimes first, so the first
run of one takes a while and needs network access.

## Running the gates

```
npm test                                    # the unit and contract suite (Vitest)
npx vitest <file or name fragment>          # one file, re-run on save
npm run test:coverage                       # the suite with a coverage report
npm run typecheck:all                       # app and test projects
npm run lint                                # oxlint, then the design-system and composition lints
npm run format                              # format with Prettier (format:check only checks)
npm run verify:app                          # everything CI runs, in one command
```

Formatting is Prettier's and is checked in CI; run `npm run format` before you
commit rather than arguing with it. The linter is oxlint, configured in
`.oxlintrc.json`, where every rule that is off says why. `exhaustive-deps`
findings are warnings: fix the one you touched, but a dependency array is a
behaviour decision, so do not change one only to silence the linter.

The tree was reformatted in one commit, listed in `.git-blame-ignore-revs`.
GitHub's blame view skips it on its own; locally, run
`git config blame.ignoreRevsFile .git-blame-ignore-revs` once.

`npm run verify:app` is the one that matters: it chains the typecheck of both
the app and the test projects, the lints, the test suite, the SDK drift and
pack checks, and the feed seed checks. Run it before you open a pull request.
It is the same command CI runs.

There is one suite, with no Python half. `npm test` runs Vitest over every
`*.test.ts` and `*.test.tsx` under `src/`, `packages/` and
`resources/marketplace/` (`vitest.config.ts`). Tests sit next to the code they
test. `tests/` holds what they share: the setup every worker runs
(`tests/setup.ts`), stand-ins for modules that only exist inside Electron
(`tests/stubs/`, `tests/stand-in.ts`) and fixtures. Each test runs with the
app's own `SPRINTENGINE_*` and `MULTICODE_*` variables removed from its
environment, so the suite behaves the same from a Studio terminal as from CI.
The suites that assert on timing run in a `serial` project, one file at a time,
after the rest. The release-script tests under `scripts/release/` run as
`npm run test:release`, and the lint guard probes as part of `npm run lint` —
both are in `verify:app`.

Most suites predate Vitest: each file is one `test()` that walks its cases in
order and asserts with `node:assert/strict`, because the cases share state and
their order matters. Write a new file with a `test()` per case, and split an
old one the same way when you are working in it anyway.

## The design-system rule

UI contributions must consume the design system in `design-system/` rather
than restyling around it. `design-system/USAGE.md` is the contract; read it
before you touch anything visual. In short:

- Style only with the `--sem-*` semantic tokens from
  `design-system/foundations/tokens.css`. The `--ref-*` variables are internal
  plumbing and are not for component code.
- Never hard-code a colour, space, control height, radius, duration or
  z-index. If the scale is missing a step, add it to the token source instead
  of writing a local pixel value.
- Reuse a component from `design-system/components/` before building a new
  one, and read its `component.md` for anatomy, states and accessibility
  behaviour. `design-system/catalog/index.html` shows what exists.
- Dark mode comes from the semantic variables. Do not write per-mode
  overrides.
- Two font families exist permanently, `--sem-font-family-ui` and
  `--sem-font-family-mono`. Adding a third is a system change, not a styling
  choice.

This is enforced, not advisory. `npm run lint` runs
`scripts/lint-design-tokens.mjs`, `scripts/lint-panel-composition.mjs`,
`scripts/lint-primitive-duplication.mjs`,
`scripts/lint-door-surfaces.mjs` and
`scripts/lint-design-system-conformance.mjs`. If you change the design system
itself, `node design-system/scripts/lint.mjs` must also exit 0, and the
generated files (`foundations/tokens.css`, `catalog/index.html`) are rebuilt
by their build scripts rather than edited by hand.

## Changing a wire format

Two of the app's protocols are spoken to software this repository does not ship:
another Studio on a tailnet, and the phone app. Both ends update separately, so
a change to either wire is a compatibility decision, not a local edit — which
version integer moves, whether a capability flag would do instead, and which of
the enforcement sites have to agree.

[`docs/compatibility.md`](docs/compatibility.md) is the policy, and it is short.
Read it before you change anything that crosses either wire.

## Names that do not go in the tree

This repository was private for most of its life, and three habits from then
have to stay dead. All are about names, and all are cheap to get right while you
are writing the line.

**No competitor product names.** Not in comments, not in test names, not in
assertion messages, not in a `component.md`. A comment exists to explain why the
code is shaped the way it is, and that reason always survives without the name:
"⌘⇧M toggles the model picker (X's `modelPicker.toggle`, adopted)" is a sentence
about why the chord sits on that key, and should be written as one. Citing
another product's internal identifiers is worse than naming it, because it reads
as having had its source open alongside ours.

The rewrite is never a deletion. Dropping the sentence and leaving an
unexplained constant behind loses the only thing that was worth keeping. If a
ruling has a date, keep the date — `(owner ruling 2026-09-10)` is useful; the
clause naming whose launcher prompted it is not.

The agent CLIs the app drives — Claude Code, Codex, Cursor, OpenCode, Gemini,
Grok — are runtimes it integrates with, not competitors. Name them freely; they
are part of what the app is.

**No backlog ticket numbers.** The backlog is private to the machine it lives
on, so `(MC-2183)` in a comment is a link nobody outside can follow. Say what
the ticket changed — "since workspace creation moved to main", not "since
MC-2158" — or leave it out when the sentence stands without it. A backlog key
used as data (a fixture's `MC-240`, an example of the id format) is fine.

**No real identities in fixtures.** A test fixture needs a plausible value, not
a true one, and the tree already has the placeholders:

| Instead of | Use |
|---|---|
| A real home directory | `/Users/dev/…`, `/Users/me/…` |
| A real tailnet id | `tail1234.ts.net`, `example.ts.net` |
| A real machine name | `mac-mini`, `dev-macbook-air`, `android-phone`, `build-box` |
| A real email or account handle | `dev@example.com`, `acme` |
| A real repository or private package | `github.com/acme/app` |

The same goes for absolute paths in doc comments that use a machine as a worked
example: the example is the point, the machine is not.

**Generated files are not edited.** `design-system/catalog/index.html` and
`design-system/foundations/tokens.css` are built from their sources. Fix the
`component.md` or the token source and rebuild
(`node design-system/scripts/build-catalog.mjs`) — a hand-edit is reverted by
the next build and passes review looking correct.

None of this is enforced by a lint. It is checked when the change is reviewed,
so the cost of getting it wrong is a round trip.

## Commit messages

Commit subjects in this repository are plain English sentences that say what
is now true, in the present tense. They describe the change and its point, not
the mechanics. No type prefixes, no ticket numbers, no trailing full stop.

Real examples from the log:

```
The file tree says what each file IS
An image attachment opens in the system viewer
OpenCode's config env takes the context path as a JSON literal
The peek stopped closing itself a frame after it opened
The test projects typecheck again
```

Write the body, if you need one, the same way: prose explaining why the change
was made and anything a reviewer would otherwise have to reconstruct.

## Pull requests

- Branch off `main`.
- Keep the change to one thing. A refactor and a behaviour change in the same
  pull request are hard to review and harder to revert.
- `npm run verify:app` must be green. A pull request with a failing gate will
  not be merged, and CI runs the same commands.
- Describe what changed and why in the same voice as the commit messages.
- If the change is user-visible, say how you checked it in the running app.

## Licence and contribution terms

The repository is licensed under the MIT License. See [LICENSE](LICENSE).
`packages/module-sdk` and `packages/mobile-control-protocol` each carry their
own MIT licence file as well.

When you contribute, you licence your contribution under MIT. You keep the
copyright in what you wrote.

**There is no CLA.** You are not asked to sign anything, and opening a pull
request is not an assignment of copyright. If that ever changes it will be
stated here first.

Only contribute code you have the right to contribute. If your employer owns
your work, get their sign-off before you open the pull request.
