import type { StepId } from './creationStepFlows'

// The creation hub pages a flow (see creationStepFlows): one step per page, with
// a Continue footer between them. The decisions that page turn makes — may I
// advance, may I go back, may I jump to the page the progress bar was clicked
// on, and may the footer offer "Skip the rest and create" — are pure functions
// of the flow, the current page, and readiness. They live here rather than as
// closures inside NewWorkspacePanel so they can be exercised directly; the panel
// keeps ownership of the `step` state and the focus/scroll effects a page turn
// runs.
//
// Every mover returns the step to move to, or null for "do not move". Null is
// the refusal, so a caller cannot accidentally navigate on a guard it forgot.

export type StepFlow = {
  /** The mode's flow, in page order. */
  steps: readonly StepId[]
  /** The page the user is on. A step outside `steps` reads as the first page. */
  step: StepId
  /**
   * A create is in flight (isCreating || pendingCreate). Page turns freeze: the
   * deferred create reads the state of the page the user confirmed on, and the
   * rail is locked for the same reason.
   */
  busy: boolean
}

/** The current page's index. A step that is not in the flow reads as page 0. */
export function stepIndexIn(steps: readonly StepId[], step: StepId): number {
  return Math.max(0, steps.indexOf(step))
}

export function isLastStepIn(steps: readonly StepId[], step: StepId): boolean {
  return stepIndexIn(steps, step) >= steps.length - 1
}

/**
 * Continue. Advances one page, and only when THIS page is answered — create is
 * gated on the whole flow, but Continue is gated on the page you are looking at.
 * The last page has no Continue: its primary action is create.
 */
export function nextStepFrom(flow: StepFlow & { currentStepReady: boolean }): StepId | null {
  const { steps, step, busy, currentStepReady } = flow
  if (busy || !currentStepReady) return null
  const index = stepIndexIn(steps, step)
  if (index >= steps.length - 1) return null
  return steps[index + 1]
}

/**
 * Back. Never blocked by readiness — you can always retreat out of a page you
 * cannot answer — but the first page has nowhere to go.
 */
export function previousStepFrom(flow: StepFlow): StepId | null {
  const { steps, step, busy } = flow
  if (busy) return null
  const index = stepIndexIn(steps, step)
  if (index === 0) return null
  return steps[index - 1]
}

/**
 * The progress bar's step buttons. Back-jump ONLY: an earlier page is one the
 * user has already walked, while a later one may be gated on something this page
 * still has to answer, so a forward jump would skip the gate. The current page is
 * refused too — re-entering it would run the page-turn focus/scroll effect for a
 * turn that never happened.
 */
export function jumpTargetFor(flow: StepFlow, index: number): StepId | null {
  const { steps, step, busy } = flow
  if (busy) return null
  const current = stepIndexIn(steps, step)
  if (index < 0 || index >= current) return null
  return steps[index]
}

/**
 * "Skip the rest and create". Offered exactly when create is unblocked and there
 * are pages left: every page after a flow's intent step is defaulted, so once
 * create is ready the remaining pages have nothing the user must answer. On the
 * last page it is withheld because the primary action IS create there — two
 * buttons that do the same thing is a choice the user has to stop and read.
 */
export function shouldShowSkipToCreate(args: { createReady: boolean; isLastStep: boolean }): boolean {
  return args.createReady && !args.isLastStep
}

/**
 * Keep the current page inside the flow when the flow changes under it (a rail
 * switch, or the knowledge step dropping out for an already-configured folder).
 * A page that survives the change is kept — the user is not thrown back to the
 * start for an unrelated edit.
 */
export function stepWithinFlow(steps: readonly StepId[], step: StepId): StepId {
  return steps.includes(step) ? step : steps[0]
}
