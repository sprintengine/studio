import { Base64, ClipboardAddon } from '@xterm/addon-clipboard'
import type { IClipboardProvider } from '@xterm/addon-clipboard'
import type { IDisposable, Terminal } from '@xterm/xterm'

import { writeTerminalClipboardText } from './terminalClipboard'

/**
 * OSC 52 — a program asks the terminal to touch the system clipboard.
 *
 * `ESC ] 52 ; <selection> ; <base64> ST` writes; `ESC ] 52 ; <selection> ; ? ST`
 * asks the terminal to READ the clipboard and type it back at the program.
 *
 * **Write is on. Read is off, and this file is where that is enforced.** It is a
 * decision of record for the terminal-emulation-parity epic, not a default:
 * anything that can print to a pane can print a read request, and in this app
 * that includes every agent CLI and every file an agent `cat`s. Answering one
 * hands the user's whole clipboard — passwords, tokens, whatever they last
 * copied — to the process on the other end of the pty, with nothing on screen.
 *
 * `@xterm/addon-clipboard` answers read requests BY DEFAULT: its
 * `BrowserClipboardProvider.readText()` calls `navigator.clipboard.readText()`,
 * and the addon then does `terminal.input('\x1b]52;<sel>;<base64>\x07')`, which
 * is a write into the pty. Loading the addon as shipped would be the exfil
 * channel. So read is refused twice over, on the principle that one of the two
 * can be deleted by a later edit without the other noticing:
 *
 * 1. `createOsc52ReadGuard()` is registered on OSC 52 AFTER the addon. xterm
 *    runs OSC handlers in reverse registration order and stops at the first one
 *    that returns true, so the guard sees every OSC 52 first, swallows the read
 *    requests, and passes writes down to the addon by returning false. Nothing
 *    is emitted for a read — not even an empty reply.
 * 2. `createWriteOnlyClipboardProvider()` is the provider the addon is built
 *    with, and its `readText` is unreachable-by-design: it returns the empty
 *    string rather than the clipboard, and never throws (an exception here
 *    would escape through xterm's parser into the middle of a `write()`).
 *
 * Writes go through `terminalClipboard.ts`, i.e. Electron's clipboard over IPC,
 * NOT `navigator.clipboard.writeText` — the browser API needs document focus
 * and a user gesture, and a CLI copying while the user is in another window is
 * exactly the case that would silently fail.
 */
export const TERMINAL_OSC52_IDENTIFIER = 52

/**
 * Whether an OSC 52 payload is a clipboard READ request.
 *
 * The payload is `<selection>;<data>`; `?` in the data position is the read.
 * A single-field payload (`52;?`) is malformed rather than a read — the addon
 * ignores it, and so does this. `?` is not a base64 character, so a write can
 * never be mistaken for a read.
 */
export function isTerminalOsc52ReadRequest(data: string): boolean {
  const fields = data.split(';')
  return fields.length >= 2 && fields[1] === '?'
}

/**
 * The OSC 52 handler that refuses reads.
 *
 * Returns true (handled, nothing emitted) for a read request and false for
 * everything else, which is how the write path reaches the addon registered
 * beneath it.
 */
export function createOsc52ReadGuard(): (data: string) => boolean {
  return (data) => isTerminalOsc52ReadRequest(data)
}

/**
 * The clipboard the addon is allowed to touch: write through, read never.
 *
 * `readText` is part of `IClipboardProvider` and cannot be omitted. It returns
 * '' rather than throwing so that a hypothetical route past the guard degrades
 * to "the clipboard looked empty" instead of tearing a parser exception through
 * an in-flight `terminal.write()`.
 */
export function createWriteOnlyClipboardProvider(
  writeText: (text: string) => void | Promise<void> = (text) => writeTerminalClipboardText(text).then(() => {}),
): IClipboardProvider {
  return {
    readText: () => '',
    writeText: (_selection, text) => writeText(text),
  }
}

export type AttachTerminalOsc52ClipboardInput = {
  terminal: Pick<Terminal, 'loadAddon'> & { parser: Pick<Terminal['parser'], 'registerOscHandler'> }
  /** Overridable for tests; defaults to the app clipboard via `terminalClipboard.ts`. */
  writeText?: (text: string) => void | Promise<void>
}

/**
 * Loads the clipboard addon write-only and arms the read guard in front of it.
 *
 * ORDER IS THE WHOLE MECHANISM: the guard is registered second so it runs
 * first. Swapping these two lines re-enables clipboard exfiltration.
 */
export function attachTerminalOsc52Clipboard({
  terminal,
  writeText,
}: AttachTerminalOsc52ClipboardInput): IDisposable {
  const addon = new ClipboardAddon(new Base64(), createWriteOnlyClipboardProvider(writeText))
  terminal.loadAddon(addon)
  const guard = terminal.parser.registerOscHandler(TERMINAL_OSC52_IDENTIFIER, createOsc52ReadGuard())
  return {
    dispose: () => {
      guard.dispose()
      addon.dispose()
    },
  }
}
