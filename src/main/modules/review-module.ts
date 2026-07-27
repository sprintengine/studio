import { BrowserWindow } from 'electron'
import { registerReviewIpc } from '../ipc/review-ipc'
import {
  ReviewChangeSetServiceToken,
  ReviewGuideTerminalServiceToken,
  SprintEngineLaunchSettingsToken,
  TerminalRuntimeToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import { createReviewChangeSetService } from '../review/changeset-service'
import { BRIEF_RUN_EVENT_CHANNEL, type BriefRunEvent } from '../review/brief-run-service'
import {
  createReviewGuideTerminalService,
  REVIEW_GUIDE_SKILL_ID,
} from '../review/guide-terminal-service'
import { getPluginById } from '../plugin-registry-instance'
import { resolveSkillInvocation } from '../../shared/skill-invocation'
import type { CapabilityModule } from '../module-host/load-modules'

// Review as a capability module. Matches the renderer `review` module id so the
// single enablement override gates both processes: a disabled module registers
// no review IPC, so the renderer's creation flow and panel can't reach ingestion.
// It owns the ReviewChangeSetService lifecycle and provides it via a token so the
// GitHub PR provider (MC-1678) can register its source provider against the same
// instance. Depends on the agent runtime like the renderer side: the guide
// (MC-1783) is an ordinary agent terminal spawned through that runtime.
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
    const terminalRuntime = host.requireService(TerminalRuntimeToken)
    const workspaceSyncService = host.requireService(WorkspaceSyncServiceToken)
    const launchSettings = host.requireService(SprintEngineLaunchSettingsToken)

    // The guide terminal (MC-1783). Phase events fan out to every open window so
    // any review tab can render live progress.
    const emit = (event: BriefRunEvent): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(BRIEF_RUN_EVENT_CHANNEL, event)
      }
    }
    // Provided under a token as well as held here: the Studio gateway's
    // review_submit_brief sink is registered in app-services, and a landed brief
    // ends the run, so it resolves this service to release the guide's terminal
    // back to the idle reaper instead of reaching into the terminal runtime.
    const guideTerminals = host.provideService(ReviewGuideTerminalServiceToken, () =>
      createReviewGuideTerminalService({
        listWorkspaces: () => workspaceSyncService.getSnapshot().state.workspaces,
        terminal: {
          list: () => terminalRuntime.ipcHandlers.listTerminals(),
          // The guide's pty needs a window as its event sink, exactly like the
          // sprint scheduler's in-process spawns. Reviews are opened from a
          // window, so one is always there; without one the spawn reports the
          // failure rather than starting a terminal nothing can show.
          spawn: async (payload) => {
            const sender = BrowserWindow.getAllWindows()
              .find((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
              ?.webContents
            if (!sender) {
              return {
                ok: false,
                sessionId: payload.sessionId,
                message: 'Open a Multicode window to run the review guide.',
                exitCode: 1,
              }
            }
            return terminalRuntime.ipcHandlers.spawnTerminal(sender, payload)
          },
          write: (sessionId, data) => terminalRuntime.ipcHandlers.writeTerminal(sessionId, data),
          kill: (sessionId) => terminalRuntime.ipcHandlers.killTerminal(sessionId),
          setReapExempt: (sessionId, exempt) =>
            terminalRuntime.ipcHandlers.setTerminalReapExempt(sessionId, exempt),
          onAgentSessionExit: (listener) => terminalRuntime.registerAgentSessionExitListener(listener),
        },
        resolveSkillInvocation: (cli) =>
          resolveSkillInvocation(getPluginById(cli)?.manifest.skillIntegration, REVIEW_GUIDE_SKILL_ID),
        launchSettings: () => launchSettings.get(),
        emit,
      })
    )
    host.onShutdown(() => guideTerminals.dispose())

    registerReviewIpc(host.ipcMain, {
      changeSetService,
      guideTerminals,
      // Posting a review is human-outward; allow it only when the invocation
      // resolves to a real application window. The guide runs in a terminal with
      // no renderer, so it can never satisfy this (or reach an ipcMain handler).
      isUserWindowSender: (event) => BrowserWindow.fromWebContents(event.sender) !== null,
    })
  },
}
