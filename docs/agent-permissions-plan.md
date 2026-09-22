# Agent-specific permissions

## Implementation

1. Keep the persisted `none`, `manual`, `auto`, and `bypass` ids compatible.
   Resolve menu labels, short labels, help text, accessible names, and remote
   fallback notices from the selected runtime. Codex calls `bypass` **YOLO**;
   Claude Code calls it **Bypass permissions**. Keep the existing menu components.
   Bind the picker’s permission control to its highlighted model, including
   search results and favourites, so browsing another runtime edits that row.
2. Make Codex Manual explicit: read-only sandbox with on-request approvals.
   None continues to inherit CLI configuration; Auto uses the workspace sandbox
   with no approval prompts; YOLO disables approval prompts and the sandbox.
3. Render native Windows Codex arguments through the same manifest renderer as
   POSIX and WSL. Retain the Windows working-directory argument and npm-shim
   handling. Use the existing quote-preserving native invocation so prompts and
   TOML configuration reach the executable intact.
4. Test the menu against both runtimes, mode switching, remote restrictions,
   all four launch presets, resume, context, and native Windows argument passing.
   Run typechecking and repository gates, then inspect the final diff.

## Evidence and limits

The UI used shared labels and mixed runtime-specific help. Codex Manual supplied
no arguments, so it inherited configuration just like None. Native Windows used
a separate argument builder and PowerShell splatting, bypassing the shared
renderer and the quote-preserving invocation used by other agents.

The reported Windows YOLO spawn error has not been reproduced on this Mac.
Its exact message and runtime version are needed to determine whether these
launch defects explain that specific failure. Native Windows execution tests
must run on Windows; argument-rendering tests run on every platform.

Work stays on the existing shared branch. No commit or pull request is created.

## Verification

- Final targeted run: 12 test files passed, 19 tests passed, and the native
  Windows execution test was skipped on macOS. This includes mounted picker
  interactions, cross-provider search, keyboard navigation, saving against the
  highlighted model, remote restrictions, automation copy, and launch rendering.
- Full suite: 596 files passed; one failure was in the concurrently developed
  `InstalledSkillsPanel.test.tsx` focus-restoration test.
- Lint, unused-code checks, SDK drift, SDK/mobile package checks, feed checks,
  and release tests passed.
- The combined gate is not green: the final typecheck reports a nullable
  `Element` argument in the concurrently developed `utils/controlTab.ts`.
  An earlier combined run also stopped at formatting in concurrent skills work.
  Those changes were left to their owners.
- Native Windows execution and the originally reported error remain to be
  confirmed on Windows. The implementation fixes the observed launch-code
  defects; it does not claim that the unprovided error has been reproduced.
