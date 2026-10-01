import type { IpcMain } from 'electron'

import type { DiagnosticLogInput } from '../../shared/electron-api'
import type { ChatTitleRequest, TextGenerationResult } from '../../shared/text-generation/contract'
import { writeDiagnosticLog } from '../diagnostics-service'
import { generateChatTitle } from '../text-generation/text-generation-service'

export type TextGenerationIpcDeps = {
  generate?: (request: ChatTitleRequest) => Promise<TextGenerationResult>
  log?: (entry: DiagnosticLogInput) => Promise<unknown>
}

// One channel per job. The handler never throws: a malformed request is a
// typed failure like any other, because the renderer's only move on failure
// is to keep the title it already has.
//
// That silence is the rule in the window, so the diagnostics log is where a
// failed title is written down: which engine was asked and what it said. At
// `info`, because a missing title is nothing the person has to act on; without
// the line, a refused model or effort level looks exactly like a feature that
// never ran.
export function registerTextGenerationIpc(ipcMain: IpcMain, deps: TextGenerationIpcDeps = {}): void {
  const generate = deps.generate ?? generateChatTitle
  const log = deps.log ?? writeDiagnosticLog
  ipcMain.handle('text-generation:chat-title', async (_, input: unknown): Promise<TextGenerationResult> => {
    const request = readChatTitleRequest(input)
    const result: TextGenerationResult = request
      ? await generate(request)
      : { ok: false, code: 'unsupported', message: 'Malformed chat title request.' }
    if (!result.ok) {
      await log({
        level: 'info',
        source: 'agents',
        title: 'Chat title not generated',
        message: `${describeEngine(request)}${result.code} — ${result.message}`,
      }).catch(() => undefined)
    }
    return result
  })
}

function describeEngine(request: ChatTitleRequest | null): string {
  if (!request) return ''
  const { cli, model, reasoning } = request.engine
  return `${[cli, model, reasoning].filter(Boolean).join(' · ')}: `
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
