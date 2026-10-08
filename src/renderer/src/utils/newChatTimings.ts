import { logPerfEvent } from './perfDiagnostics'

// How long a New chat takes to become each thing the person waits on, from
// the Enter that confirmed it: open on screen, its worktree made, its provider
// checked, its session started, its first message sent, its terminal spawned.
// Each stage is said once per chat, as a perf event whose `elapsedMs` is the
// time since that Enter, so the diagnostics rollup shows where the seconds go
// rather than one total nobody can act on.
//
// Silent outside diagnostics, like every perf event: `logPerfEvent` drops it.

export type NewChatStage =
  'opened' | 'worktree-ready' | 'provider-ready' | 'session-started' | 'first-message-sent' | 'terminal-spawned'

type Timing = { confirmedAt: number; said: Set<NewChatStage>; detail: Record<string, unknown> }

const timings = new Map<string, Timing>()

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** The moment New chat's confirm began, handed back to `noteNewChatOpened`. */
export function newChatConfirmStarted(): number {
  return now()
}

/** The chat exists and is on screen: every later stage counts from `confirmedAt`. */
export function noteNewChatOpened(workspaceId: string, confirmedAt: number, detail: Record<string, unknown>): void {
  timings.set(workspaceId, { confirmedAt, said: new Set(), detail })
  noteNewChatStage(workspaceId, 'opened')
}

/** A stage this chat reached, said the first time only; a chat New chat did not open is not timed. */
export function noteNewChatStage(workspaceId: string, stage: NewChatStage): void {
  const timing = timings.get(workspaceId)
  if (!timing || timing.said.has(stage)) return
  timing.said.add(stage)
  logPerfEvent('NewChat', stage, {
    workspaceId,
    elapsedMs: Math.round(now() - timing.confirmedAt),
    ...timing.detail,
  })
  // Its last stage: nothing more is timed for it.
  if (stage === 'first-message-sent' || stage === 'terminal-spawned') timings.delete(workspaceId)
}
