import { useNotificationStore } from '../store/notificationStore'
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../types/workspace'

function fallbackEntry(input: DiagnosticLogInput): DiagnosticLogEntry {
  return {
    ...input,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

export async function publishDiagnostic(input: DiagnosticLogInput): Promise<DiagnosticLogEntry> {
  let entry: DiagnosticLogEntry

  try {
    entry = await window.api.logDiagnostic(input)
  } catch {
    entry = fallbackEntry(input)
  }

  useNotificationStore.getState().addNotification(entry)
  return entry
}

export function publishDiagnosticSync(input: DiagnosticLogInput): void {
  void publishDiagnostic(input)
}
