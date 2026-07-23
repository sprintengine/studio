// "New sprint" from the Sprints door (item 1763).
//
// The creation wizard is shell chrome owned by WorkspaceManager, and a
// door-routed global surface is zero-prop by contract — there is no prop path
// from the surface to the wizard. So the surface asks, in the same window
// `CustomEvent` family as `multicode:reveal-target` and `multicode:panel-command`,
// and the shell opens the wizard on the Sprint mode.
//
// No latch here (unlike `revealTarget`): the listener lives in WorkspaceManager,
// which is mounted for the entire life of the window, so an event can never be
// dispatched before someone is listening.
//
// Item 1765 replaces the wizard's implicit project with an explicit primary-project
// picker; it extends what the shell opens, not this signal.

export const NEW_SPRINT_REQUEST_EVENT = 'multicode:new-sprint'

export function requestNewSprint(): void {
  window.dispatchEvent(new CustomEvent(NEW_SPRINT_REQUEST_EVENT))
}

export function subscribeNewSprintRequests(onRequest: () => void): () => void {
  const handler = (): void => onRequest()
  window.addEventListener(NEW_SPRINT_REQUEST_EVENT, handler)
  return () => window.removeEventListener(NEW_SPRINT_REQUEST_EVENT, handler)
}

// The return leg (item 1765). A sprint started here belongs to the door, not to
// the workspace it happens to reside in, so creating one comes back to Sprints
// with the new run selected instead of dropping the operator into its workspace
// ("Open agents" on the canvas is the explicit jump). The door had to close for
// the wizard to mount, so "stays open" is really "reopens, on the new run".
//
// A latch rather than an event: the shell hands the run over BEFORE the surface
// mounts, and the surface reads it as its initial selection. It lives here — a
// module both the shell and the lazily-loaded surface already import — so the
// surface stays out of the main bundle.
let createdRunStatePath: string | null = null

export function noteSprintCreatedFromDoor(statePath: string): void {
  createdRunStatePath = statePath
}

/** The run just created from the door, once. Null when creation came elsewhere. */
export function consumeSprintCreatedFromDoor(): string | null {
  const statePath = createdRunStatePath
  createdRunStatePath = null
  return statePath
}
