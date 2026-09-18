import React from 'react'

import { FOCUS_RING_CLASS } from './tokens'

// The design system's `slider` (design-system/components/slider/component.md)
// as a React control: ONE value taken off a ramp of ordered, discrete stops.
//
// Not a range input. Every stop is a value the domain already named, the
// control snaps between them, and `aria-valuetext` carries the name rather
// than the index — "3" is not a level anybody chose. A range input would also
// have cost the styling: its thumb and track are per-engine pseudo-elements
// that no token can reach without three vendor-prefixed copies of the same
// rule.
//
// It is the ordered sibling of `SegmentedControl`. A strip shows every label
// at once and runs out of row past four; a slider shows a position and one
// value name, and the RAMP itself is what says the right-hand stop costs more
// than the left-hand one. Below three stops that trade stops paying — two
// stops is a switch wearing a track.
//
// Geometry: the root is `size.control.xs` tall so the whole strip is the hit
// target, and insets 8px — exactly half the 16px thumb — so the track ends
// where the thumb's CENTRE can reach. One 0–1 fraction then places the fill,
// every tick, and the thumb in the same coordinate space. The calc()s that
// spend it live in `.slider-fill` / `.slider-tick` / `.slider-thumb` in
// assets/index.css, where the travel is animated, exactly as the switch's
// thumb offsets do.

export type SliderStop = {
  /** Stable id for the value this stop selects. */
  id: string
  /** The name shown for the stop — what a consumer displays and what a screen reader hears. */
  label: string
}

export function Slider({
  stops,
  value,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  disabled = false,
  className,
}: {
  /** The ramp, cheapest first. Three or more; a shorter ramp is the wrong control. */
  stops: ReadonlyArray<SliderStop>
  /** Index of the selected stop. */
  value: number
  onChange: (index: number) => void
  /** Accessible name. Required unless `ariaLabelledBy` is supplied. */
  ariaLabel?: string
  ariaLabelledBy?: string
  disabled?: boolean
  className?: string
}): JSX.Element | null {
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const max = stops.length - 1
  if (max < 0) return null

  const index = Math.max(0, Math.min(max, value))
  const position = max === 0 ? 0 : index / max

  const commit = (next: number) => {
    if (disabled) return
    const clamped = Math.max(0, Math.min(max, next))
    if (clamped !== index) onChange(clamped)
  }

  // Where a pointer landed, as a stop. The 8px inset and the 16px thumb are
  // the same two numbers the stylesheet positions with — a press at the far
  // left of the strip has to resolve to stop 0, not to a negative fraction of
  // a track that starts 8px in.
  const stopAt = (clientX: number): number => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return index
    const span = box.width - 16
    // jsdom and a surface that has not been laid out yet both measure zero;
    // snapping to stop 0 there would silently rewrite the value on a click.
    if (span <= 0) return index
    return Math.round(((clientX - box.left - 8) / span) * max)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // The control keeps its keys to itself. A slider is often hosted inside a
    // row or a popover that reads Enter/Space as "activate me", and React
    // bubbles a portaled surface's events back through the REACT tree, so an
    // unclaimed key runs the host's handler while the person is operating this.
    // Escape is the exception — the popover primitive listens for it on
    // `document`, and a synthetic stopPropagation stops the native event too —
    // and so is Tab, which is the browser's to act on.
    if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
    if (disabled) return
    // Neither end wraps: a ramp has ends, and rolling from the costliest stop
    // round to the cheapest is a value nobody meant to pick.
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
    if (step !== undefined) commit(index + step)
    else if (event.key === 'Home') commit(0)
    else if (event.key === 'End') commit(max)
    else if (event.key === 'PageUp') commit(index + 2)
    else if (event.key === 'PageDown') commit(index - 2)
    else return
    event.preventDefault()
  }

  return (
    <div
      ref={rootRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={index}
      // The stop's NAME, not its index: `aria-valuenow` alone announces "3".
      aria-valuetext={stops[index]?.label}
      aria-disabled={disabled || undefined}
      // The leading stop is the one position where the ground under the thumb
      // is the neutral track rather than the accent fill, so the thumb takes
      // the neutral ink there — the switch's rule that the thumb follows the
      // surface it is resting on.
      data-at-start={index === 0 || undefined}
      data-slider="true"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (disabled) return
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        rootRef.current?.focus()
        commit(stopAt(event.clientX))
      }}
      onPointerMove={(event) => {
        if (disabled) return
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        commit(stopAt(event.clientX))
      }}
      style={{ ['--slider-position' as string]: String(position) }}
      className={[
        'relative flex h-control-xs w-full select-none items-center rounded-sm px-2 touch-none',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    >
      {/* The groove. Its hairline is an inset shadow rather than a border, for
          the switch's reason: a layout border takes 1px out of the box and the
          fill inside it then stops 1px short of the thumb it has to meet. */}
      <span
        aria-hidden="true"
        className="relative h-2 flex-1 rounded-full bg-[color:var(--bg-active)] shadow-[inset_0_0_0_1px_var(--border-default)]"
      >
        <span className="slider-fill absolute inset-y-0 left-0 rounded-full bg-[color:var(--accent-primary)]" />
        {stops.map((stop, i) => (
          <span
            key={stop.id}
            // Ticks take the ink of what they are lying on — the accent's own
            // foreground where the fill has reached them, the disabled ink
            // past the thumb. One colour reads as a defect on half the ramp.
            className={[
              'slider-tick absolute top-1/2 rounded-full',
              i <= index ? 'bg-[color:var(--text-on-accent)] opacity-50' : 'bg-[color:var(--text-disabled)]',
            ].join(' ')}
            style={{ ['--slider-tick' as string]: max === 0 ? '0' : String(i / max) }}
          />
        ))}
      </span>
      <span
        aria-hidden="true"
        className="slider-thumb absolute top-1/2 rounded-full bg-[color:var(--text-on-accent)] shadow-[inset_0_0_0_1px_var(--border-subtle)]"
      />
    </div>
  )
}
