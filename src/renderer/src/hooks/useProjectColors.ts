import { useWorkspaceStore } from '../store/workspaceStore'
import { resolveProjectColor, type ProjectColor, type ProjectColorSetting } from '../utils/projectColor'

// The renderer's side of one-colour-per-project. Every surface that shows a
// folder glyph — the sidebar's project line, the project header, the New chat
// scope line — reads the hue through these, so a colour change from the header
// menu updates all of them at once: they are all selecting the same override
// map out of the same store, and hashing the same key when it has no entry.

// A stable empty map so a store state that predates the setting (a persisted
// envelope hydrated before normalizeAppSettings filled it in) does not hand a
// fresh object to every selector and re-render the sidebar forever.
const EMPTY_PROJECT_COLORS: Readonly<Record<string, ProjectColorSetting>> = Object.freeze({})

/** Every override the person has chosen, keyed by `projectColorKey`. */
export function useProjectColors(): Readonly<Record<string, ProjectColorSetting>> {
  return useWorkspaceStore((s) => s.appSettings.projectColors ?? EMPTY_PROJECT_COLORS)
}

/**
 * The hue one project wears, or null — for no key (a chat with no folder, or a
 * caller holding the key back until it is final) and for a project whose
 * person chose "No colour". Both render the plain glyph.
 */
export function useProjectColor(key: string | null | undefined): ProjectColor | null {
  return useWorkspaceStore((s) => resolveProjectColor(s.appSettings.projectColors, key))
}
