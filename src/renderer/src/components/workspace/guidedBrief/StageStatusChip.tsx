import { stageChipState, type StageChipState } from './stageReadiness'

export { stageChipState }

// The stage-header status chip (MC-1503). It combines the specialist's live
// session status with the stage-ready flip: a ready stage shows the check chip,
// otherwise the live status. Non-color-only — each state carries a distinct
// shape (pulsing dot / square / check / triangle / hollow dot) so it survives
// grayscale — plus a plain-language label and role="status" so the change is
// announced. Visual reference: the stage-header chip states in
// mockups/2026-07-07-design-studio-premium.html. State derivation lives in
// stageReadiness.ts (pure, unit-tested).

const CHIP_LABEL: Record<StageChipState, string> = {
  working: 'Working',
  'needs-input': 'Needs your input',
  idle: 'Idle',
  failed: 'Failed',
  ready: 'Ready',
}

// color / soft-background / border tokens per state. Idle is deliberately
// low-contrast (a resting state), the others carry their semantic tone.
const CHIP_TONE: Record<StageChipState, { fg: string; bg: string; border: string }> = {
  working: {
    fg: 'var(--accent-primary)',
    bg: 'var(--accent-primary-soft)',
    border: 'var(--accent-primary-soft)',
  },
  'needs-input': { fg: 'var(--tone-warn)', bg: 'var(--tone-warn-soft)', border: 'var(--tone-warn-soft)' },
  ready: { fg: 'var(--tone-good)', bg: 'var(--tone-good-soft)', border: 'var(--tone-good-soft)' },
  failed: { fg: 'var(--tone-error)', bg: 'var(--tone-error-soft)', border: 'var(--tone-error-soft)' },
  idle: {
    fg: 'var(--text-muted)',
    bg: 'var(--bg-surface-raised)',
    border: 'var(--border-default)',
  },
}

// Shape glyph per state — the grayscale-safe differentiator. `currentColor`
// inherits the chip's foreground tone.
function ChipGlyph({ state }: { state: StageChipState }) {
  if (state === 'ready') {
    return (
      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
        <path d="M2.5 6.5 5 9l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (state === 'failed') {
    return (
      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
        <path d="M6 1.5 11 10.5H1z" fill="currentColor" />
      </svg>
    )
  }
  // working = pulsing round dot; needs-input = square (attention); idle = hollow dot.
  const isSquare = state === 'needs-input'
  const isHollow = state === 'idle'
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-[7px] w-[7px] ${isSquare ? 'rounded-[1.5px]' : 'rounded-full'} ${
        state === 'working' ? 'status-dot-pulse' : ''
      }`}
      style={
        isHollow
          ? { border: '1.5px solid currentColor' }
          : { backgroundColor: 'currentColor' }
      }
    />
  )
}

export function StageStatusChip({ state, className }: { state: StageChipState; className?: string }) {
  const tone = CHIP_TONE[state]
  const label = CHIP_LABEL[state]
  return (
    <span
      role="status"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${className ?? ''}`}
      style={{ color: tone.fg, backgroundColor: tone.bg, borderColor: tone.border }}
    >
      <ChipGlyph state={state} />
      {label}
    </span>
  )
}
