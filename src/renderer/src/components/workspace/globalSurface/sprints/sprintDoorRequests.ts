// The Sprints door ↔ shell seam.
//
// A door-routed global surface is zero-prop by contract, so there is no prop path
// from the surface to the shell chrome that owns workspace creation and workspace
// teardown. Everything the door needs the shell to do travels as a window
// `CustomEvent`, in the same family as `multicode:reveal-target` and
// `multicode:panel-command`; everything a caller needs to hand the door before it
// mounts travels through the selection latch at the bottom.
//
// No latch on the events (unlike `revealTarget`): the listeners live in
// WorkspaceManager, which is mounted for the entire life of the window, so an
// event can never be dispatched before someone is listening.

// ── New sprint (items 1763 + 1765) ───────────────────────────────────────────
// The creation wizard is shell chrome; the door asks and the shell opens it on
// the Sprint mode with an explicit primary-project picker.

export const NEW_SPRINT_REQUEST_EVENT = 'multicode:new-sprint'

export function requestNewSprint(): void {
  window.dispatchEvent(new CustomEvent(NEW_SPRINT_REQUEST_EVENT))
}

export function subscribeNewSprintRequests(onRequest: () => void): () => void {
  const handler = (): void => onRequest()
  window.addEventListener(NEW_SPRINT_REQUEST_EVENT, handler)
  return () => window.removeEventListener(NEW_SPRINT_REQUEST_EVENT, handler)
}

// ── Close a run's workspace (item 1767) ──────────────────────────────────────
// "Close workspace" left the Projects list with the sprint rows, so the door
// owns it now. Terminating a workspace's agent terminals is the shell's job (it
// owns the terminal registry), and removing the workspace without terminating
// them would orphan live CLI processes — so the door asks, and the shell runs the
// same close path the row used to.

export const CLOSE_SPRINT_WORKSPACE_EVENT = 'multicode:close-sprint-workspace'

export function requestCloseSprintWorkspace(workspaceId: string): void {
  window.dispatchEvent(new CustomEvent(CLOSE_SPRINT_WORKSPACE_EVENT, { detail: { workspaceId } }))
}

export function subscribeCloseSprintWorkspaceRequests(
  onRequest: (workspaceId: string) => void,
): () => void {
  const handler = (event: Event): void => {
    const workspaceId = (event as CustomEvent<{ workspaceId?: unknown }>).detail?.workspaceId
    if (typeof workspaceId === 'string' && workspaceId) onRequest(workspaceId)
  }
  window.addEventListener(CLOSE_SPRINT_WORKSPACE_EVENT, handler)
  return () => window.removeEventListener(CLOSE_SPRINT_WORKSPACE_EVENT, handler)
}

// ── The run the door should open on ──────────────────────────────────────────
//
// Two callers hand the door a run before it mounts:
//
// - Creating a sprint from the door (item 1765). A sprint started here belongs to
//   the door, not to the workspace it happens to reside in, so creating one comes
//   back to Sprints on the new run instead of dropping the operator into its
//   terminals ("Open agents" on the canvas is the explicit jump). The door had to
//   close for the wizard to mount, so "stays open" is really "reopens, on the new
//   run".
// - Opening a Backlog `sprintengine.run` link (item 1767). The link used to mount
//   and activate a workspace to show a run; it opens the door on the run instead.
//
// A latch rather than an event: the caller hands the run over BEFORE the surface
// mounts, and the surface reads it as its initial selection. It lives here — a
// module both the shell and the lazily-loaded surface already import — so the
// surface stays out of the main bundle.
let pendingRunStatePath: string | null = null

export function noteSprintDoorSelection(statePath: string): void {
  pendingRunStatePath = statePath
}

/** The run the door was asked to open on, once. Null when nobody asked. */
export function consumeSprintDoorSelection(): string | null {
  const statePath = pendingRunStatePath
  pendingRunStatePath = null
  return statePath
}
