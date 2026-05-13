import { TONE_COLOR_VAR, type Tone } from './tokens'

type StatusDotProps = {
  tone: Tone
  /** Adds the existing `status-dot-pulse` animation. Reduced-motion is honored
   *  globally in index.css. Use sparingly — only for live indicators. */
  pulse?: boolean
  /** Accessible label. Omit when the dot is purely decorative beside text that
   *  already describes the same state. */
  label?: string
  /** Defaults to 6 px per the shared plan. */
  size?: number
  className?: string
}

export function StatusDot({ tone, pulse = false, label, size = 6, className }: StatusDotProps) {
  const decorative = !label
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={label}
      aria-hidden={decorative || undefined}
      className={`inline-block shrink-0 rounded-full ${pulse ? 'status-dot-pulse' : ''} ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        backgroundColor: TONE_COLOR_VAR[tone],
      }}
    />
  )
}
