import { StatusDot } from '../../ui'
import type { StatusTone } from '../../ui'
import { stageChipState, type StageChipState } from './stageReadiness'

export { stageChipState }

// The stage-header status line (MC-1503). It combines the specialist's live
// session status with the stage-ready flip: a ready stage says so, otherwise the
// live status. One status idiom — the kit's `StatusDot` and the word beside it —
// with `role="status"` so the change is announced. It used to be a tinted pill
// with a per-state fill, border and a hand-drawn shape glyph, and `working` was
// painted in the product accent; the pill was the status said twice beside the
// dot, and the accent is not a status hue (audit 2026-09-02, status-said-twice).
// The label is always present, so no state is colour-only. State derivation
// lives in stageReadiness.ts (pure, unit-tested).

const CHIP_LABEL: Record<StageChipState, string> = {
  working: 'Working',
  'needs-input': 'Needs your input',
  idle: 'Idle',
  failed: 'Failed',
  ready: 'Ready',
}

// Tone per state. `working` takes the live tone-accent with the live pulse, not
// `--accent-primary`; idle is the resting neutral.
const CHIP_TONE: Record<StageChipState, { tone: StatusTone; pulse: boolean }> = {
  working: { tone: 'accent', pulse: true },
  'needs-input': { tone: 'warn', pulse: true },
  ready: { tone: 'good', pulse: false },
  failed: { tone: 'error', pulse: false },
  idle: { tone: 'neutral', pulse: false },
}

export function StageStatusChip({ state, className }: { state: StageChipState; className?: string }) {
  const { tone, pulse } = CHIP_TONE[state]
  const label = CHIP_LABEL[state]
  return (
    <span
      role="status"
      className={`inline-flex shrink-0 items-center gap-1.5 text-micro font-medium leading-none text-[color:var(--text-muted)] ${className ?? ''}`}
    >
      <StatusDot tone={tone} pulse={pulse} />
      {label}
    </span>
  )
}
