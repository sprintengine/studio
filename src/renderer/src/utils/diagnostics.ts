import { useNotificationStore } from '../store/notificationStore'
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../types/workspace'

const DIAGNOSTIC_LOG_TIMEOUT_MS = 2000

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
