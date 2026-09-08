import type { IBufferRange, ILinkHandler } from '@xterm/xterm'

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
 * 4. **The decoded path must be absolute.** A relative `file:` URI is not a
 *    thing we can resolve without a base, and guessing one opens the wrong file.
 */
export type TerminalOscLinkTarget =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:'])

/**
 * The target a printed URI resolves to, or `null` when it is refused.
 *
 * Pure and total: every rejection path returns null rather than throwing, so a
 * malformed sequence in the middle of a busy pane can never take the renderer
 * down.
 */
export function resolveTerminalOscLink(
  uri: string,
  options: { allowLocalPaths: boolean }
): TerminalOscLinkTarget | null {
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

  const path = localPathForFileUrl(parsed)
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
function localPathForFileUrl(parsed: URL): string | null {
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
  const windowsDrive = /^\/([A-Za-z]:)(?=[\\/]|$)/u.exec(decoded)
  if (windowsDrive) {
    const rest = decoded.slice(windowsDrive[0].length).replace(/\//gu, '\\')
    // A bare drive root is the same non-answer as `/` below.
    return rest && rest !== '\\' ? `${windowsDrive[1]}${rest}` : null
  }

  if (!decoded.startsWith('/')) return null
  // `file://` and `file:///` both decode to the filesystem root, which names
  // nothing anyone meant to link. Treating a payload that carried no path as a
  // clickable "open /" turns garbage into an action.
  if (decoded === '/') return null
  return decoded
}

/** What the clicked path turned out to be on disk; mirrors `terminalFileLinks`. */
type TerminalOscLinkPathInfo = { exists: boolean; isDirectory: boolean }

export type TerminalOscLinkHandlerInput = {
  /**
   * Whether this pane may turn a `file:` URI into a local path at all. Derive
   * it from `terminalSurfaceLinkRoots(surface) !== null` — never hardcode it,
   * or the fleet rule stops being enforced by the type that carries it.
   */
  allowLocalPaths: boolean
  /** Stats the path so a dead link shows an error, not a menu of failures. */
  inspectPath: (path: string) => Promise<TerminalOscLinkPathInfo>
  /** Opens the chooser for a verified local path (`setLinkMenu`). */
  onActivateFile: (
    input: { resolvedPath: string; isDirectory: boolean },
    anchor: { x: number; y: number }
  ) => void | Promise<void>
  /** Opens the chooser for an http(s) URL, exactly as the web-links path does. */
  onActivateUrl: (url: string, anchor: { x: number; y: number }) => void
  onOpenError?: (message: string, anchor: { x: number; y: number }) => void
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
  inspectPath,
  onActivateFile,
  onActivateUrl,
  onOpenError,
}: TerminalOscLinkHandlerInput): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate(event: MouseEvent, text: string, _range: IBufferRange): void {
      const anchor = { x: event.clientX, y: event.clientY }
      const target = resolveTerminalOscLink(text, { allowLocalPaths })
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
          onOpenError?.(
            error instanceof Error ? error.message : 'Could not open terminal link.',
            anchor,
          )
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
export function parseTerminalOscCwd(
  data: string,
  options: { allowLocalPaths: boolean }
): string | null {
  const target = resolveTerminalOscLink(data, options)
  return target?.kind === 'file' ? target.path : null
}
