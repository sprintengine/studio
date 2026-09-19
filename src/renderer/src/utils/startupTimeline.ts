import type { StartupMarkId } from '../../../shared/startup-timeline'

// Renderer side of the boot measurement (MC-2075). Reports its phases to main,
// which owns the clock origin and prints the assembled read-out.
//
// Marks are reported as EPOCH ms (`performance.timeOrigin + performance.now()`)
// because this document's `now()` origin is its own navigation start, not the
// main process's start.

// Only the primary workspace window is measured. The diagnostics and aux windows
// load this same bundle but are opened by user action long after boot — their
// marks would be answering for a boot that already finished. Resolved from the
// URL rather than passed in, so no call site has to remember the rule.
let primaryWindow: boolean | null = null
function isPrimaryWorkspaceWindow(): boolean {
  if (primaryWindow === null) {
    const params = new URLSearchParams(window.location.search)
    primaryWindow = params.get('view') !== 'diagnostics' && !params.get('aux')
  }
  return primaryWindow
}

function reportingEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.api?.startupTimelineEnabled === true &&
    typeof window.api.reportStartupMark === 'function' &&
    isPrimaryWorkspaceWindow()
  )
}

export function markStartup(id: StartupMarkId): void {
  if (!reportingEnabled()) return
  markStartupAt(id, performance.timeOrigin + performance.now())
}

// For a phase whose time is not "now" — the document's navigation start, which
// happened before any of this bundle existed.
export function markStartupAt(id: StartupMarkId, atEpochMs: number): void {
  if (!reportingEnabled()) return
  try {
    performance.mark(id)
  } catch {
    // The user-timing buffer is a convenience; main's timeline is the record.
  }
  window.api.reportStartupMark(id, atEpochMs)
}
