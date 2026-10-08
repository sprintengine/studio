import { readFile, rm } from 'fs/promises'
import { join } from 'path'
import { errorMessage } from '../shared/errors'

// The hosted relay kept its state in one file in userData: whether it was on,
// the relay URL, this desktop's relay instance id, the phones paired THROUGH THE
// RELAY and their push-notification registrations. The relay was removed (owner
// ruling 2026-09-27) and the phone pairs over the tailnet now, so nothing reads
// that file again — but it still holds device records and push tokens for a
// service this app no longer talks to, and leaving them on disk forever is the
// wrong default for credentials.
//
// Deleted once, at start, and only this file. Tailnet pairings live in their own
// store (`TAILNET_DEVICES_FILENAME`, in tailnet-devices.ts) and are never
// touched here; a phone paired over the tailnet stays paired.
//
// Not silent: a removal that found something is written to the diagnostics log
// with how many relay pairings it held, so "where did my paired phone go" has an
// answer on disk.

export const RETIRED_RELAY_STATE_FILE_NAME = 'mobile-bridge.json'

export type RetiredRelayStateCleanup =
  | { outcome: 'absent' }
  | { outcome: 'removed'; relayPairings: number; pushRegistrations: number }
  | { outcome: 'failed'; message: string }

export async function removeRetiredRelayState(userDataDir: string): Promise<RetiredRelayStateCleanup> {
  const path = join(userDataDir, RETIRED_RELAY_STATE_FILE_NAME)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { outcome: 'absent' }
    return { outcome: 'failed', message: errorMessage(error) }
  }
  const counts = countRecords(raw)
  try {
    await rm(path, { force: true })
  } catch (error) {
    return { outcome: 'failed', message: errorMessage(error) }
  }
  return { outcome: 'removed', ...counts }
}

// Counted for the log line only. A file that no longer parses is still the
// relay's and still removed; it just reports zero of each.
function countRecords(raw: string): { relayPairings: number; pushRegistrations: number } {
  try {
    const parsed = JSON.parse(raw) as { pairedDevices?: unknown; pushRegistrations?: unknown }
    return {
      relayPairings: Array.isArray(parsed.pairedDevices) ? parsed.pairedDevices.length : 0,
      pushRegistrations: Array.isArray(parsed.pushRegistrations) ? parsed.pushRegistrations.length : 0,
    }
  } catch {
    return { relayPairings: 0, pushRegistrations: 0 }
  }
}
