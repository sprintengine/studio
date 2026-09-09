// One colour per project, worn on the folder glyph (owner review 2026-09-09).
//
// The problem is confusion between projects, not decoration: with a dozen
// chats open, "which repo is this row?" is answered by reading the folder name
// every time. A hue on the glyph answers it before the name is read.
//
// The rules this module encodes, from the decisions of record:
//
//  * SIX hues, from the design system's identity-mark family — blue, teal,
//    cyan, violet, orange, red. Gold is excluded because it is what a row
//    wears when an agent is waiting on the person, and there is no green
//    because that is the finished tint; neither may double as a project's
//    colour on the same row. Each is a theme-portable token (the
//    `.project-mark-*` classes in assets/index.css), never a hex, so it reads
//    on the four light themes as well as the seven dark ones.
//  * A PROJECT IS A REPOSITORY. Two clones of one repository — this disk's and
//    a paired machine's — are one project and wear one hue, so the key is the
//    canonical repository key when the folder has a remote and the folder
//    identity key otherwise. This keeps the one-project-across-machines ruling
//    (src/shared/repository-identity.ts) intact: the machine is a glyph on the
//    row, never a second colour.
//  * NO FOLDER IS NOT A PROJECT. A chat with no folder has no key at all, so
//    it can never be allocated a hue; its glyph is the dashed grey outline.
//  * ASSIGNED ON FIRST SIGHT, THEN STORED. The pick is deterministic — the
//    first unused hue, else the least-used one — and it is written to
//    `appSettings.projectColors` once, so it never changes behind the person's
//    back. `'none'` is the person saying "no colour", which is a different
//    thing from "not yet seen" (absent) and is skipped when allocating.
//
// Pure and React-free so the store's allocator, the hooks and the tests all
// derive the same answers from the same code.

import { folderIdentityKey } from '../components/workspace/useFolderRepositoryIdentities'
import type { ProjectColor, ProjectColorSetting } from '../types/workspace'

// The two names live in types/workspace.ts, beside HighlightColor, because
// AppSettings.projectColors is part of the settings shape main compiles against
// and tsconfig.node lists that one renderer file. Re-exported here so every
// consumer imports the palette and its type from one module.
export type { ProjectColor, ProjectColorSetting }

/** The six identity hues, in allocation order. */
export const PROJECT_COLORS = ['blue', 'teal', 'cyan', 'violet', 'orange', 'red'] as const

// Compile-time drift guard between the ordered list above and the union in
// types/workspace.ts: adding a hue to one and not the other stops the build
// here rather than silently making the palette and the stored type disagree.
type PaletteMember = (typeof PROJECT_COLORS)[number]
type AssertSame<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : never) : never
const paletteMatchesStoredUnion: AssertSame<PaletteMember, ProjectColor> = true
void paletteMatchesStoredUnion

const PROJECT_COLOR_SET: ReadonlySet<string> = new Set<string>(PROJECT_COLORS)

export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === 'string' && PROJECT_COLOR_SET.has(value)
}

export function isProjectColorSetting(value: unknown): value is ProjectColorSetting {
  return value === 'none' || isProjectColor(value)
}

/**
 * The two kinds of key are prefixed so a folder path can never collide with a
 * repository key. `github.com/acme/x` and a folder literally named
 * `github.com/acme/x` are different projects, and an unprefixed map could not
 * tell them apart after the fact.
 */
export const PROJECT_KEY_REPOSITORY_PREFIX = 'repo:'
export const PROJECT_KEY_FOLDER_PREFIX = 'folder:'

