import { useSyncExternalStore } from 'react'

// Which VIEW an open surface is showing (Extensions drawer ruling,
// 2026-09-05). A surface that contributes several drawer rows — the one
// `extensions` surface is Plugins, Skills and Agent CLIs to the person
// (renderer-host, SurfaceViewDefinition) — has to say which of them it is on,
// or all three rows would read selected the moment the surface opened, and the
// drawer would stop being navigation.
//
// "Modal" is out of the name (Stage 2, same ruling): these surfaces are doors
// now, and the channel never cared which mount kind was publishing — only that
// exactly one row of a multi-row surface reads selected.
//
// The surface publishes; the drawer subscribes. Deliberately NOT the workspace
// store: the store would have to name a module's internal sections, and this is
// transient chrome state, not something a window persists. Pure (a module-level
// map plus listeners) so the shell's row list and a lazily-loaded surface can
// share it without either pulling the other's graph in.
//
// Keyed by surface id, so two surfaces with views never overwrite each other,
// and a surface that closes publishes `null` rather than leaving its last view
// standing for the next open.

const activeViews = new Map<string, string>()
const listeners = new Set<() => void>()

/** The surface says which view it is showing; `null` when it is closing. */
export function publishSurfaceView(surfaceId: string, viewId: string | null): void {
  const current = activeViews.get(surfaceId) ?? null
  if (current === viewId) return
  if (viewId === null) activeViews.delete(surfaceId)
  else activeViews.set(surfaceId, viewId)
  for (const listener of [...listeners]) listener()
}

export function getSurfaceView(surfaceId: string): string | null {
  return activeViews.get(surfaceId) ?? null
}

export function subscribeSurfaceViews(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The showing view of one surface, as a subscription. `null` while it shows none. */
export function useSurfaceView(surfaceId: string): string | null {
  return useSyncExternalStore(
    subscribeSurfaceViews,
    () => getSurfaceView(surfaceId),
    () => null,
  )
}
