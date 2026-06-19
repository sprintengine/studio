# T17 Nuclear Review

Verdict: changes_requested

## Blocking

- `src/renderer/src/components/panels/AutomationsPanel/automationsFormat.ts:155` splits CLI validity from the catalog source of truth with a separate `catalogReady` bypass. A non-empty invalid CLI returns no error whenever the plugin catalog is loading or in error state, even though the field is rendered as a constrained Select and the stale value is shown as disabled/unavailable.
- `src/renderer/src/components/panels/AutomationsPanel/AutomationEditor.tsx:143` uses that null result as the only Save blocker. `src/renderer/src/components/ui/Select.tsx:226` keeps the trigger enabled for a disabled selected item; disabled options only prevent re-selecting in the menu. Result: an existing `cli: "generic-shell"` automation can be opened and saved unchanged before the catalog reaches `ready` or after a foreground catalog error.
- `src/renderer/src/components/panels/AutomationsPanel/automationCliField.test.ts:42` locks in the bypass with a positive test for "does not reject while the registry is still loading". That test conflicts with T17 acceptance that generic-shell or other unlaunchable values cannot be saved and invalid/unavailable CLI state must be visible/disabled rather than silently accepted.

Required fix: make the editor fail closed for non-empty CLI values that cannot be proven present in the offered agent-picker catalog. Either block Save with a visible "agent CLI catalog is still loading/unavailable" state until the catalog is authoritative, or validate against the same fallback catalog being rendered when that is the accepted picker behavior. Remove/replace the loading-bypass test with coverage that a stale invalid value cannot be saved while catalog state is not authoritative.

## Verified

- Reuses `selectAgentCliCatalog` rather than introducing a new CLI list.
- `generic-shell` is hidden by the catalog source in `cliRuntimeOptions.ts`.
- The stale invalid value is visibly rendered as a disabled warn-toned option once it is compared with a catalog.
- Knowledge Graph note was updated at `knowledge/multicode/automations.md`.

## Commands

- `npm run test:renderer:automation-cli-field` - pass, 7/7.
- `npm run typecheck` - pass.
- `npm run lint` - pass, 0 violations.

## Residual Risk

- I did not run an Electron UI flow. The blocking finding follows from the renderer validation path and the focused helper test.
