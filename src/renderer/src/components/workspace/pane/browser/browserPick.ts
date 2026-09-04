import type { BrowserPickTheme, BrowserPickedElement } from '../../../../../../shared/browser'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { focusedAgentTabInLayout } from '../../../../utils/modelRegistry'
import { bracketedPaste } from '../../../../utils/terminalDrop'

// What an element pick becomes for an agent (browser-pane epic, decision 8):
// a `<browser_element>` block with the page URL, a stable selector, the React
// component and source when the page exposes them, the element's HTML and the
// styles that decide how it looks — parked at the focused agent terminal's
// prompt, unsubmitted, the way a dragged skill is. Pure, so it is testable.

export function buildBrowserElementBlock(picked: BrowserPickedElement, screenshotPath: string | null): string {
  const attributes = [
    `url="${escapeAttribute(picked.url)}"`,
    `selector="${escapeAttribute(picked.selector)}"`,
    picked.components.length > 0 ? `component="${escapeAttribute(picked.components.join(' < '))}"` : null,
    picked.source ? `source="${escapeAttribute(picked.source)}"` : null,
  ].filter((part): part is string => part !== null)
  const styles = Object.entries(picked.styles)
    .map(([key, value]) => `${key}:${value}`)
    .join('; ')
  const lines = [
    `<browser_element ${attributes.join(' ')}>`,
    `<html>${picked.outerHtml}</html>`,
    styles ? `<styles>${styles}</styles>` : null,
    '</browser_element>',
    screenshotPath ? `Screenshot: ${screenshotPath}` : null,
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, ' ')
}

export type SendToAgentResult = { ok: true } | { ok: false; reason: 'no_agent' | 'no_session' | 'write_failed' }

/**
 * Park text at the focused agent's prompt, unsubmitted: the agent the
 * workspace's layout says is on screen, through its live pty. Nothing is
 * submitted — a bracketed paste is text at the prompt, not a keypress.
 */
export async function sendTextToFocusedAgent(workspaceId: string, text: string): Promise<SendToAgentResult> {
  const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
  const focused = focusedAgentTabInLayout(workspace?.layoutModel)
  if (!focused) return { ok: false, reason: 'no_agent' }
  let sessionId = focused.sessionId
  try {
    const sessions = await window.api.terminalList()
    const live = sessions.find(
      (session) =>
        session.kind === 'agent'
        && session.processAlive
        && (session.sessionId === sessionId || (session.workspaceId === workspaceId && session.agentId === focused.agentId)),
    )
    if (!live) return { ok: false, reason: 'no_session' }
    sessionId = live.sessionId
    await window.api.terminalWrite(sessionId, bracketedPaste(`${text}\n`))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

/** The picker overlay's colours, read from the app's live tokens. */
export function readPickTheme(): BrowserPickTheme {
  const style = getComputedStyle(document.documentElement)
  // Fallbacks are CSS system colours, never literals of our own: a token that
  // failed to resolve is the theme's problem, not a second palette.
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    accent: read('--accent-primary', 'Highlight'),
    accentSoft: read('--accent-primary-soft', 'transparent'),
    chipBackground: read('--bg-surface-raised', 'Canvas'),
    chipBorder: read('--border-strong', 'GrayText'),
    chipText: read('--text-strong', 'CanvasText'),
  }
}
