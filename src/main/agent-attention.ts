import type { AgentPhaseEvent } from '../shared/agent-runtime'

// =============================================================================
// Agent attention — how a background agent asks for the person without taking
// the screen from them.
//
// An agent finishing a turn, or stopping to ask a question, is something the
// person wants to know about; it is not a reason to put the app in front of the
// editor or the browser they are typing into. So attention goes where the OS
// keeps it for exactly this: the taskbar button flashes on Windows, the dock
// icon bounces once on macOS, and the dock or launcher badge counts the agents
// waiting on macOS and Linux. Nothing here shows, restores, raises or focuses a
// window — bringing the app forward stays an explicit act of the person's
// (a click on the taskbar, the tray, a notification).
//
// The count is of agents that asked since the person last looked: it clears
// when any app window takes focus, and an agent that went back to work on its
// own (answered from the phone, say) stops counting.
//
// Electron is injected, so the rules run headless under test.
// =============================================================================

/** The slice of a BrowserWindow attention touches. Never `focus`/`show`. */
export type AttentionWindow = {
  isDestroyed(): boolean
  isFocused(): boolean
  flashFrame(flag: boolean): void
}

export type AgentAttentionDeps = {
  platform: string
  /** Windows the person uses — never the hidden canvas worker. */
  listWindows(): readonly AttentionWindow[]
  /** macOS dock bounce. `informational` bounces once rather than until focus. */
  bounceDock?(): void
  /** Dock (macOS) or launcher (Linux) badge; 0 clears it. */
  setBadgeCount?(count: number): void
}

export type AgentAttention = {
  onAgentPhase(event: AgentPhaseEvent): void
  /** A window of the app took focus: the person is looking, so stand down. */
  onWindowFocused(): void
  /** How many agents are waiting on the person. Exposed for tests. */
  pendingCount(): number
}

const WORKING_PHASES = new Set<AgentPhaseEvent['phase']>(['starting', 'thinking', 'tool_use'])

/**
 * Whether this transition is one the person would want to hear about: the
 * agent stopped to ask, or its turn ended. Subagent stops and the tool churn
 * inside a turn are not — they arrive many times a minute.
 */
export function isAttentionEvent(event: AgentPhaseEvent): boolean {
  if (event.phase === 'awaiting_input') return event.previousPhase !== 'awaiting_input'
  return event.turnEnd
}

export function createAgentAttention(deps: AgentAttentionDeps): AgentAttention {
  const pending = new Set<string>()
  const badgeSupported = deps.platform === 'darwin' || deps.platform === 'linux'

  function liveWindows(): AttentionWindow[] {
    return deps.listWindows().filter((win) => !win.isDestroyed())
  }

  function publishBadge(): void {
    if (!badgeSupported) return
    try {
      deps.setBadgeCount?.(pending.size)
    } catch {
      // A launcher without badge support is not worth a crash.
    }
  }

  function flash(flag: boolean): void {
    if (deps.platform !== 'win32') return
    for (const win of liveWindows()) win.flashFrame(flag)
  }

  function onAgentPhase(event: AgentPhaseEvent): void {
    if (WORKING_PHASES.has(event.phase)) {
      if (pending.delete(event.agentId)) {
        publishBadge()
        if (pending.size === 0) flash(false)
      }
      return
    }
    if (!isAttentionEvent(event)) return
    const windows = liveWindows()
    // The person is already looking at the app, and the sidebar shows the
    // agent's state; a badge they would have to clear by hand is noise.
    if (windows.some((win) => win.isFocused())) return
    pending.add(event.agentId)
    publishBadge()
    if (deps.platform === 'win32') {
      for (const win of windows) win.flashFrame(true)
    } else if (deps.platform === 'darwin') {
      deps.bounceDock?.()
    }
  }

  function onWindowFocused(): void {
    const hadPending = pending.size > 0
    pending.clear()
    if (hadPending) publishBadge()
    flash(false)
  }

  return { onAgentPhase, onWindowFocused, pendingCount: () => pending.size }
}

/**
 * Whether a second launch of the app was a script run through its binary
 * rather than a person opening the app.
 *
 * The agent-state hook and the MCP bridge run this app's executable as Node
 * (`ELECTRON_RUN_AS_NODE`). When that variable is lost on the way — a WSL
 * shell forwards only what `WSLENV` names, and a hook written by an older
 * build is still in the workspace — the binary starts as the app, loses the
 * single-instance lock, and reaches the running app as a second launch. A
 * person relaunching the app wants the window; a hook does not, and it fires
 * on every tool call. Every script the app runs this way is an `.mjs` file (the
 * reporter, the status line, the bridge) and a person never opens the app with
 * one, so that — or the reporter's `--socket` flag — is the tell. A dev build's
 * own `.js` entry point is deliberately not matched.
 */
export function isScriptSecondLaunch(argv: readonly string[]): boolean {
  return argv.slice(1).some((arg) => arg === '--socket' || /\.mjs$/iu.test(arg.replace(/["']/gu, '')))
}
