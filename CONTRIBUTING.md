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
run more than one dev build side by side. Set `MULTICODE_RENDERER_PORT` to pin
a port, or `MULTICODE_USER_DATA_DIR` to pin a profile.

Some of the app's services are Python, and the full verification chain spawns
them for real. If you intend to run `npm run verify:app` or the Python tests,
set up a virtualenv as well — CI uses Python 3.12, matching the CPython the app
bundles:

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -r requirements-dev.txt   # only for the Python tests
```

Without it, the tests that spawn `sprintengine_core` fail on a missing PyYAML.
Plain `npm run dev` does not need the virtualenv.

To produce a build:

```
npm run build         # compile main, preload and renderer, then check the bundle budget
npm run dist:mac      # or dist:win / dist:linux — packages an installer
```

The `dist:*` scripts download the bundled agent runtimes first, so the first
run of one takes a while and needs network access.

## Running the gates

```
npm run test                                # the unit and contract suite
node scripts/testing/run-tests.mjs <file>   # one test file, or a name fragment
npm run typecheck:all                       # app and test projects
npm run lint                                # the design-system and composition lints
npm run verify:app                          # everything CI runs, in one command
```

`npm run verify:app` is the one that matters: it chains the typecheck, the
lints, the test suite, the SDK drift and pack checks, and the feed seed
checks. Run it before you open a pull request. It is the same command CI runs.

The Python suite is separate and scoped to `tests/`:

```
.venv/bin/python -m pytest tests/
```

Run it from the repository root and keep the `tests/` argument — a bare
`pytest` walks the bundled payloads under `resources/` and collapses.

While you are iterating, `node scripts/testing/run-tests.mjs <file>` is much
faster than the whole suite — pass a path or just part of a test file's name.

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
`scripts/lint-palette-contract.mjs`, `scripts/lint-primitive-duplication.mjs`,
`scripts/lint-door-surfaces.mjs` and
`scripts/lint-design-system-conformance.mjs`. If you change the design system
itself, `node design-system/scripts/lint.mjs` must also exit 0, and the
generated files (`foundations/tokens.css`, `catalog/index.html`) are rebuilt
by their build scripts rather than edited by hand.

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

The app is licensed under the Functional Source License, FSL-1.1-Apache-2.0,
which converts to Apache 2.0 two years after each version is released. See
[LICENSE](LICENSE). Everything under `packages/` — the module SDK — is MIT
instead, under its own LICENSE file.

When you contribute, you licence your contribution under the licence that
already covers the file you are changing: FSL-1.1-Apache-2.0 for the app, MIT
for anything under `packages/`. You keep the copyright in what you wrote.

**There is no CLA.** You are not asked to sign anything, and opening a pull
request is not an assignment of copyright. If that ever changes it will be
stated here first.

Only contribute code you have the right to contribute. If your employer owns
your work, get their sign-off before you open the pull request.
