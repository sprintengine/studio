// The files a WSL launch needs inside the distribution: its startup script,
// and the host-context document (or Cursor's one-session plugin directory) its
// CLI is pointed at.
//
// Main used to write these under its Windows user-data folder and hand Linux
// the `/mnt/<drive>/…` path, which only works while the distribution mounts
// the Windows drives at `/mnt` (`[automount] enabled=false` or `root = /` break
// every launch). They are written here instead, into a directory only this
// user can enter:
//
//   ~/.local/share/sprintengine-studio/sessions/<profile>/     0700
//     <key>.sh                                                  0600
//     host-context-<key>.md                                     0600
//
// The startup script holds the launch's secrets as `export` lines (a
// provider's key, the MCP channel token), so every file is 0600 and no
// directory on the way is left open to others.

import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { checkTreePath } from './files.mjs'

const ENTRY = /^[A-Za-z0-9._-]{1,200}$/u
export const MAX_SESSION_WRITE_BYTES = 16 * 1024 * 1024

/**
 * Creates `path` (0700) if it is missing; refuses one that is not a real
 * directory owned by `uid`, and narrows one that is ours but open to others.
 */
function ensureOwnDir(path, uid) {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stats = lstatSync(path)
  if (!stats.isDirectory() || stats.isSymbolicLink() || (typeof uid === 'number' && stats.uid !== uid)) {
    throw new Error(`${path} is not a directory owned by this user; refusing to write launch files there.`)
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(path, 0o700)
  return path
}

/** The profile's private launch-file directory under `home`, created as needed. */
export function ensureSessionDir({ home, uid, profile }) {
  const base = join(home, '.local', 'share', 'sprintengine-studio')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  return ensureOwnDir(join(ensureOwnDir(join(base, 'sessions'), uid), profile), uid)
}

/**
 * Writes `files` ({ path, b64 }, relative to `dir`) as 0600 files, each
 * renamed into place so a shell never reads half of one. Returns their
 * absolute paths.
 */
export function writeSessionFiles(dir, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array.')
  let total = 0
  for (const file of files) {
    if (!checkTreePath(file?.path) || !ENTRY.test(file.path.split('/')[0])) {
      throw new Error(`Refusing the launch file path ${JSON.stringify(file?.path)}.`)
    }
    if (typeof file.b64 !== 'string') throw new Error(`${file.path} has no content.`)
    total += file.b64.length
  }
  if (total > MAX_SESSION_WRITE_BYTES) throw new Error('The launch files are larger than the helper accepts.')
  const paths = []
  for (const file of files) {
    const target = join(dir, file.path)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, Buffer.from(file.b64, 'base64'), { mode: 0o600 })
    renameSync(temporary, target)
    paths.push(target)
  }
  return paths
}

/** Removes top-level entries of `dir` by name; anything that is not a plain name is ignored. */
export function removeSessionEntries(dir, names) {
  if (!Array.isArray(names)) return
  for (const name of names) {
    if (typeof name === 'string' && ENTRY.test(name)) rmSync(join(dir, name), { recursive: true, force: true })
  }
}

/** Empties `dir`: every launch it held belongs to a main that is gone. */
export function clearSessionDir(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true })
}
