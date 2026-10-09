import { pasteIntoComposer } from '../../../utils/clipboardPasteBridge'

// Typing into a chat after clicking somewhere else in it — the transcript, a
// step, a button — lands in the composer, as it would have had the click not
// moved focus. The chat has one place to type; a keystroke that went nowhere
// is a word the person has to type again.
//
// Only what is plainly typing is taken: a printable character with no Command,
// Control or Option held, or a paste. Everything else keeps its meaning where
// it was pressed: Escape stops the turn, arrows and Page keys and Space scroll
// the transcript, the quote shortcut quotes, Command+C copies. Nothing is
// taken from a field that types for itself, from inside a menu, list or
// popover, or while text is selected — a selection is the person about to
// quote or copy, not to type.

const TYPING_ROLES = [
  'menu',
  'menuitem',
  'listbox',
  'option',
  'combobox',
  'tablist',
  'tab',
  'radiogroup',
  'grid',
  'tree',
  'dialog',
]
  .map((role) => `[role="${role}"]`)
  .join(',')

/** Whether an element is, or sits inside, editable content. */
export function isEditableElement(element: Element): boolean {
  const flag = (element as HTMLElement).isContentEditable
  // A DOM without `isContentEditable` (a test's) reads the attribute instead.
  if (typeof flag === 'boolean') return flag
  return Boolean(element.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]'))
}

/** Whether an element takes typing itself. */
export function typesForItself(element: Element | null): boolean {
  if (!element) return false
  if (isEditableElement(element)) return true
  const tag = element.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (element as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'reset', 'submit', 'image', 'file', 'color', 'range'].includes(type)
  }
  // A terminal and the code editor take keys on elements that are neither.
  return Boolean(element.closest('.xterm, .monaco-editor, .cm-editor'))
}

/** The character a keystroke types, when it is plain typing; null otherwise. */
export function typedCharacter(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing?: boolean
  keyCode?: number
}): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  // An input method is composing: the key is its, not a character yet.
  // Chromium reports such a key as `Process`, keyCode 229, before it says so.
  if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return null
  // One character (a surrogate pair counts as one): `Enter`, `Escape` and
  // `ArrowUp` name keys, not text. Space scrolls the transcript it was pressed in.
  if ([...event.key].length !== 1 || event.key === ' ') return null
  return event.key
}

/**
 * Whether a key or paste aimed at `target` inside the chat should go to the
 * composer instead: it was pressed somewhere that does not type, no menu or
 * popover is open, and nothing is selected.
 */
export function shouldRedirectToComposer(target: EventTarget | null, doc: Document = document): boolean {
  // Duck-typed rather than `instanceof Element`: a node from another realm (a
  // pop-out window's document) is an element all the same.
  if (!target || typeof (target as Element).closest !== 'function') return false
  if (typesForItself(target as Element)) return false
  if ((target as Element).closest(TYPING_ROLES)) return false
  // A menu or popover open anywhere is where the person's attention is, even
  // with focus left behind in the transcript.
  if (popupOpen(doc)) return false
  const selection = doc.getSelection()
  if (selection && !selection.isCollapsed && selection.toString().trim()) return false
  return true
}

// What counts as a popup that is up: a menu (always a popup here), a modal
// dialog, or the trigger of any popup saying it is expanded — which covers a
// listbox or a popover. A listbox on its own is not one: the Git and Backlog
// panels keep theirs on the page for good.
const OPEN_POPUP = [
  '[role="menu"]',
  '[role="dialog"][aria-modal="true"]',
  '[aria-haspopup][aria-expanded="true"]',
].join(',')

/** Whether an element is on screen: not in a hidden, inert or parked layer, and drawn. */
function shown(element: Element): boolean {
  // Workspace layers kept warm off screen are `invisible`, `inert` or
  // `aria-hidden`; a pane tab not in front is the same.
  if (element.closest('[hidden], [inert], [aria-hidden="true"], .invisible')) return false
  const check = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility
  return typeof check === 'function' ? check.call(element, { visibilityProperty: true }) : true
}

/** Whether a menu, modal or popover is open and on screen anywhere in the document. */
export function popupOpen(doc: Document): boolean {
  for (const element of doc.querySelectorAll(OPEN_POPUP)) {
    if (element.getAttribute('aria-haspopup') === 'false') continue
    if (shown(element)) return true
  }
  return false
}

/** Hand a paste the chat caught outside the composer to the composer's field, files and all. */
export function forwardPasteToComposer(editable: HTMLElement, data: DataTransfer): boolean {
  const files = Array.from(data.files ?? [])
  const text = data.getData('text/plain')
  if (!files.length) {
    if (!text) return false
    pasteIntoComposer(editable, text)
    return true
  }
  // A screenshot is a paste of files; the field attaches what it is handed.
  const forwarded = new DataTransfer()
  if (text) forwarded.setData('text/plain', text)
  for (const file of files) forwarded.items.add(file)
  editable.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: forwarded }))
  return true
}
