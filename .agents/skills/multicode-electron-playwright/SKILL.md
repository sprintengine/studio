---
name: multicode-electron-playwright
description: Launch and validate the real Multicode Electron app with Playwright. Use for UI, renderer, Electron, workspace-flow, module-toggle, screenshot, or end-to-end validation that must avoid the user's normal Multicode profile and app instance.
---

# Multicode Electron Playwright

Use this skill when validation needs the real Multicode Electron app, not renderer unit tests or static inspection.

## Core Rules

- Build first with `npm run build`; launch `out/main/index.js` through Electron.
- Always use an isolated `MULTICODE_USER_DATA_DIR` under `/tmp` and set `MULTICODE_ALLOW_MULTI_INSTANCE=1`.
- Do not drive the user's normal Electron instance with AppleScript, global app activation, or OS-level window targeting.
- Prefer Playwright `_electron` control so screenshots and locators attach only to the launched validation app.
- Store temporary Playwright installs and user data under `/tmp`; do not commit `.playwright-mcp/`, screenshots, traces, or generated profiles unless a task-owned evidence path asks for them.
- Native file pickers are hard to automate. Do not stub `window.api.openDir`; the preload API is frozen. For folder-selection validation, launch the isolated app with `MULTICODE_TEST_OPEN_DIR=/tmp/path-to-existing-folder`. The seam lives in the main-process `fs:dialog:opendir` handler, only works when the app is not packaged, and still exercises preload/main IPC. State the env var and selected real folder in evidence.

## Quick Start

If Playwright is installed locally:

```bash
node scripts/testing/electron-playwright-smoke.mjs
```

If the repo does not have Playwright installed, use a temp install:

```bash
tmp=/tmp/multicode-playwright
npm --prefix "$tmp" install playwright --no-audit --no-fund
NODE_PATH="$tmp/node_modules" node scripts/testing/electron-playwright-smoke.mjs
```

Folder-selection flow example:

```bash
mkdir -p /tmp/multicode-validation-workspace
MULTICODE_TEST_OPEN_DIR=/tmp/multicode-validation-workspace \
NODE_PATH="$tmp/node_modules" \
node scripts/testing/electron-playwright-smoke.mjs
```

The reusable details live in `docs/testing/electron-playwright.md`.
