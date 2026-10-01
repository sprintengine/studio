import type { IpcMain } from 'electron'

import { isRecord } from '../../shared/records'
import type { TourPlayback } from '../../shared/tours/tour-types'
import type { TourService } from '../tours/tour-service'

// The Diff viewer's side of diff tours. Every payload is read as input, not as
// the shape the preload promises: these handlers type into an agent's terminal
// and write files in the app's data folder.

function str(value: unknown, max = 256): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : null
}

function playbackOf(value: unknown): TourPlayback | null {
  if (!isRecord(value)) return null
  const visited = Array.isArray(value.visited) ? value.visited.filter((id): id is string => typeof id === 'string') : []
  return {
    started: value.started === true,
    currentStepId: typeof value.currentStepId === 'string' ? value.currentStepId : null,
    visited: visited.slice(0, 200),
    follow: value.follow === true,
  }
}

export function registerToursIpc(ipcMain: IpcMain, service: TourService): void {
  ipcMain.handle('tours:list', async (_event, workspaceId: unknown) => {
    const id = str(workspaceId)
    return id ? service.list(id) : []
  })
  ipcMain.handle('tours:read', async (_event, workspaceId: unknown, tourId: unknown) => {
    const ws = str(workspaceId)
    const tour = str(tourId)
    if (!ws || !tour) return { ok: false, message: 'No such tour.' }
    return service.read(ws, tour)
  })
  ipcMain.handle('tours:playback', async (_event, workspaceId: unknown, tourId: unknown, playback: unknown) => {
    const ws = str(workspaceId)
    const tour = str(tourId)
    const parsed = playbackOf(playback)
    if (ws && tour && parsed) await service.reportPlayback(ws, tour, parsed)
  })
  ipcMain.handle(
    'tours:ask',
    async (_event, workspaceId: unknown, tourId: unknown, stepId: unknown, question: unknown) => {
      const ws = str(workspaceId)
      const tour = str(tourId)
      const step = str(stepId)
      const text = str(question, 8_000)
      if (!ws || !tour || !step || !text) return { ok: false, message: 'Nothing to ask.' }
      return service.ask(ws, tour, step, text)
    },
  )
  ipcMain.handle('tours:cancel-ask', async (_event, workspaceId: unknown, tourId: unknown, askId: unknown) => {
    const ws = str(workspaceId)
    const tour = str(tourId)
    const ask = str(askId)
    if (ws && tour && ask) await service.cancelAsk(ws, tour, ask)
  })
  ipcMain.handle(
    'tours:ask-new-agent',
    async (_event, workspaceId: unknown, tourId: unknown, stepId: unknown, question: unknown) => {
      const ws = str(workspaceId)
      const tour = str(tourId)
      const step = str(stepId)
      const text = str(question, 8_000)
      if (!ws || !tour || !step || !text) return { ok: false, message: 'Nothing to ask.' }
      return service.askNewAgent(ws, tour, step, text)
    },
  )
  ipcMain.on('tours:reveal-ack', (_event, requestId: unknown) => {
    const id = str(requestId)
    if (id) service.acknowledgeReveal(id)
  })
  ipcMain.on('tours:goto-answer', (_event, answer: unknown) => {
    if (!isRecord(answer)) return
    const requestId = str(answer.requestId)
    if (!requestId) return
    service.answerGoto({
      requestId,
      moved: answer.moved === true,
      reason: str(answer.reason, 64) ?? 'unknown',
    })
  })
}
