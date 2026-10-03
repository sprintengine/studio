/**
 * Which input moved focus last: the pointer or the keyboard. It decides whether
 * the focus ring is drawn at all (owner ruling 2026-10-03), through
 * `data-focus-source` on the root, which assets/index.css reads to switch
 * `--focus-ring` off while the pointer was last.
 *
 * `:focus-visible` is not enough to make that call. Chromium matches it on a
 * click into a text field, a `:focus-within` container matches on any click,
 * and a programmatic `.focus()` inherits focus-visible from whatever key was
 * pressed last, typing included. Each of those drew a ring around something the
 * person had just clicked.
 *
 * What counts as the keyboard is narrower than "a key was pressed": only the keys
 * that move focus or a cursor between controls. Typing a message is not
 * navigating, and an arrow or Tab that the field it was pressed in consumes —
 * a caret moving in the composer, a shell completing in a terminal, an indent in
 * the editor — moves nothing, so it does not count either.
 */
export type FocusSource = 'pointer' | 'keyboard'

const NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

// The input types that take a caret, where an arrow moves the caret rather than
// focus. A checkbox, radio or range is a control the arrows navigate.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''])

// Surfaces that keep Tab for themselves: a terminal sends it to the shell and the
// code editor indents with it, so focus stays put.
const TAB_CONSUMERS = '.xterm, .monaco-editor'

function isTextEntry(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type)
  return target instanceof HTMLElement && target.isContentEditable
}

function keepsTab(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && target.closest(TAB_CONSUMERS) !== null
}

/** The source a key press reports, or null for a key that moves no focus. */
export function focusSourceForKey(
  event: Pick<KeyboardEvent, 'key' | 'target' | 'metaKey' | 'ctrlKey' | 'altKey'>,
): FocusSource | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.key === 'Tab') return keepsTab(event.target) ? null : 'keyboard'
  if (NAVIGATION_KEYS.has(event.key)) return isTextEntry(event.target) ? null : 'keyboard'
  return null
}

type FocusSourceWindow = {
  addEventListener(type: 'pointerdown' | 'keydown', listener: (event: Event) => void, capture: boolean): void
  removeEventListener(type: 'pointerdown' | 'keydown', listener: (event: Event) => void, capture: boolean): void
}

/**
 * Stamp `data-focus-source` on the root and keep it current. Starts at
 * `pointer`, so a window that has seen no input draws no ring. Capture phase,
 * because a list that handles its own arrows stops them from bubbling.
 * Returns the unbind.
 */
export function bindFocusSourceAttribute(
  root: { dataset: DOMStringMap } = document.documentElement,
  win: FocusSourceWindow = window,
): () => void {
  const apply = (source: FocusSource): void => {
    if (root.dataset['focusSource'] !== source) root.dataset['focusSource'] = source
  }
  const onPointerDown = (): void => apply('pointer')
  const onKeyDown = (event: Event): void => {
    const source = focusSourceForKey(event as KeyboardEvent)
    if (source) apply(source)
  }
  apply('pointer')
  win.addEventListener('pointerdown', onPointerDown, true)
  win.addEventListener('keydown', onKeyDown, true)
  return () => {
    win.removeEventListener('pointerdown', onPointerDown, true)
    win.removeEventListener('keydown', onKeyDown, true)
  }
}
