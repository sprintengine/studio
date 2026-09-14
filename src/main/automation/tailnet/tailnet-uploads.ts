import { isAbsolute, join, resolve, sep } from 'path'
import { workspaceSidecarPath } from '../../workspace-sidecar'

// Where a file uploaded from a phone lands, and the guard that keeps it there
// (backlog id 88, multicode-mobile: "files and images from the phone").
//
// Separate from the route because this is the security-critical half: a phone
// is naming a file on someone else's machine, and the whole contract is that
// whatever it names ends up inside the thread's own working directory or
// nowhere at all. The only thing read off disk is which sidecar directory the
// thread's cwd uses; both containment guards below hold whatever the answer is.

/** The per-thread directory uploads land in, inside the session cwd's sidecar. */
const UPLOAD_DIR_SEGMENTS = ['uploads'] as const

/**
 * The ceiling, enforced where the bytes land rather than where they are picked.
 *
 * A client-side check is a courtesy; this is the control. 25MB takes a phone
 * photo and a slide deck and refuses a video, which is the right shape for a
 * link that also has to carry a terminal.
 */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024

/**
 * A file name reduced to something that can only be a leaf.
 *
 * Everything that could make it traverse is removed rather than escaped:
 * separators of both kinds, the drive-letter and UNC shapes Windows accepts,
 * NUL, control characters, and a leading run of dots. What survives is the
 * base name a person would recognise, and `upload` when nothing survives —
 * because a file called `..` must become a real name, not an error the phone
 * has to explain halfway through a transfer.
 */
export function sanitizeUploadName(raw: string): string {
  const leaf = raw
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .split(/[\\/]/u)
    .pop()
    ?.trim()
  if (!leaf) return 'upload'
  const cleaned = leaf
    .replace(/^[.\s]+/u, '')
    .replace(/[:*?"<>|]/gu, '_')
    .slice(0, 120)
    .trim()
  return cleaned.length > 0 ? cleaned : 'upload'
}

export type UploadDestination =
  | { ok: true; directory: string; path: string }
  | { ok: false; code: 'invalid_session' | 'path_escape'; message: string }

/**
 * Where one upload goes, or why it may not.
 *
 * `cwd` is the terminal session's own working directory, read from the
 * terminal host — never from the request. A session with no cwd has nowhere
 * safe to put a file and is refused rather than falling back to a temp
 * directory: an agent is usually confined to its project folder, so a file
 * outside it is one the agent cannot read, and the upload would "succeed"
 * while being useless.
 *
 * The resolved path is re-checked against the resolved directory even though
 * the name was sanitised first. Two guards, because they fail differently: the
 * sanitiser can be wrong about a shape it has not seen, and this cannot — it
 * compares the strings the filesystem will actually use.
 */
export function resolveUploadDestination(input: {
  cwd: string | null | undefined
  sessionId: string
  name: string
  /** Names already taken in the directory, so an upload never overwrites one. */
  taken?: ReadonlySet<string>
}): UploadDestination {
  const cwd = input.cwd?.trim()
  if (!cwd || !isAbsolute(cwd)) {
    return {
      ok: false,
      code: 'invalid_session',
      message: 'That thread has no working directory on this machine, so there is nowhere to put a file.',
    }
  }
  const sessionSegment = sanitizeUploadName(input.sessionId)
  const directory = resolve(workspaceSidecarPath(cwd, ...UPLOAD_DIR_SEGMENTS, sessionSegment))
  const root = resolve(cwd)
  // `sep` on the prefix so `/repo-backup` cannot pass as inside `/repo`.
  if (directory !== root && !directory.startsWith(root + sep)) {
    return { ok: false, code: 'path_escape', message: 'That upload would land outside the thread’s folder.' }
  }
  const path = resolve(join(directory, uniqueName(sanitizeUploadName(input.name), input.taken)))
  if (!path.startsWith(directory + sep)) {
    return { ok: false, code: 'path_escape', message: 'That file name would land outside the thread’s folder.' }
  }
  return { ok: true, directory, path }
}

/**
 * `shot.png`, then `shot (2).png` — never an overwrite.
 *
 * Two photos from a camera roll on the same day carry the same name far more
 * often than not, and silently replacing the first is a loss the person cannot
 * see from the phone.
 */
export function uniqueName(name: string, taken?: ReadonlySet<string>): string {
  if (!taken || !taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} (${index})${extension}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${extension}`
}
