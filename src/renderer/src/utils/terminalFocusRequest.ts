// Asks a specific mounted terminal to take the keyboard.
//
// `focusTerminal` lives inside TerminalView/PlainTerminalPanel's mount effect,
// closed over the xterm instance, so nothing outside those components can focus
// a terminal. The editor already solved the same problem with a window event
// (`multicode:focus-editor`, EditorPanel.tsx); this is that pattern for
// terminals, addressed by workspace + agent/terminal id so exactly one pane
// answers.
//
// Dispatch is synchronous, so `handled` comes back filled in — the caller learns
// whether any terminal was actually listening. That matters because AgentPanel
// lazy-loads TerminalView: a request sent the instant a workspace opens can
// arrive before the chunk has resolved, and the caller needs to know to retry.

export const TERMINAL_FOCUS_EVENT = 'multicode:focus-terminal'

/** Who to focus. `agentId` addresses an agent pane, `terminalId` a plain terminal. */
export type TerminalFocusTarget = {
  workspaceId: string
  agentId?: string | null
  terminalId?: string | null
}

export type TerminalFocusRequestDetail = TerminalFocusTarget & { handled: boolean }

/** How a mounted pane identifies itself when deciding whether a request is for it. */
export type TerminalFocusIdentity = {
  workspaceId: string
  agentId?: string | null
  terminalId?: string | null
}

/**
 * Whether `request` addresses `identity`. Pure so the matching rules are testable
 * without mounting an xterm.
 *
 * A request must name the workspace and exactly one of the two id kinds; the pane
 * matches only on the kind it has. An agent pane never answers a terminal request
 * (and vice versa) even if the ids happen to collide across the two id spaces.
 */
export function terminalFocusRequestMatches(
  request: TerminalFocusTarget,
  identity: TerminalFocusIdentity,
): boolean {
  if (request.workspaceId !== identity.workspaceId) return false
  if (request.agentId) return Boolean(identity.agentId) && request.agentId === identity.agentId
  if (request.terminalId) return Boolean(identity.terminalId) && request.terminalId === identity.terminalId
  return false
}

/**
 * How long to keep re-asking after a workspace opens. AgentPanel lazy-loads
 * TerminalView, so the first request usually lands before any terminal exists;
 * these give the chunk time to resolve without the retry outliving the gesture
 * that opened the workspace.
 */
export const TERMINAL_FOCUS_RETRY_DELAYS_MS = [60, 160, 360, 700] as const

/**
 * Whether taking focus now would interrupt the user mid-typing.
 *
 * An xterm's own helper textarea does NOT count: it is the thing we may be
 * correcting (a hidden pane's mount-time focus grabbing the keyboard), and a
 * request only ever redirects to the visible terminal of the same workspace.
 */
export function focusRequestWouldInterrupt(active: Element | null): boolean {
  if (!active) return false
  if (active.closest('.xterm')) return false
  const tag = active.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  // Duck-typed rather than `instanceof HTMLElement` so the rule stays a pure
  // function of the node and can be tested without a DOM.
  return (active as Partial<HTMLElement>).isContentEditable === true
}

/** Dispatches a focus request; returns true when a mounted terminal took it. */
export function requestTerminalFocus(target: TerminalFocusTarget): boolean {
  if (typeof window === 'undefined') return false
  const detail: TerminalFocusRequestDetail = { ...target, handled: false }
  window.dispatchEvent(new CustomEvent(TERMINAL_FOCUS_EVENT, { detail }))
  return detail.handled
}

/**
 * Subscribes a mounted terminal pane. `focus` runs only for requests naming it,
 * and marking the request handled is what stops the caller retrying.
 */
export function onTerminalFocusRequest(
  identity: TerminalFocusIdentity,
  focus: () => void,
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<TerminalFocusRequestDetail>).detail
    if (!detail || !terminalFocusRequestMatches(detail, identity)) return
    detail.handled = true
    focus()
  }
  window.addEventListener(TERMINAL_FOCUS_EVENT, listener)
  return () => window.removeEventListener(TERMINAL_FOCUS_EVENT, listener)
}
