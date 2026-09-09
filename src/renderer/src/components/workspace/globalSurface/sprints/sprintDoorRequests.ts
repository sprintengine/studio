import type { FuturePlanWorkspaceSource } from '../../../../types/workspace'
import type { RunDoorId } from './runDoors'

// The run doors ↔ shell seam.
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

// ── New run (items 1763 + 1765, two doors since 2470) ────────────────────────
// The creation dialog is shell chrome; the door asks and the shell opens it. The
// event carries WHICH door asked, because a run started at a door comes back to
// that door (item 1765) and there are two of them now — a workflow that returned
// to Sprints would land in a list its own partition keeps it out of, which reads
// as a run that was never created.

const NEW_SPRINT_REQUEST_EVENT = 'multicode:new-sprint'

type NewSprintRequestDetail = {
  /**
   * The plan to seed the dialog from, when the request came from a backlog item
   * rather than a door's own "New …". Without it the dialog opens with nothing
   * chosen, which is what the rail's bare New asks for.
   */
  source?: FuturePlanWorkspaceSource
  /** The door that asked. Absent on an older caller, which meant Sprints. */
  door?: RunDoorId
}

export function requestNewSprint(
  source?: FuturePlanWorkspaceSource,
  door: RunDoorId = 'sprints',
): void {
  const detail: NewSprintRequestDetail = { ...(source ? { source } : {}), door }
  window.dispatchEvent(new CustomEvent(NEW_SPRINT_REQUEST_EVENT, { detail }))
}

export function subscribeNewSprintRequests(
  onRequest: (source: FuturePlanWorkspaceSource | null, door: RunDoorId) => void,
): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<NewSprintRequestDetail>).detail
    onRequest(detail?.source ?? null, detail?.door === 'workflows' ? 'workflows' : 'sprints')
  }
  window.addEventListener(NEW_SPRINT_REQUEST_EVENT, handler)
  return () => window.removeEventListener(NEW_SPRINT_REQUEST_EVENT, handler)
}

// ── What a door collected before opening the dialog (item 2470) ──────────────
//
// A door that already knows what the operator wants — a goal, a roster — hands
// it over here rather than making them say it twice. It creates nothing:
// creation is the existing path and stays there, and this only decides what the
// New sprint dialog opens on. A second creation path would be a second set of
// rules about connectors, isolation, rosters and backlog links, which is
// precisely what "no new creation logic" forbids.
//
// A latch rather than an event, for the same reason the selection below is one:
// the door hands it over BEFORE the dialog mounts, and the dialog reads it once.
//
// Nothing fills one in today — the inline new-row that did was removed with the
// prose it carried, and each door's `New …` now opens the dialog directly. The
// dialog reads an empty draft and behaves as it always did without one.
export type SprintDoorDraft = {
  /** What the operator said they want done. Empty when they said nothing. */
  goal: string
  /** The roster they picked, or null for "whatever the dialog would default to". */
  rosterId: string | null
}

let pendingDraft: SprintDoorDraft | null = null

export function noteSprintDoorDraft(draft: SprintDoorDraft): void {
  pendingDraft = draft
}

/** What the inline row collected, once. Null when nobody filled one in. */
export function consumeSprintDoorDraft(): SprintDoorDraft | null {
  const draft = pendingDraft
  pendingDraft = null
  return draft
}

// ── The door's claim on the next run creation (items 1765 + 1811 + 2470) ─────
// A run started at a door belongs to that door: creating it comes back there
// rather than dropping the operator into the workspace it resides in. The claim
// is made when a door asks for the New sprint dialog and spent when a run is
// created — but the dialog can also go away without creating anything (cancel,
// Escape, Settings opening over it), and a claim that outlives its dialog bounces
// the NEXT creation to the door from wherever it was started (item 1811). Every
// one of those routes releases it, so the invariant is: the claim is set only
// while the dialog the door opened is still on screen.
//
// It records WHICH door since item 2470, because the answer decides where the
// operator is put down. `null` is "nobody claimed it", which is a creation
// started anywhere else and stays where it was started.
let sprintCreationClaimedByDoor: RunDoorId | null = null

export function claimSprintCreationForDoor(door: RunDoorId = 'sprints'): void {
  sprintCreationClaimedByDoor = door
}

export function releaseSprintCreationDoorClaim(): void {
  sprintCreationClaimedByDoor = null
}

/** The door that opened the dialog this creation came from. Reads once. */
export function consumeSprintCreationDoorClaim(): RunDoorId | null {
  const claimed = sprintCreationClaimedByDoor
  sprintCreationClaimedByDoor = null
  return claimed
}

// ── Close a run's workspace (item 1767) ──────────────────────────────────────
// "Close workspace" left the Projects list with the sprint rows, so the door
// owns it now. Terminating a workspace's agent terminals is the shell's job (it
// owns the terminal registry), and removing the workspace without terminating
// them would orphan live CLI processes — so the door asks, and the shell runs the
// same close path the row used to.

const CLOSE_SPRINT_WORKSPACE_EVENT = 'multicode:close-sprint-workspace'

type CloseSprintWorkspaceDetail = {
  // Unknown because it arrives on an event: validated before it is handed on.
  workspaceId?: unknown
  /** Handed to the shell so it can report when its teardown has finished. */
  whenClosed?: (teardown: Promise<void>) => void
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
    if (teardown && typeof detail.whenClosed === 'function') detail.whenClosed(teardown)
  }
  window.addEventListener(CLOSE_SPRINT_WORKSPACE_EVENT, handler)
  return () => window.removeEventListener(CLOSE_SPRINT_WORKSPACE_EVENT, handler)
}

// ── The run the door should open on ──────────────────────────────────────────
//
// Two callers hand a door a run before it mounts:
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
