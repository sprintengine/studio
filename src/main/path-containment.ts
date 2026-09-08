// The main process's two path-containment checks.
//
// Both resolve each side through Node's `path` first, so `a/b/../c` and a
// relative argument are compared as the file they actually name, and a symlink
// is NOT followed (containment is about the path a caller handed us, not the
// inode it lands on — a caller that must defeat symlinks resolves them itself
// before asking).
//
// Sixteen copies of these two predicates lived across main under four names
// (`isPathInsideOrEqual`, `isPathInside`, `isInside`, and a reversed-argument
// twin). They fell into exactly two families — one that counts the parent
// itself as contained and one that does not — and this is those two families.
// Three case-insensitive, string-normalizing variants
// (`shared/project-knowledge.ts`, `main/memory-graph.ts`,
// `shared/sprintengine/state.ts`) are a different predicate and keep their own.
//
// The renderer's `isPathOrChild` (src/shared/paths.ts) is a third thing again:
// a pure string comparison over user-visible paths, with no Node and no cwd.

import { isAbsolute, relative, resolve } from 'path'

/** `targetPath` IS `parentPath`, or sits under it. */
export function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(targetPath))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * `childPath` sits strictly under `parentPath` — the directory itself does not
 * count. What an installer wants: "somewhere inside the root I am writing to",
 * where the root itself is not a file it may create or overwrite.
 */
export function isPathStrictlyInside(parentPath: string, childPath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(childPath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
