import type { IpcMain } from 'electron'

import type { ChatTitleRequest, TextGenerationResult } from '../../shared/text-generation/contract'
import { generateChatTitle } from '../text-generation/text-generation-service'

// One channel per job. The handler never throws: a malformed request is a
// typed failure like any other, because the renderer's only move on failure
// is to keep the title it already has.
export function registerTextGenerationIpc(ipcMain: IpcMain): void {
  ipcMain.handle('text-generation:chat-title', async (_, input: unknown): Promise<TextGenerationResult> => {
    const request = readChatTitleRequest(input)
    if (!request) return { ok: false, code: 'unsupported', message: 'Malformed chat title request.' }
    return generateChatTitle(request)
  })
}

function readChatTitleRequest(input: unknown): ChatTitleRequest | null {
  if (!input || typeof input !== 'object') return null
  const { prompt, engine, cliRuntimes, timeoutMs } = input as Record<string, unknown>
  if (typeof prompt !== 'string' || !engine || typeof engine !== 'object') return null
  const { cli, model, reasoning } = engine as Record<string, unknown>
  if (typeof cli !== 'string' || typeof model !== 'string') return null
  return {
    prompt,
    engine: { cli, model, ...(typeof reasoning === 'string' && reasoning ? { reasoning } : {}) },
    ...(cliRuntimes && typeof cliRuntimes === 'object'
      ? { cliRuntimes: cliRuntimes as ChatTitleRequest['cliRuntimes'] }
      : {}),
    ...(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  }
}
