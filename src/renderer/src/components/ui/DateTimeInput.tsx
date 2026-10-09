import React from 'react'

import { Input } from './Input'

// The kit's date and time field (design-system/components/input, "Date and
// time"). It is the browser's own `datetime-local` / `date` / `time` control in
// the `Input` box — the native control is kept for what it already gets right
// (a keyboard-complete segmented entry, the platform's calendar, the locale's
// order of day and month, and the accessible names of each segment), and the
// box around it is the same field every other form row draws, so a schedule
// editor's "On" and "At" sit level with the text field above them.
//
// What it adds over a bare `<Input type="date">` is the two things every caller
// would otherwise repeat: tabular figures, so a value that ticks does not jog
// its width, and the `time-control` hook that tones the calendar button down
// to the field's ink on dark themes (assets/index.css).
//
// Values are the native strings, never `Date` objects: `YYYY-MM-DDTHH:mm` for
// `datetime-local`, `YYYY-MM-DD` for `date`, `HH:mm` for `time`, all in local
// time. Converting to an instant is the caller's decision, because only the
// caller knows which time zone the value was meant in.

export type DateTimeInputType = 'datetime-local' | 'date' | 'time'

export type DateTimeInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> & {
  /** Which native control. Defaults to `datetime-local`. */
  type?: DateTimeInputType
  /** The control-ramp step, as on `Input`. Defaults to `sm`. */
  size?: 'xs' | 'sm' | 'md'
  /** The field ground, as on `Input`. The hosted variants are not offered: a
   *  date field always draws its own box. */
  variant?: 'default' | 'well' | 'quiet'
  /** Fill the track (default). Pass `false` to size the field to its value. */
  fullWidth?: boolean
}

export const DateTimeInput = React.forwardRef<HTMLInputElement, DateTimeInputProps>(function DateTimeInput(
  { type = 'datetime-local', className, ...rest },
  ref,
) {
  return <Input ref={ref} type={type} {...rest} className={`time-control tabular-nums ${className ?? ''}`} />
})
