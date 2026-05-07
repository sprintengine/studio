import { randomUUID } from 'crypto'
import type {
  MobileBridgeDiagnosticEntry,
  MobileBridgeState,
} from './mobile-bridge'
import { getAllBrowserWindows } from './mobile-bridge-desktop'

const MAX_DIAGNOSTICS = 50

export function recordMobileBridgeDiagnostic(
  diagnostics: MobileBridgeDiagnosticEntry[],
  level: MobileBridgeDiagnosticEntry['level'],
  code: MobileBridgeDiagnosticEntry['code'],
  message: string,
  retryable: boolean
): MobileBridgeDiagnosticEntry[] {
  const previous = diagnostics[0]
  if (previous?.code === code && previous.message === message) return diagnostics

  return [{
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    code,
    message,
    retryable,
  }, ...diagnostics].slice(0, MAX_DIAGNOSTICS)
}

export function emitMobileBridgeStateChanged(state: MobileBridgeState): void {
  for (const win of getAllBrowserWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('mobile-bridge:state-changed', state)
    }
  }
}
