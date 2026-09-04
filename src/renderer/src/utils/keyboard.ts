// Shared keyboard-handling helpers. Extracted per the brand panel-design
// system note: keyboard guards used by three or more panels graduate from
// per-panel duplicates to a shared util.

/**
 * Returns true when the target is an editable element where keyboard
 * shortcuts should NOT fire (text inputs, textareas, selects, or
 * contentEditable nodes). Pattern is identical across every panel that
 * wires a `j`/`k`/arrow handler at the section level — the guard prevents
 * shortcuts from stealing focus while the user is typing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

export function isGlobalShortcutSuppressedTarget(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (isEditableTarget(target)) return true
  if (target.closest('.monaco-editor')) return true
  if (target.closest('.xterm')) return true
  // A surface that owns its own chords (the model picker's ⌘1–9 jumps) marks
  // itself so the shell treats focus inside it like an editable target: only
  // commands that allow editable targets still fire there.
  if (target.closest('[data-suppress-shortcuts]')) return true
  return false
}
