// Tracker write-back configuration schema (MC-1640 / plan §3.7). Owned by the
// write-back engine (T10) and consumed by the settings surface (T11). Node-free
// so the renderer imports it directly. Carries NO secret — only booleans and the
// named transition ids the user picked from the tracker's own transition list.
//
// Per-connection, OPT-IN, default entirely OFF: `enabled` is the master switch
// and defaults false, so a fresh connection posts nothing. The per-event comment
// toggles default ON, so flipping the master switch on posts the canonical three
// lifecycle comments (started / PR opened / completed) without further ticking;
// the user unticks the ones they don't want. Transitions are never guessed — they
// stay unset until the user maps a run event to a named transition (T11).

import type { TrackerProviderId } from './types'

// The three lifecycle moments a comment can mark, and the two a transition can.
// Comments and transitions are independent axes on the same events.
export type TrackerWriteBackCommentEvent = 'started' | 'pr' | 'done'
export type TrackerWriteBackTransitionEvent = 'onStart' | 'onComplete'

export type TrackerWriteBackConfig = {
  // Master switch. Off ⇒ nothing posts for this connection, regardless of the
  // per-event toggles below. Default false (opt-in).
  enabled: boolean
  comments: { started: boolean; pr: boolean; done: boolean }
  // A named transition id chosen from the tracker's own listTransitions, or null
  // when the user has not mapped that event. Never a guessed workflow name.
  transitions: { onStart: string | null; onComplete: string | null }
}

// Default: opt-in master off, all three lifecycle comments pre-selected (so
// enabling is a one-switch "post my sprint lifecycle" action), no transitions.
export const DEFAULT_TRACKER_WRITEBACK_CONFIG: TrackerWriteBackConfig = {
  enabled: false,
  comments: { started: true, pr: true, done: true },
  transitions: { onStart: null, onComplete: null },
}

// Tolerant reader for a persisted or IPC-supplied config blob: fills every field
// from the default, coerces booleans, and keeps only non-empty string transition
// ids. Unknown keys are dropped. Never throws — a malformed blob degrades to the
// default rather than corrupting the engine's gating.
export function normalizeTrackerWriteBackConfig(raw: unknown): TrackerWriteBackConfig {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const comments = source.comments && typeof source.comments === 'object' ? (source.comments as Record<string, unknown>) : {}
  const transitions =
    source.transitions && typeof source.transitions === 'object' ? (source.transitions as Record<string, unknown>) : {}
  return {
    enabled: coerceBoolean(source.enabled, DEFAULT_TRACKER_WRITEBACK_CONFIG.enabled),
    comments: {
      started: coerceBoolean(comments.started, DEFAULT_TRACKER_WRITEBACK_CONFIG.comments.started),
      pr: coerceBoolean(comments.pr, DEFAULT_TRACKER_WRITEBACK_CONFIG.comments.pr),
      done: coerceBoolean(comments.done, DEFAULT_TRACKER_WRITEBACK_CONFIG.comments.done),
    },
    transitions: {
      onStart: coerceTransitionId(transitions.onStart),
      onComplete: coerceTransitionId(transitions.onComplete),
    },
  }
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function coerceTransitionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// True when the config would post at least one thing — the cheap gate the engine
// uses to skip the backlog scan for a connection entirely. A disabled master, or
// an enabled one with every comment off and no transition mapped, does nothing.
export function trackerWriteBackConfigIsActive(config: TrackerWriteBackConfig): boolean {
  if (!config.enabled) return false
  return (
    config.comments.started ||
    config.comments.pr ||
    config.comments.done ||
    config.transitions.onStart !== null ||
    config.transitions.onComplete !== null
  )
}

// ---------------------------------------------------------------------------
// Idempotency key (plan §3.7): run id + event + external id. Deterministic and
// pure, so the engine and the ledger derive the same key and a projection replay
// or app restart never double-posts. `postKind` discriminates the five posts a
// run can make so a comment and a transition on the same event never collide.
// ---------------------------------------------------------------------------

export type TrackerWriteBackPostKind =
  | 'comment:started'
  | 'comment:pr'
  | 'comment:done'
  | 'transition:onStart'
  | 'transition:onComplete'

export function trackerWriteBackPostKey(input: {
  runId: string
  postKind: TrackerWriteBackPostKind
  externalId: string
}): string {
  return `${input.runId}|${input.postKind}|${input.externalId}`
}

// A recorded failure the settings surface (T11) renders as a visible notice on
// the proxy item. Redacted to the provider's own message — never a stack trace.
export type TrackerWriteBackNotice = {
  connectionId: string
  externalId: string
  provider: TrackerProviderId
  postKind: TrackerWriteBackPostKind
  relativePath: string
  message: string
  at: string
}
