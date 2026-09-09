import { useEffect, useMemo } from 'react'

import { useWorkspaceStore } from '../store/workspaceStore'
import {
  projectColorKeys,
  resolveProjectColor,
  type ProjectColor,
  type ProjectColorSetting,
} from '../utils/projectColor'

// The renderer's side of one-colour-per-project. Every surface that shows a
// folder glyph — the sidebar's project line, the project header, the New chat
// scope line — reads the hue through these, so a colour change from the header
// menu updates all of them at once: they are all selecting the same map out of
// the same store.

// A stable empty map so a store state that predates the setting (a persisted
// envelope hydrated before normalizeAppSettings filled it in) does not hand a
// fresh object to every selector and re-render the sidebar forever.
const EMPTY_PROJECT_COLORS: Readonly<Record<string, ProjectColorSetting>> = Object.freeze({})

/** Every project's stored colour, keyed by `projectColorKey`. */
export function useProjectColors(): Readonly<Record<string, ProjectColorSetting>> {
  return useWorkspaceStore((s) => s.appSettings.projectColors ?? EMPTY_PROJECT_COLORS)
}

/**
 * The hue one project wears, or null — for a chat with no folder (no key at
 * all), a project not yet seen, and a project whose person chose "No colour".
 * All three render the plain glyph, so callers need not tell them apart.
 */
export function useProjectColor(key: string | null | undefined): ProjectColor | null {
  return useWorkspaceStore((s) => resolveProjectColor(s.appSettings.projectColors, key))
}

/**
 * Allocate a colour to every one of these projects that has not got one yet.
 *
 * Call it with the keys the surface is about to render (nulls welcome — a row
 * with no folder is not a project and is dropped here). The effect runs only
 * when the SET of keys changes, and the action itself writes nothing when no
 * key is missing, so this is safe on every render of the sidebar and cannot
 * loop against its own write.
 */
export function useAssignProjectColors(keys: ReadonlyArray<string | null | undefined>): void {
  const assignProjectColors = useWorkspaceStore((s) => s.assignProjectColors)
  const wanted = projectColorKeys(keys)
  // The signature is only the effect's equality check — "is this the same set
  // of projects?" — and the ARRAY is what gets passed to the action. A joined
  // signature that were split back apart would break on a folder path
  // containing the separator, which is legal on macOS and Linux for every
  // character worth joining on.
  const signature = JSON.stringify(wanted)
  // `wanted` is rebuilt every render and is deliberately not a dependency; the
  // signature is the whole question, and this is what keeps the effect from
  // re-running on a new array holding the same keys.
  const stableKeys = useMemo(() => wanted, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (stableKeys.length === 0) return
    assignProjectColors(stableKeys)
  }, [stableKeys, assignProjectColors])
}
