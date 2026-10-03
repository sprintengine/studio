import { existsSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { isMachinePath } from '../../shared/machine-paths'
import type { FolderBrowserEntry, FolderBrowserListing } from '../../shared/web-client'

// The server-side folder browser (phase 9 spec, 6.5): what replaces the native
// folder picker in a browser, which has no paths of the server's machine to
// offer. Directories only; a file is never listed or read. It starts in the
// owner's home, takes a typed path, hides dot-directories unless asked, and
// lists at most a thousand entries a level. Paths are resolved through their
// symbolic links before they are listed, so a link loop is one directory
// reached by its real name, not a walk without end.
//
// Only an owner's web tab reaches it, over its IPC tunnel (the cookie is the
// check at the upgrade).

const MAX_ENTRIES = 1000

/** Names that are almost never a project of their own, marked so the dialog can say so. */
const NOT_A_PROJECT = new Set(['node_modules', '__pycache__', 'target', 'dist', 'build', 'out', 'vendor'])

export type FolderBrowserInput = { path?: unknown; showHidden?: unknown }

export async function browseFolders(
  input: FolderBrowserInput,
  home: string = homedir(),
): Promise<FolderBrowserListing> {
  const asked = typeof input.path === 'string' && input.path.trim() !== '' ? input.path.trim() : home
  // A workspace on an SSH machine keeps its folder spelled `ssh://…`; its
  // folders are that machine's, and this server's disk has none of them.
  const onMachine: boolean = isMachinePath(asked)
  if (onMachine) {
    return { ok: false, message: 'That folder is on an SSH machine. Choose its folders in the desktop app.' }
  }
  const expanded = asked === '~' ? home : asked.startsWith('~/') ? join(home, asked.slice(2)) : asked
  if (!isAbsolute(expanded) || expanded.includes('\0')) {
    return { ok: false, message: 'Type a full path, starting from / (or ~ for your home folder).' }
  }
  let path: string
  try {
    path = await realpath(expanded)
    if (!(await stat(path)).isDirectory()) return { ok: false, message: `${asked} is not a folder.` }
  } catch {
    return { ok: false, message: `${asked} does not exist, or Studio cannot open it.` }
  }
  let names: string[]
  try {
    names = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return { ok: false, message: `Studio cannot list ${path}.` }
  }
  const showHidden = input.showHidden === true
  const visible = names
    .filter((name) => showHidden || !name.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
  const entries: FolderBrowserEntry[] = []
  for (const name of visible) {
    if (entries.length >= MAX_ENTRIES) break
    const full = join(path, name)
    try {
      // A link is listed only when it leads to a folder.
      if (!(await stat(full)).isDirectory()) continue
    } catch {
      continue
    }
    entries.push({
      name,
      path: full,
      project: existsSync(join(full, '.git')),
      hint: NOT_A_PROJECT.has(name) ? 'not-a-project' : null,
    })
  }
  const parent = dirname(path) === path ? null : dirname(path)
  return { ok: true, path, parent, home, entries, truncated: visible.length > entries.length }
}