/**
 * The key a project's colour is stored under, or null when there is no project
 * to colour.
 *
 * The repository wins when one is known, so every clone of it — including a
 * paired machine's row, whose identity arrives on `workspace.remoteOrigin
 * .repository` — resolves to one key and therefore one hue. A folder with no
 * remote falls back to its normalised path (`folderIdentityKey`, the same
 * normalisation the sidebar groups by), so two spellings of one folder are one
 * project.
 *
 * No folder is null, never a sentinel: a chat with no folder is not a project,
 * and hashing a `'__no_folder__'` string would make every unfiled chat share a
 * seventh "project" that then eats one of the six hues.
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
 * The hue to give a project being seen for the first time, given the settings
 * already in force.
 *
 * The first hue nobody is using, so two open projects never receive the same
 * one; when all six are spoken for, the least-used, ties broken by position in
 * `PROJECT_COLORS` so the answer is stable rather than first-come. `'none'`
 * and empty entries are not uses of a hue and never count.
 *
 * Deterministic on purpose. The owner asked for "randomly assign a colour";
 * random is what it looks like from outside, but a random pick would give two
 * projects the same hue often enough to defeat the whole point, and would
 * differ between two runs over the same list.
 */
export function pickProjectColor(used: Iterable<ProjectColorSetting | null | undefined>): ProjectColor {
  const counts = new Map<ProjectColor, number>(PROJECT_COLORS.map((color) => [color, 0]))
  for (const entry of used) {
    if (!isProjectColor(entry)) continue
    counts.set(entry, (counts.get(entry) ?? 0) + 1)
  }
  let leastUsed: ProjectColor = PROJECT_COLORS[0]
  let leastCount = Number.POSITIVE_INFINITY
  for (const color of PROJECT_COLORS) {
    const count = counts.get(color) ?? 0
    if (count === 0) return color
    if (count < leastCount) {
      leastUsed = color
      leastCount = count
    }
  }
  return leastUsed
}

export type ProjectColorSwatch = {
  color: ProjectColor
  /** Menu label and accessible name. */
  label: string
  /** Ink class for the folder glyph — `color`, so the SVG's currentColor follows. */
  glyphClass: string
  /** Fill class for a swatch dot in the same hue (the menu's picker row). */
  swatchClass: string
}

// Both classes live in assets/index.css and resolve to the `--sem-color-mark-*`
// tokens, which follow `data-mode`. Nothing here is a hex: a hex tuned on the
// dark default is the exact bug the highlight palette had to be given light
// overrides for.
const swatches: Record<ProjectColor, ProjectColorSwatch> = {
  blue: { color: 'blue', label: 'Blue', glyphClass: 'project-mark-blue', swatchClass: 'project-swatch-blue' },
  teal: { color: 'teal', label: 'Teal', glyphClass: 'project-mark-teal', swatchClass: 'project-swatch-teal' },
  cyan: { color: 'cyan', label: 'Cyan', glyphClass: 'project-mark-cyan', swatchClass: 'project-swatch-cyan' },
  violet: { color: 'violet', label: 'Violet', glyphClass: 'project-mark-violet', swatchClass: 'project-swatch-violet' },
  orange: { color: 'orange', label: 'Orange', glyphClass: 'project-mark-orange', swatchClass: 'project-swatch-orange' },
  red: { color: 'red', label: 'Red', glyphClass: 'project-mark-red', swatchClass: 'project-swatch-red' },
}

export function getProjectColorSwatch(color: ProjectColor): ProjectColorSwatch {
  return swatches[color]
}

/**
 * The glyph's ink class for a colour, or `''` for no colour — an unset project
 * and a `'none'` project both keep the row's currentColor.
 */
export function projectColorGlyphClass(color: ProjectColor | null | undefined): string {
  return color ? swatches[color].glyphClass : ''
}

/**
 * The hue in force for a key, or null when there is no key, no entry yet, or
 * the person chose "No colour". Callers render the plain glyph for null.
 */
export function resolveProjectColor(
  projectColors: Readonly<Record<string, ProjectColorSetting>> | undefined,
  key: string | null | undefined,
): ProjectColor | null {
  if (!key || !projectColors) return null
  const setting = projectColors[key]
  return isProjectColor(setting) ? setting : null
}
