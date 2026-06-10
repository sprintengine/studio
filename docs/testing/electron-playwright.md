# Electron Playwright Validation

Use this pattern when an agent needs to operate the real Multicode app for UI or end-to-end evidence. It keeps validation isolated from the user's normal Multicode window and profile.

## Current Repo State

- There is no checked-in `playwright.config.*`.
- Playwright is not a `package.json` dependency today.
- `.playwright-mcp/` is ignored and should remain local runtime state.
- `scripts/dev.js` supports isolated parallel app profiles through `MULTICODE_RENDERER_PORT`, `MULTICODE_USER_DATA_DIR`, and `MULTICODE_ALLOW_MULTI_INSTANCE`.

## Standard Launch Pattern

Build the app first:

```bash
npm run build
```

Run a Playwright-controlled Electron instance with a throwaway profile:

```bash
tmp=/tmp/multicode-playwright
npm --prefix "$tmp" install playwright --no-audit --no-fund

MULTICODE_PW_USER_DATA=/tmp/multicode-pw-user-data \
NODE_PATH="$tmp/node_modules" \
node scripts/testing/electron-playwright-smoke.mjs
```

The smoke helper launches:

- Electron from `node_modules/electron`.
- Main process entry `out/main/index.js`.
- `MULTICODE_USER_DATA_DIR=$MULTICODE_PW_USER_DATA`.
- `MULTICODE_ALLOW_MULTI_INSTANCE=1`.

## Inline Script Pattern

For task-specific validation, use the same shape:

```js
const { _electron: electron } = require('playwright')
const electronPath = require('./node_modules/electron')

const app = await electron.launch({
  executablePath: electronPath,
  args: ['./out/main/index.js'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    MULTICODE_USER_DATA_DIR: '/tmp/multicode-validation-user-data',
    MULTICODE_ALLOW_MULTI_INSTANCE: '1',
    MULTICODE_DIAGNOSTICS: '1',
    // Optional: bypass native folder pickers in dev/test builds only.
    // Must point at an existing directory.
    MULTICODE_TEST_OPEN_DIR: '/tmp/multicode-validation-workspace',
  },
})

const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
```

## Guardrails

- Do not use AppleScript or global window activation to drive Electron; it can target the user's normal app instance.
- Do not reuse `~/Library/Application Support/multicode` or the platform equivalent.
- Do not commit temp profiles, Playwright browser caches, traces, or screenshots unless the active task's owned evidence path explicitly asks for them.
- Prefer Playwright screenshots from `page.screenshot()` over desktop screenshots.
- Close the launched Electron app at the end of the script with `await app.close()`.

## Native Dialogs

Native folder/file dialogs are not reliable through Playwright locators. Do not stub `window.api.openDir()` in the renderer; the preload API is frozen and that replacement does not work.

For folder-picking flows, set `MULTICODE_TEST_OPEN_DIR` when launching the isolated Electron app:

```bash
mkdir -p /tmp/multicode-workspaces/example

MULTICODE_PW_USER_DATA=/tmp/multicode-pw-user-data \
MULTICODE_TEST_OPEN_DIR=/tmp/multicode-workspaces/example \
NODE_PATH="$tmp/node_modules" \
node scripts/testing/electron-playwright-smoke.mjs
```

The seam lives behind the main-process `fs:dialog:opendir` IPC handler, so validation still exercises preload and main-process IPC. It only activates when the app is not packaged and the env var names an existing directory. In packaged builds, setting `MULTICODE_TEST_OPEN_DIR` has no effect and the native dialog path remains active.

## Sprint Engine Live Glyph Harness

Use `scripts/testing/sprintengine-live-glyph-harness.mjs` to validate a real
Sprint Engine workspace row against an on-disk scratch run store. The harness
copies a schema-valid run shape into `/tmp`, opens it through the existing-team
workspace flow, advances `projection.json` through `in_progress`,
`needs_input`, and `done`, and writes screenshots plus a validation report under
the active sprint validation directory.

```bash
npm run build
tmp=/tmp/multicode-playwright
npm --prefix "$tmp" install playwright --no-audit --no-fund
NODE_PATH="$tmp/node_modules" node scripts/testing/sprintengine-live-glyph-harness.mjs
```
