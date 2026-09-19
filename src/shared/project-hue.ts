// The project hue, and nothing else.
//
// Extracted from renderer/src/utils/projectColor.ts (which now re-exports it)
// because main has to derive the same hue: `terminal.list` carries a row's
// project colour to a paired phone, and the phone must land on the SAME degree
// the desktop's own sidebar is painting. Duplicating the hash in the mobile
// repo would be two spellings of one wheel, drifting the first time either is
// touched — the exact bug the "derived, not allocated" decision exists to stop.
//
// Pure: no React, no DOM, no settings. The override lookup and the CSS plumbing
// stay in the renderer module, because both are a screen's business; the hash
// is the wire's.
//
// Changing anything here recolours every project for everyone, on every
// surface and both repos. It is pinned by golden values in
// renderer/src/utils/projectColor.test.ts and project-hue.test.ts.

/** A hue is a whole degree on the OKLCH wheel, 0 to 359. */
export type ProjectColor = number

/**
 * The two kinds of key are prefixed so a folder path can never collide with a
 * repository key. `github.com/acme/x` and a folder literally named
 * `github.com/acme/x` are different projects, and an unprefixed map could not
 * tell them apart after the fact.
 */
export const PROJECT_KEY_REPOSITORY_PREFIX = 'repo:'
export const PROJECT_KEY_FOLDER_PREFIX = 'folder:'

export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 360
}

/**
 * The normalisation two spellings of one folder share: forward slashes, no
 * trailing separator, lower case. The renderer's `folderIdentityKey` is this
 * function; it stays there too because the sidebar's grouping imports it from
 * the hook module it has always lived in.
 */
export function normalizeFolderKey(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * The key a project's colour is derived from, or null when there is no project
 * to colour.
 *
 * The repository wins when one is known, so every clone of it — this disk's and
 * a paired machine's — resolves to one key and therefore one hue. A folder with
 * no remote falls back to its normalised path.
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
  const identity = normalizeFolderKey(folderPath)
  if (!identity) return null
  return `${PROJECT_KEY_FOLDER_PREFIX}${identity}`
}

/**
 * The part of a key that names the project the same way on every machine.
 *
 * A repository key already does (`github.com/acme/sprintengine`), and all of it is
 * hashed so two organisations' `api` repositories differ. A folder key is a
 * path on THIS disk, so only its last segment is hashed — which does make two
 * unrelated `notes` folders one colour, but a folder with no remote has no
 * other identity a second machine could agree on.
 */
export function projectHueSeed(key: string): string {
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
 * between runtimes — which is what lets React Native run this byte for byte.
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
