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
