import type { SessionStatus } from '../workspaceManagerHelpers'

// Live status of a wizard stage's specialist, derived upstream from the
// transport's own session signal — conversation session status for
// conversation sessions, the terminal snapshot's hook phase for PTY sessions —
// the same source the Sessions popover reads, never parsed output.
// `'absent'` folds a session that has ended (conversation `stopped` maps to
// `null` in the shared status map; a PTY session with no live snapshot) into a
// single quiet, non-live value.
export type StageLiveStatus = SessionStatus | 'absent'

// Quiet = the specialist is neither actively working nor waiting on the user,
// so a validated artifact set may be declared ready. A mid-write agent
// (`'working'`) or one holding a pending question/approval (`'needs-input'`)
// never flips a stage; a `'failed'` agent stays un-ready, so silence after a
// failure can't be mistaken for done.
export function isAgentQuiet(status: StageLiveStatus): boolean {
  return status === 'idle' || status === 'absent'
}

export type StageReadinessInput = {
  // The stage's file contract passed: its real artifacts exist AND validate.
  artifactsValid: boolean
  // The specialist is quiet (see isAgentQuiet).
  agentQuiet: boolean
}

// A stage is ready only when its validated artifacts are on disk AND the agent
// is quiet. The readiness marker is deliberately NOT an input here: it demotes
// to a re-validation trigger upstream, so a marker emitted over a broken or
// missing artifact set can never flip the stage on its own.
export function isStageReady({ artifactsValid, agentQuiet }: StageReadinessInput): boolean {
  return artifactsValid && agentQuiet
}

// frontend-design file contract: at least one real page AND a non-empty UI
// direction. A page alone no longer counts — this replaces the old
// `mockupsAvailable`-alone rule (an intended behavior change, noted for release
// notes).
export function frontendDesignArtifactsValid(input: {
  pageCount: number
  uiDirectionNonEmpty: boolean
}): boolean {
  return input.pageCount >= 1 && input.uiDirectionNonEmpty
}

// design-system file contract: the bundle manifest parses AND the bundle lint
// reports no findings. Either failing — including a deleted or malformed
// manifest — keeps the stage un-ready regardless of any marker.
export function designSystemArtifactsValid(input: {
  manifestParses: boolean
  lintClean: boolean
}): boolean {
  return input.manifestParses && input.lintClean
}

// Why the design-system contract passed or failed on the last quiet-edge
// validation. 'pending' covers "agent not quiet" and "not yet evaluated";
// the failure states each name their real cause so the studio can say WHY the
// stage is un-ready — a lint that never passes must read as "fix the lint",
// never as an eternal "waiting for files" (silent-stall guard).
export type DesignSystemValidationState =
  | 'pending'
  | 'valid'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'lint-findings'
  | 'lint-error'

// Classify one validation pass. `manifestContent` is the raw manifest read
// (null = missing/unreadable); `lintResult` is the bundle lint run, or null
// when the lint was skipped (nothing to lint) or its IPC itself failed.
export function classifyDesignSystemBundle(input: {
  manifestContent: string | null
  lintResult: { ok: true } | { ok: false; kind: 'findings' | 'error' } | null
}): DesignSystemValidationState {
  if (input.manifestContent === null) return 'manifest-missing'
  try {
    JSON.parse(input.manifestContent)
  } catch {
    return 'manifest-invalid'
  }
  if (input.lintResult?.ok) return 'valid'
  if (input.lintResult && input.lintResult.kind === 'findings') return 'lint-findings'
  return 'lint-error'
}

// Footer hint for the design-system studio. Every un-ready failure state
// names its cause; only the genuinely-indeterminate states (nothing authored
// yet, or validation deferred while the agent works) keep the waiting copy.
export function designSystemReadinessHint(
  ready: boolean,
  validation: DesignSystemValidationState,
): string {
  if (ready) return 'Ask for changes anytime — the gallery updates as files change.'
  switch (validation) {
    case 'lint-findings':
      return 'The bundle lint found issues — ask the designer to fix them before saving.'
    case 'lint-error':
      return 'The bundle lint could not run — ask the designer to check the bundle scripts.'
    case 'manifest-invalid':
      return 'The design-system manifest has a syntax error — ask the designer to fix it.'
    case 'manifest-missing':
    case 'pending':
    case 'valid':
      return 'Waiting for the first design-system files.'
  }
}

// The stage-header chip state (rendered by StageStatusChip): the stage-ready
// flip wins (check chip), otherwise the live status maps 1:1, with idle/absent
// folded into the resting `idle` chip.
export type StageChipState = 'working' | 'needs-input' | 'idle' | 'failed' | 'ready'

export function stageChipState(liveStatus: StageLiveStatus, ready: boolean): StageChipState {
  if (ready) return 'ready'
  if (liveStatus === 'working') return 'working'
  if (liveStatus === 'needs-input') return 'needs-input'
  if (liveStatus === 'failed') return 'failed'
  return 'idle'
}
