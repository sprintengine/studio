# Clipboard Bridge Review Handoff - 2026-06-01

## Purpose

This document summarizes the clipboard-related changes made after the terminal
copy/paste regression investigation on 2026-06-01. It is intended for review by
another set of agents.

## User-Visible Problem

The user attempted to:

1. Click `Copy` on an error notification in the notifications popover.
2. Right-click in a terminal to paste.

The pasted terminal did not receive the notification text. Earlier debugging
also looked at xterm selection copy/paste, but the concrete workflow that still
failed was notification-copy into terminal-paste.

## Confirmed Root Cause

The notification Copy button still used the renderer browser Clipboard API:

- `navigator.clipboard.writeText(details)`

That write failed silently because errors were swallowed, and the notification
was still marked read. Meanwhile the terminal paste path had been changed to
read from the new Electron clipboard bridge. This created a mismatch:

- notification copy wrote through browser clipboard, or failed silently
- terminal paste read through Electron clipboard

The running dev app also contributed to confusion: the Electron process was
started before the new main/preload clipboard bridge existed. Renderer hot
reload can update React code, but it does not reliably update main/preload IPC.
In that state, `window.api.clipboardWriteText` is unavailable and the
notification Copy button shows `Copy failed`.

## Architecture Direction

Clipboard operations in this Electron desktop app should use Electron's native
clipboard from the main process through preload IPC, not the browser
`navigator.clipboard` API. This avoids renderer permission/user-activation
timing and makes copy/paste behavior consistent across notifications,
terminals, Git controls, settings, voice dictation, and standard text inputs.

## Clipboard IPC

Added:

- `src/main/ipc/clipboard-ipc.ts`
  - Registers `clipboard:read-text`.
  - Registers `clipboard:write-text`.
  - Uses Electron `clipboard.readText()` and `clipboard.writeText(...)`.
- `src/preload/api/clipboard.ts`
  - Exposes `clipboardReadText()`.
  - Exposes `clipboardWriteText(text)`.
- `src/main/register-core-ipc.ts`
  - Calls `registerClipboardIpc(ipcMain)`.
- `src/preload/index.ts`
  - Adds `...clipboardApi` to `window.api`.
- `src/shared/electron-api.ts`
  - Adds the typed preload methods to `ElectronApi`.

Reviewer focus:

- Confirm IPC channel names match between preload and main.
- Confirm the clipboard bridge is registered before renderer code can invoke it.
- Confirm no security-sensitive data is logged or persisted.
- Confirm renderer cannot invoke arbitrary clipboard operations beyond read/write
  text.

## Notification Copy

Changed:

- `src/renderer/src/components/workspace/topbar/NotificationsPopover.tsx`

Behavior now:

- Builds the same notification details payload as before.
- Calls `window.api.clipboardWriteText(details)`.
- Marks the notification read only after copy succeeds.
- Shows `Copy failed` next to the button when the bridge is unavailable or the
  write fails.

Why:

- The old code swallowed `navigator.clipboard.writeText(...)` errors and marked
  the notification read regardless.
- That made failed copy look successful.

Reviewer focus:

- Decide whether showing `Copy failed` inline is sufficient UX.
- Consider whether a toast/diagnostic should be added for clipboard failures.
- Confirm the notification should not be marked read when copy fails.

## Terminal Copy/Paste

Changed:

- `src/renderer/src/utils/terminalClipboard.ts`
- `src/renderer/src/utils/terminalClipboard.test.ts`

Behavior now:

- Terminal clipboard operations use the Electron clipboard bridge.
- The helper no longer calls `navigator.clipboard`.
- Terminal right-click with selected text copies that text.
- Terminal right-click without selected text pastes clipboard text into the PTY.
- The helper tracks xterm selection with `term.onSelectionChange` and captures
  selection in the `mousedown` capture phase because xterm/browser event order
  can clear selection before `contextmenu`.
- A short in-memory `lastTerminalCopiedText` remains as a terminal-local backup
  for the immediate right-click-copy/right-click-paste flow if clipboard read
  fails. This does not replace OS clipboard writes; it only prevents the exact
  terminal workflow from eating the text after it was captured.

Why:

- The old terminal helper checked `term.hasSelection()` / `term.getSelection()`
  at `contextmenu` time only.
- That is fragile because xterm or browser event ordering can clear selection
  before `contextmenu`.
- The old helper also used browser clipboard APIs and swallowed errors.

Reviewer focus:

- Confirm the local `lastTerminalCopiedText` backup is acceptable or recommend
  removing it for stricter clipboard-only behavior.
- Confirm right-click behavior should remain:
  - selected text means copy
  - no selected text means paste
- Confirm terminal paste should not use bracketed paste here. Existing terminal
  helper currently normalizes newlines and writes via `terminalWrite`.
- Confirm xterm and terminal-owned paste flows still bypass the app-wide paste
  bridge.

## App-Wide Paste Bridge

Added:

- `src/renderer/src/utils/clipboardPasteBridge.ts`
- `src/renderer/src/utils/clipboardPasteBridge.test.ts`

Wired from:

- `src/renderer/src/main.tsx`

Behavior:

- Installs one document-level paste listener.
- If a normal paste event already contains text, it does nothing and lets the
  browser/native input behavior proceed.
- If a paste event has no `text/plain` data, it reads from
  `window.api.clipboardReadText()`.
- Inserts text into focused:
  - `input`
  - `textarea`
  - `[contenteditable="true"]`
  - `[contenteditable="plaintext-only"]`
- Dispatches an `InputEvent` with `inputType: "insertFromPaste"` so React and
  controlled inputs can observe the value change.
