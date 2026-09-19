// One colour per project, worn on the folder glyph (owner review 2026-09-09,
// revised 2026-09-11).
//
// The problem is confusion between projects, not decoration: with a dozen
// chats open, "which repo is this row?" is answered by reading the folder name
// every time. A hue on the glyph answers it before the name is read.
//
// The rules this module encodes, from the decisions of record:
//
//  * DERIVED FROM THE NAME, NOT ALLOCATED (owner, 2026-09-11). A project's hue
//    is a hash of its key, so the same project is the same colour on every
//    machine and for every person, with nothing to sync. The 2026-09-09 design
//    handed out six hues first-come and stored the pick per machine, which made
//    `sprintengine` blue on one Mac and teal on the next.
//  * THE WHOLE HUE WHEEL, AT ONE LIGHTNESS AND CHROMA. Yellow, green, pink —
//    every hue — at the same `--sem-color-mark-project-lightness` and
//    `-chroma`, which differ per mode so every hue reads on all eleven themes
//    (assets/index.css). Chroma is never zero, so a project is never black,
//    white or grey: those are the row's own inks and would read as "no
//    project". The owner ruled yellow and green in on 2026-09-11, overriding
//    the 2026-09-09 exclusion of the waiting and finished tints.
//  * A PROJECT IS A REPOSITORY. Two clones of one repository — this disk's and
//    a paired machine's — are one project and wear one hue, so the key is the
//    canonical repository key when the folder has a remote and the folder
//    identity key otherwise (src/shared/repository-identity.ts). A folder with
//    no remote has no identity another machine shares, so its hue hashes the
//    folder's NAME rather than its path: `/Users/a/notes` and `/home/b/notes`
//    agree.
//  * NO FOLDER IS NOT A PROJECT. A chat with no folder has no key at all, so it
//    has no hue; its glyph is the dashed grey outline.
//  * STORED ONLY WHEN THE PERSON CHOOSES. `appSettings.projectColors` holds
//    overrides and nothing else: a hue the person picked, or `'none'` for "no
//    colour". Absent means "the hashed hue". An override is this machine's, so
//    it is the one way a project can look different on someone else's screen.
//
// Two projects CAN hash to hues close enough to confuse; nothing coordinates
// them, because coordinating needs to know what else is open, which is local.
// The override is the remedy.
//
// Pure — no state, no side effects, no randomness — so every surface and the
// tests derive the same answers from the same code.
//
// The hash itself now lives in shared/project-hue.ts and this module
// re-exports it. Main needs the same degrees — `terminal.list` carries a row's
// hue to a paired phone — and a renderer module is not importable from there.
// What stays here is the part that is a screen's business: the stored override,
// the picker's presets, and the CSS custom property. `folderIdentityKey` is now
// the shared `normalizeFolderKey` under its old name, so the sidebar's grouping
// and this key remain one normalisation rather than two.

import type { CSSProperties } from 'react'

import {
  PROJECT_KEY_FOLDER_PREFIX,
  PROJECT_KEY_REPOSITORY_PREFIX,
  isProjectColor,
  projectColorKey,
  projectHue,
} from '../../../shared/project-hue'
import type { ProjectColor, ProjectColorSetting } from '../types/workspace'

// The two names live in types/workspace.ts, beside HighlightColor, because
// AppSettings.projectColors is part of the settings shape main compiles against
// and tsconfig.node lists that one renderer file. Re-exported here so every
// consumer imports the colour and its type from one module.
export type { ProjectColor, ProjectColorSetting }

// The hash, the key and the guard come from shared/project-hue.ts; every
// existing importer of this module keeps its import path.
export { PROJECT_KEY_FOLDER_PREFIX, PROJECT_KEY_REPOSITORY_PREFIX, isProjectColor, projectColorKey, projectHue }

/**
 * A stored override: a hue, or `'none'`. The six hue NAMES the 2026-09-09
 * build stored (`'blue'`, `'teal'` …) are not settings any more, so a settings
 * file from that build drops them on read and every project returns to its
 * hashed hue — the same colour on every machine, which a kept first-come pick
 * never could be.
 */
export function isProjectColorSetting(value: unknown): value is ProjectColorSetting {
  return value === 'none' || isProjectColor(value)
}

/**
 * The picker's named hues. Offered as a starting point for an override, not a
 * palette the hash is limited to: a hashed project can wear any of the 360.
 * Angles are OKLCH hues, picked so each reads as its own name at the
 * project-mark lightness in both modes.
 */
export const PROJECT_COLOR_PRESETS: ReadonlyArray<{ hue: ProjectColor; label: string }> = [
  { hue: 25, label: 'Red' },
  { hue: 60, label: 'Orange' },
  { hue: 100, label: 'Yellow' },
  { hue: 145, label: 'Green' },
  { hue: 200, label: 'Cyan' },
  { hue: 255, label: 'Blue' },
  { hue: 300, label: 'Violet' },
  { hue: 345, label: 'Pink' },
]

/**
 * The hue in force for a key, or null when there is no key or the person chose
 * "No colour". Callers render the plain glyph for null.
 *
 * Callers must not ask before the key is FINAL. A folder whose repository read
 * has not landed keys as `folder:` and becomes `repo:` a beat later, so asking
 * early paints one hue and then another; the surfaces pass null until the
 * identity question is answered.
 */
export function resolveProjectColor(
  projectColors: Readonly<Record<string, ProjectColorSetting>> | undefined,
  key: string | null | undefined,
): ProjectColor | null {
  if (!key) return null
  const setting = projectColors?.[key]
  if (setting === 'none') return null
  if (isProjectColor(setting)) return setting
  return projectHue(key)
}

/**
 * The class a glyph or swatch wears for a hue; the hue itself rides
 * `projectColorStyle`. Both live in assets/index.css as one rule, so the dot a
 * person clicks is the colour the glyph then wears, in every theme.
 */
export const PROJECT_MARK_CLASS = 'project-mark'
export const PROJECT_SWATCH_CLASS = 'project-swatch'

/**
 * The inline custom property that carries a hue into `.project-mark` /
 * `.project-swatch`. A style rather than a class because there are 360 of
 * them; lightness and chroma stay tokens, so the only thing inline is the
 * angle.
 */
export function projectColorStyle(color: ProjectColor | null | undefined): CSSProperties | undefined {
  if (color === null || color === undefined) return undefined
  return { '--project-hue': color } as CSSProperties
}
