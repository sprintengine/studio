import type { IpcMain } from 'electron'

import type {
  CredentialSecretClearResult,
  CredentialSecretSetResult,
  CredentialSecretStatusResult,
} from '../../shared/electron-api'
import { getSharedCredentialStore } from '../secret-store'

// The slice of the credential store this IPC needs. Injectable so tests can
// drive the handlers without the real Electron-backed singleton.
export type CredentialIpcStore = {
  getStatus(id: string): Promise<CredentialSecretStatusResult>
  setSecret(id: string, value: string): Promise<CredentialSecretSetResult>
  clearSecret(id: string): Promise<CredentialSecretClearResult>
}

// Generic credential IPC: the single shared credential store surfaced for any
// owner kind (CLI plugins AND conversation providers). Inputs carry a manifest
// `id`; the store resolves the matching `auth` descriptor across all manifest
// kinds. The plaintext value only flows in on `set`; status/clear are id-only,
// and no decrypted value ever crosses back to the renderer.

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error.'
}

type IdParse = { ok: true; id: string } | { ok: false; message: string }

function parseId(input: unknown): IdParse {
  if (typeof input !== 'object' || input === null) return { ok: false, message: 'Invalid request.' }
  const id = (input as { id?: unknown }).id
  if (typeof id !== 'string' || id.trim().length === 0) return { ok: false, message: 'Credential id is required.' }
  return { ok: true, id: id.trim() }
}

type SetParse = { ok: true; id: string; value: string } | { ok: false; message: string }

function parseSet(input: unknown): SetParse {
  const base = parseId(input)
  if (!base.ok) return base
  const value = (input as { value?: unknown }).value
  if (typeof value !== 'string') return { ok: false, message: 'Credential value is required.' }
  return { ok: true, id: base.id, value }
}

export function registerCredentialIpc(ipcMain: IpcMain, store: CredentialIpcStore = getSharedCredentialStore()): void {

  ipcMain.handle('credential:secrets:status', async (_, input: unknown): Promise<CredentialSecretStatusResult> => {
    const parsed = parseId(input)
    if (!parsed.ok) return parsed
    try {
      return await store.getStatus(parsed.id)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('credential:secrets:set', async (_, input: unknown): Promise<CredentialSecretSetResult> => {
    const parsed = parseSet(input)
    if (!parsed.ok) return parsed
    try {
      return await store.setSecret(parsed.id, parsed.value)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('credential:secrets:clear', async (_, input: unknown): Promise<CredentialSecretClearResult> => {
    const parsed = parseId(input)
    if (!parsed.ok) return parsed
    try {
      return await store.clearSecret(parsed.id)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })
}
