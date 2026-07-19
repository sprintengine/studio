import { useNotificationStore } from '../store/notificationStore'
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../types/workspace'

const DIAGNOSTIC_LOG_TIMEOUT_MS = 2000

// Collapse a burst of identical diagnostics into one. A runaway emit loop (a
// mount effect that respawns + re-notifies every tick) otherwise produces
// hundreds of toasts a second. The signature deliberately EXCLUDES `details`:
// per-attempt fields like the session id live there and change every iteration,
// so keying on them would defeat the dedup entirely — the stable identity of a
// repeated failure is its level/source/agent/title/message.
const DIAGNOSTIC_DEDUP_WINDOW_MS = 3000
const recentDiagnosticSignatures = new Map<string, number>()

function diagnosticSignature(input: DiagnosticLogInput): string {
  return [input.level, input.source, input.agentId ?? '', input.title, input.message].join(' ')
}

function shouldSuppressDuplicate(input: DiagnosticLogInput, now: number): boolean {
  const signature = diagnosticSignature(input)
  const lastAt = recentDiagnosticSignatures.get(signature)
  recentDiagnosticSignatures.set(signature, now)
  // Opportunistic prune so the map can't grow unbounded across a long session.
  if (recentDiagnosticSignatures.size > 256) {
    for (const [key, at] of recentDiagnosticSignatures) {
      if (now - at > DIAGNOSTIC_DEDUP_WINDOW_MS) recentDiagnosticSignatures.delete(key)
    }
  }
  return lastAt !== undefined && now - lastAt < DIAGNOSTIC_DEDUP_WINDOW_MS
}

function fallbackEntry(input: DiagnosticLogInput): DiagnosticLogEntry {
  return {
    ...input,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function withDiagnosticTimeout(
  promise: Promise<DiagnosticLogEntry>,
  input: DiagnosticLogInput
): Promise<DiagnosticLogEntry> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<DiagnosticLogEntry>((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackEntry(input)), DIAGNOSTIC_LOG_TIMEOUT_MS)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

export async function publishDiagnostic(input: DiagnosticLogInput): Promise<DiagnosticLogEntry> {
  // Suppress a rapid-fire duplicate before it reaches disk or the toast store.
  // The first occurrence always goes through; identical repeats inside the window
  // are dropped so a stuck loop surfaces one notification, not a flood.
  if (shouldSuppressDuplicate(input, Date.now())) {
    return fallbackEntry(input)
  }

  let entry: DiagnosticLogEntry

  try {
    entry = await withDiagnosticTimeout(window.api.logDiagnostic(input), input)
  } catch {
    entry = fallbackEntry(input)
  }

  useNotificationStore.getState().addNotification(entry)
  return entry
}

export function publishDiagnosticSync(input: DiagnosticLogInput): void {
  void publishDiagnostic(input)
}
