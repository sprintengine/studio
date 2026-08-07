/**
 * Renderer shim over the shared plan-sourced sprint creation path.
 *
 * Relocated to `src/shared/sprintengine/workspace-creation.ts` (MC-2160). The
 * two impure lines (the renderer store's `addWorkspace` / `updateAgent`) became
 * the injected `workspace` port, which the renderer wires to the store and main
 * wires to the workspace registry. Existing renderer import sites keep working
 * unchanged — see `sprintengineWorkspaceCreationPorts.ts` for the renderer's
 * port wiring.
 */
export * from '../../../shared/sprintengine/workspace-creation'
