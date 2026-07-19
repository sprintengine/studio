import { registerReviewIpc } from '../ipc/review-ipc'
import { ReviewChangeSetServiceToken } from '../module-host/service-tokens'
import { createReviewChangeSetService } from '../review/changeset-service'
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
    registerReviewIpc(host.ipcMain, { changeSetService })
  },
}
