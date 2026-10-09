import { useSyncExternalStore } from 'react'

import { DEFAULT_CLOCK_FORMAT, type ClockFormat } from '../types/appTheme'

// The app's clock setting (Settings → Appearance → Clock), held here so every
// place that writes a time of day reads one value without each subscribing to
// the store: a transcript stamps every message and step, and a formatter is
// cheap only when it is built once. `useAppTheme` keeps it in step with the
// stored appearance; a component whose stamp is memoized reads it through
// `useClockFormat` so a change re-renders it.

let current: ClockFormat = DEFAULT_CLOCK_FORMAT
const listeners = new Set<() => void>()
const formatters = new Map<string, Intl.DateTimeFormat>()

export function clockFormat(): ClockFormat {
  return current
}

export function setClockFormat(format: ClockFormat): void {
  if (format === current) return
  current = format
  // Every cached formatter was built for the old cycle.
  formatters.clear()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The clock setting, re-rendering the caller when it changes. */
export function useClockFormat(): ClockFormat {
  return useSyncExternalStore(subscribe, clockFormat, clockFormat)
}

/**
 * A formatter for `options` in the reader's locale, with its hours on the
 * cycle the setting asks for: the locale's own under `system`, otherwise 1–12
 * with a day period or 0–23. Built once per options and setting.
 */
export function clockFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options)
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      undefined,
      current === 'system' ? options : { ...options, hourCycle: current === '12h' ? 'h12' : 'h23' },
    )
    formatters.set(key, formatter)
  }
  return formatter
}

const TIME_OF_DAY: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }

/** "3:05 PM" or "15:05": a time of day, to the minute, on the app's clock. */
export function formatTimeOfDay(at: number | Date, options: Intl.DateTimeFormatOptions = TIME_OF_DAY): string {
  return clockFormatter(options).format(at)
}
