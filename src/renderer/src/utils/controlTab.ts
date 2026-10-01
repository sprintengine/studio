// Contextual Ctrl+Tab routing. A marked scope owns the gesture while focus is
// anywhere inside it; nested scopes win because `closest` starts at focus.

export const CONTROL_TAB_SCOPE_ATTRIBUTE = 'data-control-tab-scope'
export const CONTROL_TAB_ITEM_ATTRIBUTE = 'data-control-tab-item'
export const CONTROL_TAB_CONTEXT_ATTRIBUTE = 'data-control-tab-context'
export const CONTROL_TAB_CONTEXT_ITEM_ATTRIBUTE = 'data-control-tab-context-item'

type ActivatableElement = Element & {
  click?: () => void
  focus?: () => void
  disabled?: boolean
}

function activatorFor(item: Element): ActivatableElement | null {
  if (item.matches('button, [role="tab"], [role="treeitem"]')) return item as ActivatableElement
  return item.querySelector<ActivatableElement>('button, [role="tab"], [role="treeitem"]')
}

function isAvailable(item: Element): boolean {
  const activator = activatorFor(item)
  if (!activator || typeof activator.click !== 'function') return false
  if (activator.disabled === true || activator.getAttribute('aria-disabled') === 'true') return false
  return activator.closest('[hidden], [inert], [aria-hidden="true"]') === null
}

function itemsIn(scope: Element): Element[] {
  const explicit = Array.from(scope.querySelectorAll(`[${CONTROL_TAB_ITEM_ATTRIBUTE}]`)).filter(isAvailable)
  if (explicit.length > 0) return explicit

  const tabs = Array.from(scope.querySelectorAll('[role="tab"]')).filter(isAvailable)
  if (tabs.length > 0) return tabs

  // Conversation rows are navigation rather than ARIA tabs, but they form the
  // same one-active-view sequence when the conversations tree owns focus.
  return Array.from(scope.querySelectorAll('[role="treeitem"][data-row-key]')).filter(isAvailable)
}

function isSelected(item: Element): boolean {
  const activator = activatorFor(item)
  if (!activator) return false
  return activator.getAttribute('aria-selected') === 'true' || activator.getAttribute('aria-current') === 'true'
}

/**
 * Cycle the nearest marked navigation group containing `focused`.
 *
 * Returns false only when focus is outside a group, allowing the caller to fall
 * back to layout tabs. A group with fewer than two destinations still owns and
 * consumes the gesture; focus in one panel must never switch an unrelated one.
 */
export function cycleFocusedControlTabScope(focused: Element | null, step: 1 | -1): boolean {
  if (!focused) return false
  const scope = focused.closest(`[${CONTROL_TAB_SCOPE_ATTRIBUTE}]`)
  if (!scope) return false

  const items = itemsIn(scope)
  if (items.length < 2) return true

  const focusedIndex = items.findIndex((item) => item === focused || item.contains(focused))
  const currentIndex = focusedIndex === -1 ? items.findIndex(isSelected) : focusedIndex
  const nextIndex =
    currentIndex === -1 ? (step === 1 ? 0 : items.length - 1) : (currentIndex + step + items.length) % items.length
  const target = activatorFor(items[nextIndex])
  if (!target || typeof target.click !== 'function') return false

  target.click()
  target.focus?.()
  return true
}

export function controlTabContextOf(focused: Element | null): string | null {
  return focused?.closest(`[${CONTROL_TAB_CONTEXT_ATTRIBUTE}]`)?.getAttribute(CONTROL_TAB_CONTEXT_ATTRIBUTE) ?? null
}

export function controlTabContextItemOf(focused: Element | null): string | null {
  return (
    focused?.closest(`[${CONTROL_TAB_CONTEXT_ITEM_ATTRIBUTE}]`)?.getAttribute(CONTROL_TAB_CONTEXT_ITEM_ATTRIBUTE) ??
    null
  )
}