- Skips `.xterm` and `.monaco-editor` surfaces because those editors own their
  own paste models.

Why:

- The user wants Electron clipboard paste to work in other text-entry surfaces,
  including Git commit message, worktree name, branch fields, and search boxes.
- Patching every input individually would be error-prone and incomplete.

Reviewer focus:

- Confirm this bridge does not interfere with native paste when event clipboard
  data is present.
- Confirm skipping xterm and Monaco is correct.
- Confirm controlled React inputs update reliably with `setRangeText` plus
  `InputEvent`.
- Confirm contenteditable support is acceptable; if too risky, narrow scope to
  `input` and `textarea`.

## Other Copy Call Sites Replaced

Replaced direct browser clipboard writes with `window.api.clipboardWriteText`:

- `src/renderer/src/components/panels/GitPanel.tsx`
  - Commit hash / subject copy actions.
- `src/renderer/src/components/settings/MobileSettingsTab.tsx`
  - Mobile pairing code copy.
- `src/renderer/src/hooks/useVoiceDictation.ts`
  - Transcription copied to clipboard.
- `src/renderer/src/components/workspace/topbar/NotificationsPopover.tsx`
  - Notification details copy.
- `src/renderer/src/utils/terminalClipboard.ts`
  - Terminal copy/paste helper.

Confirmed by search:

- No `navigator.clipboard` references remain under `src/renderer/src`,
  `src/preload`, `src/main`, or `src/shared`.
- No `execCommand("copy")` path remains in source.

## Tests Added Or Updated

Added:

- `src/renderer/src/utils/terminalClipboard.test.ts`
  - Covers terminal right-click copy clearing selection.
  - Covers xterm selection disappearing before `contextmenu`.
  - Covers contextmenu without prior right-button mousedown.
  - Covers stale xterm selection after copy.
  - Covers fallback to last terminal-copied text if clipboard read fails.
- `src/renderer/src/utils/clipboardPasteBridge.test.ts`
  - Covers Electron clipboard paste into normal input.
  - Covers leaving normal browser paste data alone.
  - Covers skipping terminal-owned textareas under `.xterm`.

Updated:

- `package.json`
  - Adds `test:renderer:terminal-clipboard`.
  - Adds `test:renderer:clipboard-paste-bridge`.
  - Includes both in `verify:app`.

## Knowledge Graph Update

Updated:

- `knowledge/multicode/workspace-shell.md`

Why:

- Clipboard behavior is a durable workspace-shell / terminal interaction
  contract.
- The note now documents:
  - terminal clipboard path uses Electron clipboard IPC
  - ordinary editable fields use the app-wide paste bridge
  - xterm and Monaco are excluded from the generic bridge

## Verification Run

Commands run successfully:

- `npm run test:renderer:voice-transcription`
- `npm run test:renderer:terminal-clipboard`
- `npm run test:renderer:clipboard-paste-bridge`
- `npm run typecheck:app`
- `npm run typecheck:tests`
- `git diff --check`

Search verification:

- `rg -n "navigator\\.clipboard|execCommand\\(['\\\"]copy" src/renderer/src src/preload src/main src/shared`
  returned no matches.

## Runtime Caveat

Testing this change in the already-running Electron dev app will fail until the
app is fully restarted.

Reason:

- The clipboard bridge adds main/preload IPC.
- Renderer hot reload can update React components.
- It does not reliably reload Electron main/preload APIs.

Required manual test setup:

1. Stop the current Electron dev app.
2. Start it again with `npm run dev`.
3. Test notification Copy into terminal paste.
4. Test copy/paste into Git commit message, branch/worktree fields, and search
   boxes.

## Known Unrelated Dirty Files

These files were already dirty or changed by other work during this session and
are not required for the clipboard bridge:

- `src/renderer/src/components/settings/SettingsPanel.tsx`
- `src/renderer/src/components/ui/WorkspacePanel.tsx`
- `src/renderer/src/components/workspace/WorkspaceManager.tsx`
- `src/renderer/src/components/workspace/WorkspaceTopBar.tsx`
- `src/renderer/src/store/slices/settingsSlice.ts`
- `src/renderer/src/store/slices/settingsSlice.test.ts`

Reviewers should avoid attributing those changes to the clipboard fix unless
they are explicitly included in the review scope.

## Files In Clipboard Review Scope

- `knowledge/multicode/workspace-shell.md`
- `package.json`
- `src/main/ipc/clipboard-ipc.ts`
- `src/main/register-core-ipc.ts`
- `src/preload/api/clipboard.ts`
- `src/preload/index.ts`
- `src/shared/electron-api.ts`
- `src/renderer/src/main.tsx`
- `src/renderer/src/components/panels/GitPanel.tsx`
- `src/renderer/src/components/settings/MobileSettingsTab.tsx`
- `src/renderer/src/components/workspace/topbar/NotificationsPopover.tsx`
- `src/renderer/src/hooks/useVoiceDictation.ts`
- `src/renderer/src/utils/terminalClipboard.ts`
- `src/renderer/src/utils/terminalClipboard.test.ts`
- `src/renderer/src/utils/clipboardPasteBridge.ts`
- `src/renderer/src/utils/clipboardPasteBridge.test.ts`

## Open Review Questions

- Should notification copy failure produce a toast or diagnostic instead of only
  inline `Copy failed` text?
- Should terminal `lastTerminalCopiedText` be retained as a local backup, or
  should terminal paste be strictly clipboard-only?
- Should the app-wide paste bridge handle only `input`/`textarea`, or is
  contenteditable support desired?
- Should other non-text clipboard formats be explicitly ignored in the bridge?
- Should `clipboard:write-text` reject non-string inputs instead of writing an
  empty string?
