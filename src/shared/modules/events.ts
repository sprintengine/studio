// Module events — the main→renderer push channel a capability module owns.
//
// The renderer→module-main bridge (shared/modules/bridge.ts) is request/response
// only: `ModuleBridgeInvokeRequest` has no subscribe verb and
// `RendererHost.invoke` returns a single promise. A module whose main half
// learns something the renderer half has to react to — a background run
// finishing, a watcher firing — has nowhere to send it. This is that channel.
//
// Identity is stamped by the kernel from the emitting module's scope, exactly
// like notifications: a module can never emit as another, and a subscriber only
// ever receives its own module's events.
//
// ── Delivery contract ───────────────────────────────────────────────────────
//
// - **Fan-out.** One emit reaches every open window. A module with per-window
//   state keys on it itself; the channel has no addressing.
// - **Ordering.** FIFO per emitting module. All of a module's events ride one
//   IPC channel in emit order, so a `started` never lands after its `done`.
// - **No replay.** An event emitted while no window is open is dropped, and a
//   window opened later sees nothing that happened before it. Events are
//   signals, not state: the durable answer must stay readable through an
//   invoke, and a subscriber must be correct having missed every prior event.
//   (This is the deliberate difference from notifications, which buffer their
//   recent set so late windows still see launch diagnostics.)
// - **Teardown.** `subscribe` returns its unsubscriber; call it on unmount.
//   Delivery is additionally gated on the owning module's live enablement, so
//   a subscription made before a disable stops receiving and resumes on
//   re-enable rather than outliving the toggle.
// - **No flood bound.** Unlike notifications — which are user-visible and
//   bounded against a misbehaving module — dropping an event would make a
//   subscriber wrong (a stale door, a run that never finishes). Emit rate is
//   the module's own responsibility.

/** One host-owned channel carries every module's events; fan-out is by `sourceModuleId`. */
export const MODULE_EVENTS_CHANNEL = 'modules:events'

export type ModuleEventEnvelope = {
  /** Stamped by the host kernel from the emitting module's scope. */
  sourceModuleId: string
  /** Module-chosen event name. Scoped to the module, so it needs no prefix. */
  topic: string
  /** Structured-cloneable payload; absent for a bare signal. */
  payload?: unknown
  /** Epoch ms at emission, assigned by the kernel. */
  emittedAt: number
}

const MAX_TOPIC_LENGTH = 128

export type ModuleEmitValidation =
  | { ok: true; topic: string }
  | { ok: false; message: string }

// Boundary validation for emit topics. Module code (third-party `entry.main`
// included) calls emit directly, so the input is untrusted. The payload is not
// validated here: it is whatever the module and its own renderer half agreed
// on, and structured-clone failures surface from the IPC send.
export function validateModuleEventTopic(topic: unknown): ModuleEmitValidation {
  if (typeof topic !== 'string' || topic.trim().length === 0) {
    return { ok: false, message: 'emit(...) requires a non-empty topic.' }
  }
  const trimmed = topic.trim()
  if (trimmed.length > MAX_TOPIC_LENGTH) {
    return { ok: false, message: `emit(...) topic must be at most ${MAX_TOPIC_LENGTH} characters.` }
  }
  return { ok: true, topic: trimmed }
}
