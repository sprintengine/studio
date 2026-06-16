import type { ColorScheme } from '../shared/electron-api'

// Main-readable mirror of the renderer's active color scheme (light/dark surface
// of the chosen app theme). The renderer is the source of truth — it resolves
// its theme and pushes the result here via IPC so agent-launch can spawn CLIs
// matching the app's appearance (e.g. Claude Code's `--settings` theme). main
// can't read renderer state, hence this tiny in-memory cache.
//
// In-memory (not persisted) on purpose: the renderer pushes on mount, before any
// agent is spawned, so a fresh process is current within the first frame. Until
// the first push the value is `undefined`, which the launch path reads as "don't
// force a theme" — the CLI keeps its own configured default. Explicit-over-
// surprising: we never guess a scheme we haven't been told.

let current: ColorScheme | undefined

export function setColorScheme(scheme: ColorScheme): void {
  current = scheme
}

export function getColorScheme(): ColorScheme | undefined {
  return current
}
