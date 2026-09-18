import type { IBufferRange, ILinkHandler } from '@xterm/xterm'

import { normalizePath } from './terminalFileLinks'
import { terminalSurfaceLinkRoots, type TerminalSurface } from './terminalSurfaces'

/**
 * What a terminal is allowed to do with a URI a program printed at it.
 *
 * Two sequences carry one: OSC 8 (`\x1b]8;;<uri>\x1b\\text\x1b]8;;\x1b\\`),
 * which makes text clickable, and OSC 7 (`\x1b]7;file://host/path\x1b\\`),
 * which reports the shell's working directory. Both payloads are entirely
 * attacker-controlled — ANY program with a pane can print either, and in this
 * app that includes every agent CLI and every `cat` of a file an agent was
 * handed. So neither is trusted: this module is the single gate both go
 * through, and it fails closed.
 *
 * The rules, in the order they bite:
 *
 * 1. **Scheme allowlist.** `file:`, `http:`, `https:` and nothing else.
 *    `javascript:`, `data:`, `vbscript:`, `blob:` and every custom scheme are
 *    refused SILENTLY — a refusal message is itself a channel, and the text
 *    stays on screen either way.
 * 2. **A `file:` URI naming a host is refused.** `file://other-machine/etc/hosts`
 *    names a file on ANOTHER computer; opening the local `/etc/hosts` for it
 *    would be a different file wearing the same name. (`localhost` is the one
 *    exception, because the URL parser normalises it to no host at all, which
 *    is what "this machine" is spelled as.)
 * 3. **A `file:` URI on a surface with no local roots is refused entirely.**
 *    A fleet pane is attached to a terminal on another machine; the decision of
 *    record for the epic is that it never resolves a local path. That is passed
 *    in as `allowLocalPaths`, derived from `terminalSurfaceLinkRoots(surface)`
 *    being non-null so the two cannot drift apart.
 * 4. **The decoded path must be absolute, on THIS platform.** A relative
 *    `file:` URI is not a thing we can resolve without a base, and guessing one
 *    opens the wrong file. The Windows spellings — a drive letter
 *    (`file:///C:/x`) and a UNC share (`file:////server/share`) — are honoured
 *    only when this app is running on Windows, because `C:\Users\x` on macOS
 *    is a RELATIVE name containing backslashes, and `//server/share` on macOS
 *    is another machine's path wearing a local spelling.
 * 5. **The path is normalised before it leaves.** The URL parser collapses bare
 *    `.`/`..` segments but not percent-encoded ones, so `%2e%2e%2f` survives
 *    parsing and `decodeURIComponent` puts the traversal back. That is not
 *    cosmetic: `projectRelativePath` is a PREFIX comparison, so an
 *    un-normalised `<workspaceRoot>/../../etc/passwd` reports as inside the
 *    workspace and the menu shows the traversal as the file's name. Normalised
 *    with `terminalFileLinks`' own `normalizePath`, so the OSC 8 route and the
 *    heuristic route agree on what a path is.
 */
export type TerminalOscLinkTarget = { kind: 'file'; path: string } | { kind: 'url'; url: string }

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:'])

/**
 * How a `file:` URI's path is spelled on the machine this renderer is running
 * on, and what counts as absolute there.
 *
 * Optional, defaulting to the real host: the callers that matter are two panes
 * and an OSC 7 handler, and a required field there would be a third place to
 * get the same fact right. Passed explicitly by the tests, which have to drive
 * both platforms from one machine.
 */
export type TerminalOscLinkOptions = {
  allowLocalPaths: boolean
  windowsPaths?: boolean
}

/**
 * Whether this renderer is running on Windows.
 *
 * Read off the preload bridge rather than `navigator`, because that is the
 * value the rest of the renderer already branches on, and read at call time
 * rather than captured, because the module is loaded before the bridge is
 * guaranteed present in every test host. Absent, the answer is "not Windows",
 * which is the fail-closed side: a Windows spelling is then refused rather than
 * handed to `statPath` as a relative name.
 */
function hostUsesWindowsPaths(): boolean {
  try {
    return (globalThis as { api?: { platform?: string } }).api?.platform === 'win32'
  } catch {
    return false
  }
}

/**
 * The target a printed URI resolves to, or `null` when it is refused.
 *
 * Pure and total: every rejection path returns null rather than throwing, so a
 * malformed sequence in the middle of a busy pane can never take the renderer
 * down.
 */
