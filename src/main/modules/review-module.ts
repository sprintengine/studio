import { BrowserWindow } from 'electron'
import { registerReviewIpc } from '../ipc/review-ipc'
import { CompanionAgentServiceToken, ReviewChangeSetServiceToken } from '../module-host/service-tokens'
import { createReviewChangeSetService } from '../review/changeset-service'
import {
  BRIEF_RUN_EVENT_CHANNEL,
  createReviewBriefRunService,
  type BriefRunEvent,
} from '../review/brief-run-service'
import type { CapabilityModule } from '../module-host/load-modules'

// Review as a capability module. Matches the renderer `review` module id so the
// single enablement override gates both processes: a disabled module registers
// no review IPC, so the renderer's creation flow and panel can't reach ingestion.
// It owns the ReviewChangeSetService lifecycle and provides it via a token so the
// GitHub PR provider (MC-1678) can register its source provider against the same
// instance. Depends on the agent runtime like the renderer side (the guide agent,
// MC-1679, runs through it).
export const reviewModule: CapabilityModule = {
  manifest: {
    id: 'review',
    displayName: 'Review',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Guided, human-led review of a pull request, branch, or patch.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerMain(host) {
    const changeSetService = host.provideService(ReviewChangeSetServiceToken, () =>
      createReviewChangeSetService()
    )
    // The guide run (MC-1679) builds on the companion-agent surface (MC-1684),
    // provided by the agent-runtime module this module depends on. Phase events
    // fan out to every open window so any review tab can render live progress.
    const companionAgents = host.requireService(CompanionAgentServiceToken)
    const briefRunService = createReviewBriefRunService({
      companionAgents,
      changeSets: changeSetService,
      emit: (event: BriefRunEvent) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(BRIEF_RUN_EVENT_CHANNEL, event)
        }
      },
    })
    registerReviewIpc(host.ipcMain, {
      changeSetService,
      briefRunService,
      // Posting a review is human-outward; allow it only when the invocation
      // resolves to a real application window. The guide companion has no
      // renderer, so it can never satisfy this (or reach an ipcMain handler).
      isUserWindowSender: (event) => BrowserWindow.fromWebContents(event.sender) !== null,
    })
  },
}
