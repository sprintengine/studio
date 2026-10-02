import { realpath } from 'node:fs/promises'
import path from 'node:path'

// Which files the Studio RPC's chat surface may stat or read: those inside the
// folders a chat can be about (a workspace's folder, a chat's own folder) and
// the app's own stores of what chats sent and planned. Today only Studio's own
// connections may ask at all, but the methods name a read scope, and a later
// scope for paired apps must not inherit "any path on this disk".
//
// A path is judged by where it really is, every symlink followed, so a link
// inside a workspace that points outside it reads as outside. A path is also
// refused if it is not the one plain spelling of where it points: a `..` or
// `.` segment, a doubled separator, a different case
// from the file's own on a disk that ignores case, or on Windows a device or
// UNC prefix, a short `NAME~1` segment, a stream suffix, or a segment ending
// in a dot or space. Each of those names a file by a spelling a check on the
// plain one can miss. A trailing separator is how a transcript names a
// folder, and is read as that folder.

export const OUTSIDE_CHAT_FOLDERS = 'That file is outside the folders this chat can read.'
const NOT_PLAIN = 'That path is not written plainly; name the file by its own path.'

export type ConfinedPath = { ok: true; path: string } | { ok: false; message: string }

type Options = { platform?: NodeJS.Platform }

/** Whether a path is the one plain, absolute spelling of itself. */
export function isPlainAbsolutePath(requested: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!requested || requested.length > 4096 || requested.includes('\0')) return false
  if (platform === 'win32') {
    const win = path.win32
    if (!/^[A-Za-z]:\\/.test(requested)) return false // no `\\?\`, `\\.\`, UNC or relative-to-drive
    if (win.normalize(requested) !== requested) return false
    const folder = requested.length > 3 && requested.endsWith('\\') ? requested.slice(0, -1) : requested
    for (const segment of folder.length > 3 ? folder.slice(3).split('\\') : []) {
      if (!segment || /[.\s]$/.test(segment) || segment.includes(':') || /~\d/.test(segment)) return false
    }
    return true
  }
  return path.posix.isAbsolute(requested) && path.posix.normalize(requested) === requested
}

/** The real path of a file, or of where it would be: its nearest existing folder, real, and the rest. */
async function realPathOrWouldBe(requested: string): Promise<string> {
  const rest: string[] = []
  let at = requested
  for (;;) {
    try {
      const real = await realpath(at)
      return rest.length ? path.join(real, ...rest.reverse()) : real
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = path.dirname(at)
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === at) throw error
      rest.push(path.basename(at))
      at = parent
    }
  }
}

function inside(child: string, root: string): boolean {
  const relative = path.relative(root, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * The real path to read for `requested`, when it is plainly spelt and really
 * inside one of `roots`; a refusal otherwise. Roots that do not exist are
 * passed over.
 */
export async function confineToRoots(
  requested: unknown,
  roots: readonly string[],
  options: Options = {},
): Promise<ConfinedPath> {
  const platform = options.platform ?? process.platform
  if (typeof requested !== 'string' || !isPlainAbsolutePath(requested, platform))
    return { ok: false, message: NOT_PLAIN }
  // A folder named with a trailing separator is that folder.
  const named = requested.length > 1 && /[\\/]$/.test(requested) ? requested.slice(0, -1) : requested
  if (/^[A-Za-z]:$/.test(named)) return { ok: false, message: NOT_PLAIN }
  let real: string
  try {
    real = await realPathOrWouldBe(named)
  } catch {
    return { ok: false, message: OUTSIDE_CHAT_FOLDERS }
  }
  // The same file under another case is another spelling of it, not a link to it.
  if (real !== named && real.toLowerCase() === named.toLowerCase()) return { ok: false, message: NOT_PLAIN }
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue
    const realRoot = await realpath(root).catch(() => null)
    if (realRoot && inside(real, realRoot)) return { ok: true, path: real }
  }
  return { ok: false, message: OUTSIDE_CHAT_FOLDERS }
}
