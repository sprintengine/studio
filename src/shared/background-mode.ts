/**
 * Background mode (MC-2156): the app keeps running after its last window
 * closes, and says so from the tray.
 *
 * This module is the pure half — the status shape main assembles and the exact
 * lines the tray renders from it. Kept here (no Electron, no fs) because the
 * honesty rules for those lines are the feature: a tray that says "running"
 * while the gateway is down is the failure this presence exists to prevent.
 * Every counter below comes from a live main-process reader; there is no
 * placeholder branch.
 *
 * The Electron wiring lives in `src/main/background-presence.ts`; the persisted
 * setting in `src/main/background-mode-store.ts`.
 */

/** What the app can honestly report about itself with no window open. */
export type BackgroundStatus = {
  /** Live agent PTYs (process alive, not suspended). */
  agentSessions: number
  /** The Studio MCP gateway every agent's tool calls travel through. */
  gateway: { running: boolean }
}

export type BackgroundTrayItemId =
  | 'header'
  | 'sessions'
  | 'gateway'
  | 'separator'
  | 'open'
  | 'quit'

export type BackgroundTrayItem = {
  id: BackgroundTrayItemId
  /** Absent for a separator. */
  label?: string
  /**
   * `info` items are status readouts and are rendered disabled — the tray is a
   * report plus two actions, never a control surface for the run itself.
   */
  kind: 'info' | 'action' | 'separator'
}

/**
 * Dispatch for the two actionable items. Kept here, beside the item list that
 * names them, so the id→action mapping is testable without Electron — the
 * menu adapter only knows how to render and click.
 */
export function runBackgroundTrayAction(
  id: BackgroundTrayItemId,
  actions: { open(): void; quit(): void },
): void {
  if (id === 'open') actions.open()
  if (id === 'quit') actions.quit()
}

export function emptyBackgroundStatus(): BackgroundStatus {
  return { agentSessions: 0, gateway: { running: false } }
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

export function describeBackgroundSessions(status: BackgroundStatus): string {
  if (status.agentSessions === 0) return 'No agent sessions running'
  return `${plural(status.agentSessions, 'agent session')} running`
}

export function describeBackgroundGateway(status: BackgroundStatus): string {
  return status.gateway.running ? 'Studio gateway listening' : 'Studio gateway not listening'
}

/**
 * The tray tooltip. One line: Windows truncates multi-line tooltips and macOS
 * shows none at all for a menu-bar item, so the counters that matter go first.
 */
export function describeBackgroundTooltip(status: BackgroundStatus): string {
  return `Multicode — running in the background · ${describeBackgroundSessions(status)} · ${describeBackgroundGateway(status)}`
}

/**
 * The tray menu, top to bottom. Status lines first (disabled), then the two
 * actions the backlog names: open a window, and quit for real.
 */
export function buildBackgroundTrayItems(status: BackgroundStatus): BackgroundTrayItem[] {
  const items: BackgroundTrayItem[] = [
    { id: 'header', label: 'Multicode is running in the background', kind: 'info' },
  ]
  items.push({ id: 'sessions', label: describeBackgroundSessions(status), kind: 'info' })
  items.push({ id: 'gateway', label: describeBackgroundGateway(status), kind: 'info' })
  items.push({ id: 'separator', kind: 'separator' })
  items.push({ id: 'open', label: 'Open Multicode', kind: 'action' })
  items.push({ id: 'quit', label: 'Quit Multicode', kind: 'action' })
  return items
}
