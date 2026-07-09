// Pure mapping from the wizard's "Workflow steps" + "Final sweeps" panel state
// to the three run-level init keys they populate (MC-1542 / MC-1543):
//   - defaultPhases   — "Agents review their own work" toggle
//   - phaseRuntimes   — "Reviewed by: … a stronger model" binding
//   - requiredSweeps  — the operator-mandated "Always run" sweep roles
//
// The engine defaults (`defaultPhases: ['review']`, no `phaseRuntimes`, no
// `requiredSweeps`) are the wizard defaults too, so a plain run OMITS all three
// keys and stays byte-identical to a pre-panel run. Each key is emitted only
// when it diverges from its default.

// The runtime that reviews each task's work. `null` means "the same agent that
// wrote it" (in-session self-review); a value binds a specific CLI/model.
export type SprintEngineReviewRuntime = { cli: string; model: string | null }

export type SprintEngineWorkflowConfigInput = {
  // "Agents review their own work". ON is the engine default (a `review` phase);
  // OFF means agents finish without a self-review pass.
  selfReviewEnabled: boolean
  // Who performs the review. Ignored (no phase runs) when self-review is OFF.
  reviewRuntime: SprintEngineReviewRuntime | null
  // Sweep role ids the operator mandated via the "Always run" toggles, in the
  // panel's display order.
  requiredSweepRoleIds: readonly string[]
}

export type SprintEngineWorkflowInitKeys = {
  defaultPhases?: string[]
  requiredSweeps?: string[]
  phaseRuntimes?: Record<string, { cli: string; model: string | null }>
}

export function buildSprintEngineWorkflowInitKeys(
  input: SprintEngineWorkflowConfigInput,
): SprintEngineWorkflowInitKeys {
  const keys: SprintEngineWorkflowInitKeys = {}

  // defaultPhases: ON (default) => omit and let the engine apply `['review']`;
  // OFF => the meaningful, recorded empty set.
  if (!input.selfReviewEnabled) keys.defaultPhases = []

  // requiredSweeps: de-duplicated role ids, display order preserved; omitted
  // when none are mandated.
  const seen = new Set<string>()
  const sweeps: string[] = []
  for (const raw of input.requiredSweepRoleIds) {
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    sweeps.push(id)
  }
  if (sweeps.length > 0) keys.requiredSweeps = sweeps

  // phaseRuntimes: only when self-review is ON and a specific reviewer runtime
  // is bound. "Same agent" (null) creates zero extra sessions, so the key is
  // omitted (MC-1543 cost honesty).
  if (input.selfReviewEnabled && input.reviewRuntime) {
    keys.phaseRuntimes = {
      review: { cli: input.reviewRuntime.cli, model: input.reviewRuntime.model },
    }
  }

  return keys
}
