# T5 Spec Review - Automations Workspace Mode

Verdict: changes_requested

Sources reviewed:
- T5 task card, acceptance criteria, implementation comments C1/C3, frontend finding C2.
- Architect plan: `.multi-code/sprintengine/2026-06-17-automations-platform/plan.md`.
- Knowledge notes: `knowledge/README.md`, `knowledge/multicode/automations.md`, `knowledge/brand/panel-design-system.md`, `knowledge/multicode/watchtower.md`.
- Code paths: renderer module/workspace registration, `AutomationsPanel`, new-workspace automations flow, preload/electron API bridge, main IPC, engine, executor, renderer automation delegate.

Verification run during review:
- `npm run test:renderer:bundled-workspace-types` - passed; existing esbuild `import.meta` CJS warnings only.
- `npm run test:main:automations-ipc` - passed.

Requirements met or substantially covered:
- `automations` workspace type is registered with icon, `--accent-primary`, template, picker order, and module gating.
- Renderer mutations use `window.api` automations IPC; no renderer store-file access found.
- Definition list, run-history list, create/edit form, loading/error/empty states, status labels, and non-color-only glyphs are present.
- KG note was updated for the renderer control center contract.

Findings:

[HIGH] E2E create -> run-now -> open launched agent is not satisfied from the Automations workspace mode.

Requirement:
- Acceptance: "End-to-end on real data: create -> see nextRun -> run-now -> see the run record -> open the launched agent tab."
- Plan: Automations is managed from a dedicated `automations` workspace mode; with zero code a user can schedule a review and launch an agent.

Location:
- `src/renderer/src/components/workspace/newWorkspace/controllers/automationsController.ts:20`
- `src/renderer/src/components/panels/AutomationsPanel.tsx:741`
- `src/renderer/src/components/panels/AutomationsPanel.tsx:858`
- `src/main/automations/executor-local.ts:140`
- `src/renderer/src/hooks/useAutomationRequests.ts:87`
- `src/renderer/src/components/panels/AutomationsPanel.tsx:706`

What I found:
- The new-workspace flow creates an `automations` mode workspace for the selected folder.
- The editor hides `workspaceId` and `folderPath`, then saves an action config containing only schema-exposed fields such as `prompt`.
- The executor defaults the action target to `workspaceRoot`, finds an existing workspace by that folder, and delegates `agent.launch` to that workspace id.
- The renderer automation delegate rejects `agent.launch` unless the target workspace mode is `standard`.
- The run-history "Open agent" button only calls `setActiveWorkspace(run.workspaceId)` and ignores `run.agentId`; it does not focus or add the launched agent tab via the existing model registry helpers.

Why it matters:
- A user who creates the specified Automations workspace can create a definition and see `nextRun`, but `run-now` can fail before launching the agent because the target workspace is itself `automations`, not `standard`.
- Even when a run record has `agentId`, the UI action does not guarantee opening the launched agent tab.

Required fix:
- Define and implement the real launch target for Automations actions. Either support agent tabs in Automations workspaces, or make the executor resolve/create a standard target workspace for the project instead of selecting the Automations control-center workspace by folder.
- Preserve enough target data in the definition/action config or resolver to make this deterministic.
- Update "Open agent" to focus/add the concrete `run.agentId` tab in `run.workspaceId` after revealing the workspace, using the existing model registry path or an equivalent reveal target.

Verification:
- Add or run real-path coverage for create -> nextRun -> run-now -> run record -> focused launched agent tab from an Automations workspace.

[HIGH] Disabled and permission-denied/unavailable states can render as blank or stuck loading instead of explicit states.

Requirement:
- Acceptance: "Empty, loading, disabled, permission-denied, and missing-integration states all render (no blank/broken surface)."

Location:
- `src/renderer/src/components/workspace/WorkspaceLayout.tsx:150`
- `src/renderer/src/components/workspace/WorkspaceLayout.tsx:549`
- `src/renderer/src/components/panels/AutomationsPanel.tsx:191`
- `src/renderer/src/components/panels/AutomationsPanel.tsx:234`
- `src/renderer/src/components/panels/AutomationsPanel.tsx:849`

What I found:
- A disabled host-registered panel falls through to `EMPTY_SURFACE`, which is a blank app-background div. That does not meet the explicit disabled-state requirement for an existing/stale Automations workspace.
- `AutomationsPanel.load()` awaits `Promise.all` with no `try/catch`. If automations IPC is unavailable, rejected, or permission-denied by a future guard, `loadState` is left as loading rather than an explicit unavailable/permission-denied state.
- Mutations and save paths also lack `try/finally`, so rejected `run-now`, update/delete, create/edit calls can leave `busyId` or `saving` stuck.

Why it matters:
- The specified no-blank/no-broken requirement is not met for disabled or rejected IPC paths.
- This also leaves the required permission-denied state unproven; there is no code branch or test that renders it distinctly.

Required fix:
- Render an explicit disabled/unavailable message for stale Automations panels when the module is off, or replace the generic host-panel blank fallback with an accessible disabled surface.
- Wrap Automations IPC loads and mutations in `try/catch/finally`, mapping rejected IPC and permission-denied failures to visible states.
- Add focused tests for module-off/stale panel, rejected load, rejected mutation, and permission-denied/unavailable response handling.

Verification:
- Exercise disabled, permission-denied/unavailable, loading, empty, and missing-integration states in component tests or `/verify` screenshots.

[MEDIUM] Required live `/verify` screenshots and keyboard/narrow-viewport evidence are missing.

Requirement:
- Acceptance: "Accessibility: full keyboard nav, visible focus, non-color-only status, reduced-motion; passes a keyboard-only + narrow-viewport check."
- Acceptance: "Verified via /verify with screenshots."

Location:
- Implementation comments C1/C3 and T5 evidence.

What I found:
- The implementation evidence explicitly says live `/verify` E2E screenshots were not run.
- Existing tests verified registration and main IPC; no AutomationsPanel render/E2E test or screenshot artifact proves the keyboard-only, narrow-viewport, reduced-motion, and real create/run/open-agent path.
- C2/C3 addressed a narrow-viewport defect, but no screenshot or keyboard-only pass was recorded after the fix.

Required fix:
- Run the required `/verify` flow with screenshots after the launch/open-agent and state-handling fixes.
- Include keyboard-only and narrow-viewport checks in that evidence.

Verification:
- Attach screenshot evidence and command/output notes showing the full real-data path and accessibility checks pass.

Residual risk:
- I did not run the Electron `/verify` flow from this headless review. The static review found blockers before runtime validation would be meaningful.
