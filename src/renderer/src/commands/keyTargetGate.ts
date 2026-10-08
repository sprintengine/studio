import { isGlobalShortcutSuppressedTarget } from '../utils/keyboard'
import type { KeybindingPlatform } from './keybindings'

// A code surface owns its keys: Monaco and a terminal bind ⌘⇧S (Save As) and
// may bind ⌘T, and a surface marked `data-suppress-shortcuts` keeps its own
// chords. Duck-typed, like `isTerminalKeyTarget`, so it reads a bare target.
export function isCodeSurfaceTarget(target: EventTarget | null | undefined): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null | undefined
  if (!element || typeof element.closest !== 'function') return false
  return element.closest('.monaco-editor, .xterm, [data-terminal-surface], [data-suppress-shortcuts]') != null
}

/**
 * Whether a shell command's chord is the shell's to take from where it was
 * pressed. Most commands are settled by `allowInEditableTarget` alone; these
 * reach into text fields (the composer) but not every editable surface:
 *
 * - `chat.settle` (⌘⇧S) is reached for from the composer as a chat is
 *   finished with, but in an editor or a terminal ⌘⇧S is Save As, and a press
 *   meant for that must not settle the chat.
 * - `pane.add` (⌘T) takes a text field on macOS, where ⌘T means nothing to
 *   one. Off macOS it is Ctrl+T, a text field's and a shell's transpose, so it
 *   is left to them there.
 *
 * A chord the shell does not take goes on to the surface it was pressed in.
 */
export function shellTakesChordFrom(
  commandId: string,
  target: EventTarget | null | undefined,
  platform: KeybindingPlatform,
): boolean {
  if (commandId === 'chat.settle') return !isCodeSurfaceTarget(target)
  if (commandId === 'pane.add') {
    if (isCodeSurfaceTarget(target)) return false
    return platform === 'darwin' || !isGlobalShortcutSuppressedTarget(target)
  }
  return true
}
