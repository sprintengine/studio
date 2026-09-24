// The helper's Unix sockets, and the directory they live in.
//
// Hooks, the status line, OpenCode's in-process plugin and the MCP bridge all
// run as the person's own Linux user inside the distribution, and reach the
// helper through two sockets in one directory:
//
//   <runtime>/sprintengine/<profile>/agent.sock   agent-state frames
//   <runtime>/sprintengine/<profile>/mcp.sock     MCP bridge connections
//
// <runtime> is `$XDG_RUNTIME_DIR` when it is a directory this user owns and no
// one else can enter, else `/tmp/sprintengine-<uid>`. Every directory the
// helper creates is 0700 and each socket 0600, the same trust level as the
// app's own socket on macOS and Linux: only this user can connect, and this
// user could already drive the app's automation server anyway.
//
// A directory someone else created first (a shared `/tmp`) is refused rather
// than used: the helper would otherwise listen where another user can replace
// the socket under it.

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const PROFILE = /^[A-Za-z0-9_-]{1,64}$/u

function ownedPrivateDir(path, uid) {
  try {
    const stats = lstatSync(path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false
    if (typeof uid === 'number' && stats.uid !== uid) return false
    return (stats.mode & 0o077) === 0
  } catch {
    return false
  }
}

/**
 * Creates `path` (0700) if it is missing, and checks it is ours and private
 * whether or not it was. Throws when it is not, naming the directory.
 */
export function ensurePrivateDir(path, uid) {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  if (!ownedPrivateDir(path, uid)) {
    throw new Error(`${path} is not a private directory owned by this user; refusing to listen there.`)
  }
  return path
}

/** The base under which the helper's per-profile directory goes. */
export function runtimeBase({ env, uid }) {
  const xdg = env.XDG_RUNTIME_DIR
  if (xdg && xdg.startsWith('/') && ownedPrivateDir(xdg, uid)) return join(xdg, 'sprintengine')
  return `/tmp/sprintengine-${uid}`
}

/** Creates (or checks) the per-profile socket directory, every level private. */
export function ensureSocketDir({ env, uid, profile, base }) {
  if (!PROFILE.test(profile)) throw new Error('The profile id is not a plain token.')
  const root = base ?? runtimeBase({ env, uid })
  ensurePrivateDir(root, uid)
  return ensurePrivateDir(join(root, profile), uid)
}

/**
 * Listens on a Unix socket at `path`, readable and writable by this user only.
 * A stale socket file from a helper that died is removed first; the umask is
 * narrowed around `listen` so the socket is never briefly open to others.
 */
export async function listenPrivate(path, onConnection, options = {}) {
  try {
    unlinkSync(path)
  } catch {
    // Not there, which is the usual case.
  }
  const server = createServer({ allowHalfOpen: options.allowHalfOpen === true }, onConnection)
  const previous = process.umask(0o077)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } finally {
    process.umask(previous)
  }
  chmodSync(path, 0o600)
  return server
}

/** Closes a server and removes its socket file. */
export async function closePrivate(server, path) {
  await new Promise((resolve) => server.close(() => resolve()))
  try {
    unlinkSync(path)
  } catch {
    // Already gone.
  }
}
