import type { KeybindingPlatform } from './keybindings'

// A code surface owns its keys: Monaco and a terminal bind ⌘⇧S (Save As), and a surface marked `data-suppress-shortcuts` keeps its own
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
 *
 * A chord the shell does not take goes on to the surface it was pressed in.
 */
export function shellTakesChordFrom(
  commandId: string,
  target: EventTarget | null | undefined,
  _platform: KeybindingPlatform,
): boolean {
  if (commandId === 'chat.settle') return !isCodeSurfaceTarget(target)
  return true
}
