import type { WorkspaceFolderRole } from '../types/workspace'

// What a folder IS comes from the person's "Mark Directory As" choice: no amount of sniffing tells you
// that `out/` is build output and `backlog/` is not. A heuristic would guess;
// this is answered.
//
// A role is stored against one folder and INHERITED by everything beneath it,
// because that is what the roles mean: marking `out/` excluded excludes the
// tree, not the one row. `resolveFolderRole` walks up to the nearest declared
// ancestor, so the map stays as small as the number of folders actually marked.

/**
 * The six folder roles the tree offers. The union itself lives in
 * `types/workspace.ts` beside the state that persists it (the node tsconfig
 * project sees that module and this one it does not); this is the name the
 * renderer uses.
 */
export type FolderRole = WorkspaceFolderRole

export const FOLDER_ROLE_ORDER: FolderRole[] = [
  'sources',
  'test-sources',
  'resources',
  'test-resources',
  'generated',
  'excluded',
]

export const FOLDER_ROLE_LABEL: Record<FolderRole, string> = {
  sources: 'Sources root',
  'test-sources': 'Test sources root',
  resources: 'Resources root',
  'test-resources': 'Test resources root',
  generated: 'Generated sources root',
  excluded: 'Excluded',
}

/** A folder path → the role declared ON it. Descendants inherit; they are not stored. */
export type FolderRoleMap = Record<string, FolderRole>

/**
 * The row background a row carries at rest. `null` is the ordinary row.
 *
 * Only two washes exist, because only two questions are worth a whole row:
 * "is this test material?" and "is this machine-written?". `sources` and
 * `resources` mark a folder without washing its subtree — a wash on the source
 * root would tint most of the tree and say nothing.
 */
export type RowWash = 'test' | 'generated' | null

export function folderRoleWash(role: FolderRole): RowWash {
  switch (role) {
    case 'test-sources':
    case 'test-resources':
      return 'test'
    case 'generated':
    case 'excluded':
      return 'generated'
    default:
      return null
  }
}

// The folder mark's ink. Teal — not another green — carries the test
// roles here, because this product's accent IS green (`accent.primary`, the
// signature forest green) and `status.good` is the emerald beside it. A third
// green on a folder would read as "selected" or "passing" rather than "test".
// Teal is the identity hue the token source already holds apart from both.
const FOLDER_ROLE_INK: Record<FolderRole, string | null> = {
  sources: 'text-[color:var(--sem-color-mark-blue)]',
  'test-sources': 'text-[color:var(--sem-color-mark-teal)]',
  resources: null,
  'test-resources': 'text-[color:var(--sem-color-mark-teal)]',
  generated: 'text-[color:var(--sem-color-mark-blue)]',
  excluded: 'text-[color:var(--sem-color-mark-orange)]',
}

/** The ink utility a role's folder glyph wears, or null when it keeps the row's ink. */
export function folderRoleInk(role: FolderRole): string | null {
  return FOLDER_ROLE_INK[role]
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * The role governing `path` — declared on it, or inherited from the nearest
 * marked ancestor at or below `rootPath`. Returns null when nothing above it is
 * marked.
 *
 * The walk stops at `rootPath` so a mark made in one workspace can never leak
 * into a sibling checkout that happens to share a parent directory.
 */
export function resolveFolderRole(roles: FolderRoleMap, path: string, rootPath: string): FolderRole | null {
  if (!roles || Object.keys(roles).length === 0) return null

  const root = normalize(rootPath)
  let current = normalize(path)

  while (current.length >= root.length) {
    const role = roles[current]
    if (role) return role
    if (current === root) return null
    const slash = current.lastIndexOf('/')
    if (slash <= 0) return null
    current = current.slice(0, slash)
  }

  return null
}

/**
 * The wash a row paints at rest, given the role governing it and whether the
 * file's own name says it is a test.
 *
 * A role that HAS a wash wins over the name: a `foo.test.ts` inside a folder
 * marked Excluded is machine-written test material, and the thing worth knowing
 * about it is that it is excluded — without this a generated fixture would wash
 * teal inside an orange tree and read as hand-written.
 *
 * A role with NO wash (sources, resources) falls through to the name instead of
 * suppressing it. Marking `src/` as the sources root is a statement about the
 * folder, not a claim that nothing beneath it is a test.
 */
export function resolveRowWash(role: FolderRole | null, isTest: boolean): RowWash {
  const declared = role ? folderRoleWash(role) : null
  if (declared) return declared
  return isTest ? 'test' : null
}

/** The class that paints a wash, or '' for an ordinary row. */
export function rowWashClass(wash: RowWash): string {
  if (wash === 'test') return 'file-row-wash-test'
  if (wash === 'generated') return 'file-row-wash-generated'
  return ''
}
