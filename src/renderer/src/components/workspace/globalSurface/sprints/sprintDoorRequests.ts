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

// ── The door's claim on the next sprint creation (items 1765 + 1811) ─────────
// A run started at the door belongs to the door: creating it comes back to
// Sprints rather than dropping the operator into the workspace it resides in. The
// claim is made when the door asks for the wizard and spent when a workspace is
// created — but the wizard can also go away without creating anything (cancel,
// Cmd-W, switching workspace, opening New chat), and a claim that outlives its
// wizard bounces the NEXT creation to the door from wherever it was started
// (item 1811). Every one of those routes releases it, so the invariant is: the
// claim is set only while the wizard the door opened is still on screen.
let sprintCreationClaimedByDoor = false

export function claimSprintCreationForDoor(): void {
  sprintCreationClaimedByDoor = true
}

export function releaseSprintCreationDoorClaim(): void {
  sprintCreationClaimedByDoor = false
}

/** True when the door opened the wizard this creation came from. Reads once. */
export function consumeSprintCreationDoorClaim(): boolean {
  const claimed = sprintCreationClaimedByDoor
  sprintCreationClaimedByDoor = false
  return claimed
}

// ── Close a run's workspace (item 1767) ──────────────────────────────────────
// "Close workspace" left the Projects list with the sprint rows, so the door
// owns it now. Terminating a workspace's agent terminals is the shell's job (it
// owns the terminal registry), and removing the workspace without terminating
// them would orphan live CLI processes — so the door asks, and the shell runs the
// same close path the row used to.

export const CLOSE_SPRINT_WORKSPACE_EVENT = 'multicode:close-sprint-workspace'

type CloseSprintWorkspaceDetail = {
  workspaceId?: unknown
  /** Handed to the shell so it can report when its teardown has finished. */
  whenClosed?: unknown
}

/**
 * Ask the shell to close a run's workspace. Resolves once the shell's teardown
 * has run — every terminal kill acknowledged by main and the workspace removed —
 * so a caller that goes on to touch the run's files on disk is not racing the
 * agents that were writing them (item 1812).
 *
 * Resolves immediately when no shell is listening: there is then no teardown in
 * flight to wait for, and waiting on a promise nobody will settle would wedge the
 * caller instead.
 */
export function requestCloseSprintWorkspace(workspaceId: string): Promise<void> {
  // `dispatchEvent` runs its listeners synchronously, so every teardown the shell
  // started is in this array by the time the dispatch returns.
  const teardowns: Promise<void>[] = []
  const detail: CloseSprintWorkspaceDetail = {
    workspaceId,
    whenClosed: (teardown: Promise<void>) => teardowns.push(teardown),
  }
  window.dispatchEvent(new CustomEvent(CLOSE_SPRINT_WORKSPACE_EVENT, { detail }))
  return Promise.all(teardowns).then(() => undefined)
}

export function subscribeCloseSprintWorkspaceRequests(
  onRequest: (workspaceId: string) => void | Promise<void>,
): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<CloseSprintWorkspaceDetail>).detail
    const workspaceId = detail?.workspaceId
    if (typeof workspaceId !== 'string' || !workspaceId) return
    const teardown = onRequest(workspaceId)
    if (teardown && typeof detail.whenClosed === 'function') {
      ;(detail.whenClosed as (pending: Promise<void>) => void)(teardown)
    }
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