export function resolveTerminalOscLink(uri: string, options: TerminalOscLinkOptions): TerminalOscLinkTarget | null {
  const trimmed = uri.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    // Not a URI at all — including the relative forms, which have no base here.
    return null
  }

  if (ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    return { kind: 'url', url: parsed.toString() }
  }
  if (parsed.protocol !== 'file:') return null

  const path = localPathForFileUrl(parsed, options.windowsPaths ?? hostUsesWindowsPaths())
  if (!path) return null
  // Checked last on purpose: the parse and the host rule are facts about the
  // URI, this is a fact about the pane, and keeping them apart is what lets the
  // fleet rule be read as one line rather than inferred from a parser.
  if (!options.allowLocalPaths) return null
  return { kind: 'file', path }
}

/**
 * The absolute local path a `file:` URL names, or null when it names something
 * this machine cannot honestly claim to hold.
 */
function localPathForFileUrl(parsed: URL, windowsPaths: boolean): string | null {
  // Non-empty host = another machine. `file://localhost/x` never reaches here:
  // the WHATWG URL parser normalises that host away, which is precisely the
  // "this machine" spelling.
  if (parsed.hostname !== '') return null

  let decoded: string
  try {
    decoded = decodeURIComponent(parsed.pathname)
  } catch {
    // A lone `%` or a truncated escape. Refused rather than used raw.
    return null
  }

  // A NUL truncates the path at every syscall below us, so `/safe\0/../etc` and
  // friends never get the chance to mean two things.
  if (!decoded || decoded.includes('\0')) return null

  // `file:///C:/Users/x` decodes to `/C:/Users/x`; Windows wants `C:\Users\x`.
  // Only on Windows: elsewhere `C:\Users\x` is a RELATIVE path whose separators
  // are ordinary filename characters, and rule 4 says the answer is absolute or
  // there is no answer.
  const windowsDrive = /^\/([A-Za-z]:)(?=[\\/]|$)/u.exec(decoded)
  if (windowsDrive) {
    if (!windowsPaths) return null
    const rest = decoded.slice(windowsDrive[0].length).replace(/\//gu, '\\')
    // A bare drive root is the same non-answer as `/` below.
    if (!rest || rest === '\\') return null
    return absoluteOrNull(normalizePath(`${windowsDrive[1]}${rest}`))
  }

  if (!decoded.startsWith('/')) return null
  // `file:////server/share` — a UNC name. On Windows that is `\\server\share`;
  // anywhere else it is a path on SOMEONE ELSE'S machine, which is rule 2 in a
  // different spelling, so it is refused rather than quietly collapsed to
  // `/server/share` by the normaliser below.
  if (decoded.startsWith('//')) {
    if (!windowsPaths) return null
    // Normalised WITHOUT the leading pair — `normalizePath` collapses runs of
    // separators, so a `\\` handed to it comes back as one and the share stops
    // being a share. The `\\` is put back afterwards.
    const body = normalizePath(`\\${decoded.slice(2).replace(/\//gu, '\\')}`)
    // `\\server` alone names a machine, not a file on it — and so does a `..`
    // run that climbed back out of the share.
    return /^\\[^\\]+\\[^\\]/u.test(body) ? `\\${body}` : null
  }

  // `file://` and `file:///` both decode to the filesystem root, which names
  // nothing anyone meant to link. Treating a payload that carried no path as a
  // clickable "open /" turns garbage into an action.
  if (decoded === '/') return null
  return absoluteOrNull(normalizePath(decoded))
}

/**
 * The path back, unless normalising it left nothing but a root.
 *
 * `file:///Users/%2e%2e%2f` normalises to `/`, and `file:///C:/%2e%2e` to
 * `C:\` — the same "carried no path" non-answer the un-normalised forms are
 * refused for, reached the long way round.
 */
function absoluteOrNull(path: string): string | null {
  if (path === '/' || path === '.' || /^[A-Za-z]:\\?$/u.test(path)) return null
  if (path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:\\/u.test(path)) return path
  return null
}

/** What the clicked path turned out to be on disk; mirrors `terminalFileLinks`. */
type TerminalOscLinkPathInfo = { exists: boolean; isDirectory: boolean }

/**
 * Everything a pane decides about an OSC 8 click EXCEPT whether it may resolve
 * a local path — that is the surface's answer, not the pane's, and
 * `createTerminalSurfaceOscLinkHandler` is the only thing that supplies it.
 */
export type TerminalSurfaceOscLinkCallbacks = {
  /** Stats the path so a dead link shows an error, not a menu of failures. */
  inspectPath: (path: string) => Promise<TerminalOscLinkPathInfo>
  /** Opens the chooser for a verified local path (`setLinkMenu`). */
  onActivateFile: (
    input: { resolvedPath: string; isDirectory: boolean },
    anchor: { x: number; y: number },
  ) => void | Promise<void>
  /** Opens the chooser for an http(s) URL, exactly as the web-links path does. */
  onActivateUrl: (url: string, anchor: { x: number; y: number }) => void
  onOpenError?: (message: string, anchor: { x: number; y: number }) => void
}

export type TerminalOscLinkHandlerInput = TerminalSurfaceOscLinkCallbacks & {
  /**
   * Whether this pane may turn a `file:` URI into a local path at all. Derive
   * it from `terminalSurfaceLinkRoots(surface) !== null` — never hardcode it,
   * or the fleet rule stops being enforced by the type that carries it. Use
   * `createTerminalSurfaceOscLinkHandler` and it is derived for you.
   */
  allowLocalPaths: boolean
  /** See `TerminalOscLinkOptions`; the host's own platform when omitted. */
  windowsPaths?: boolean
}

/**
 * The handler for a SURFACE — the only constructor a pane should reach for.
 *
 * `allowLocalPaths` is computed here, from the surface, so it cannot be a
 * literal a pane chose and cannot drift from `terminalSurfaceLinkRoots`. Used
 * by `createStudioTerminal`, which takes the callbacks and builds this itself,
 * so a pane cannot construct a terminal with no gate at all.
 */
export function createTerminalSurfaceOscLinkHandler(
  surface: TerminalSurface,
  callbacks: TerminalSurfaceOscLinkCallbacks,
): ILinkHandler {
  return createTerminalOscLinkHandler({
    allowLocalPaths: terminalSurfaceLinkRoots(surface) !== null,
    ...callbacks,
  })
}

/**
 * xterm's `linkHandler`, which its built-in `OscLinkProvider` reads and which
 * defaults to null — half of why an OSC 8 hyperlink is inert in this app today.
 *
 * `allowNonHttpProtocols` is on because without it xterm drops every `file:`
 * link before this handler is ever consulted, and `file:` is the ONLY thing
 * Claude Code emits an OSC 8 for. The option's own docs warn that enabling it
 * "without proper protection in `activate`" is an XSS risk; the protection is
 * `resolveTerminalOscLink` above, which is why nothing else in `activate`
 * touches the raw text.
 */
export function createTerminalOscLinkHandler({
  allowLocalPaths,
  windowsPaths,
  inspectPath,
  onActivateFile,
  onActivateUrl,
  onOpenError,
}: TerminalOscLinkHandlerInput): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate(event: MouseEvent, text: string, _range: IBufferRange): void {
      const anchor = { x: event.clientX, y: event.clientY }
      const target = resolveTerminalOscLink(text, { allowLocalPaths, windowsPaths })
      if (!target) return

      if (target.kind === 'url') {
        onActivateUrl(target.url, anchor)
        return
      }

      void (async () => {
        try {
          const info = await inspectPath(target.path)
          if (!info.exists) {
            onOpenError?.(`File does not exist: ${target.path}`, anchor)
            return
          }
          await onActivateFile({ resolvedPath: target.path, isDirectory: info.isDirectory }, anchor)
        } catch (error) {
          onOpenError?.(error instanceof Error ? error.message : 'Could not open terminal link.', anchor)
        }
      })()
    },
  }
}

/**
 * The working directory an OSC 7 payload reports, or null when it must not be
 * believed.
 *
 * Same gate as a hyperlink, one rule tighter: OSC 7 is defined as a `file:`
 * URI, so an `http:` payload is not "a link we happen not to want" but a
 * malformed sequence, and a directory that is not absolute is unusable as a
 * resolution base. Feeding this to the file-link provider is what makes a
 * relative path resolve against where the shell actually IS rather than where
 * it was launched — so the same "another machine's path is not ours" rule that
 * governs OSC 8 has to hold here too.
 */
export function parseTerminalOscCwd(data: string, options: TerminalOscLinkOptions): string | null {
  const target = resolveTerminalOscLink(data, options)
  return target?.kind === 'file' ? target.path : null
}
