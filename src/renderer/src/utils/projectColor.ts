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
//    `multicode` blue on one Mac and teal on the next.
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
// It is not React-free, and deliberately not yet: `projectColorKey` needs
// `folderIdentityKey`, which today lives in the `useFolderRepositoryIdentities`
// hook module and drags React in behind it. That is one normalisation shared by
// the sidebar's grouping and this key, so duplicating it would be worse than
// the import — two spellings of "the same folder" is exactly the bug the
// function exists to prevent. It wants moving to its own module (and the hook
// re-exporting it); that file is under another change right now, so the move is
// left for whoever touches it next.

import type { CSSProperties } from 'react'

import { folderIdentityKey } from '../components/workspace/useFolderRepositoryIdentities'
import type { ProjectColor, ProjectColorSetting } from '../types/workspace'

// The two names live in types/workspace.ts, beside HighlightColor, because
// AppSettings.projectColors is part of the settings shape main compiles against
// and tsconfig.node lists that one renderer file. Re-exported here so every
// consumer imports the colour and its type from one module.
export type { ProjectColor, ProjectColorSetting }

/** A hue is a whole degree on the OKLCH wheel, 0 to 359. */
export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 360
}

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
 * The two kinds of key are prefixed so a folder path can never collide with a
 * repository key. `github.com/acme/x` and a folder literally named
 * `github.com/acme/x` are different projects, and an unprefixed map could not
 * tell them apart after the fact.
 */
export const PROJECT_KEY_REPOSITORY_PREFIX = 'repo:'
export const PROJECT_KEY_FOLDER_PREFIX = 'folder:'

/**
 * The key a project's colour is derived from and its override is stored under,
 * or null when there is no project to colour.
 *
 * The repository wins when one is known, so every clone of it — including a
 * paired machine's row, whose identity arrives on `workspace.remoteOrigin
 * .repository` — resolves to one key and therefore one hue. A folder with no
 * remote falls back to its normalised path (`folderIdentityKey`, the same
 * normalisation the sidebar groups by), so two spellings of one folder are one
 * project.
 *
 * No folder is null, never a sentinel: a chat with no folder is not a project,
 * and hashing a `'__no_folder__'` string would give every unfiled chat a shared
 * "project" colour.
 */
export function projectColorKey(input: {
  folderPath: string | null | undefined
  repository?: { canonicalKey: string } | null
}): string | null {
  const canonicalKey = input.repository?.canonicalKey?.trim().toLowerCase()
  if (canonicalKey) return `${PROJECT_KEY_REPOSITORY_PREFIX}${canonicalKey}`
  const folderPath = input.folderPath?.trim()
  if (!folderPath) return null
  const identity = folderIdentityKey(folderPath)
  if (!identity) return null
  return `${PROJECT_KEY_FOLDER_PREFIX}${identity}`
}

/**
 * The part of a key that names the project the same way on every machine.
 *
 * A repository key already does (`github.com/acme/multicode`), and all of it is
 * hashed so two organisations' `api` repositories differ. A folder key is a
 * path on THIS disk, so only its last segment is hashed — which does make two
 * unrelated `notes` folders one colour, but a folder with no remote has no
 * other identity a second machine could agree on.
 */
function projectHueSeed(key: string): string {
  if (key.startsWith(PROJECT_KEY_REPOSITORY_PREFIX)) return key.slice(PROJECT_KEY_REPOSITORY_PREFIX.length)
  if (key.startsWith(PROJECT_KEY_FOLDER_PREFIX)) {
    const segments = key.slice(PROJECT_KEY_FOLDER_PREFIX.length).split('/').filter(Boolean)
    return segments[segments.length - 1] ?? key
  }
  return key
}

/**
 * The hue a project wears when nobody has chosen one: FNV-1a over the seed's
 * UTF-16 code units, then murmur3's 32-bit finaliser so names differing in one
 * trailing character land far apart on the wheel rather than a degree or two
 * along it. Code units rather than bytes so there is no encoder to differ
 * between runtimes; the key is already normalised (lower-cased, forward
 * slashes) before it gets here.
 *
 * Changing this function recolours every project for everyone, so it is
 * pinned by golden values in projectColor.test.ts.
 */
export function projectHue(key: string): ProjectColor {
  const seed = projectHueSeed(key)
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return (hash >>> 0) % 360
}

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
