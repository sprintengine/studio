/**
 * What the update progress window says between "Restart to update" and the
 * installer taking over (owner ruling 2026-09-24: a small box like the loading
 * screen, with a progress bar, from the click until the app comes back).
 *
 * The window is the launch plate itself (splash-window.ts), which already
 * draws one status line and one determinate hairline; this is the line and the
 * position. The bar only moves when something has finished: each leg of the
 * ordered shutdown advances it by its share, so it counts work done rather than
 * guessing at time.
 */
import type { SplashProgress } from '../shared/electron-api'

export type UpdateInstallStage =
  | { stage: 'preparing' }
  | { stage: 'saving'; done: number; total: number }
  | { stage: 'starting-installer' }
  | { stage: 'handing-over'; platform: NodeJS.Platform; version: string | null }

/** Where each stage sits on the bar. Saving your work is most of the wait. */
const SAVING_FROM = 0.05
const SAVING_TO = 0.85
const STARTING_INSTALLER = 0.92

export function updateInstallProgress(stage: UpdateInstallStage): SplashProgress {
  switch (stage.stage) {
    case 'preparing':
      return { status: 'Getting ready to update…', progress: 0.02 }
    case 'saving': {
      const total = Math.max(1, stage.total)
      const done = Math.min(Math.max(0, stage.done), total)
      return { status: 'Saving your work…', progress: SAVING_FROM + (SAVING_TO - SAVING_FROM) * (done / total) }
    }
    case 'starting-installer':
      return { status: 'Starting the installer…', progress: STARTING_INSTALLER }
    case 'handing-over': {
      const name = stage.version ? `SprintEngine Studio ${stage.version}` : 'the update'
      // On Windows the installer's own progress window follows this one; on
      // macOS the bundle is swapped in place and the app reopens by itself.
      return {
        status: stage.platform === 'win32' ? `Installing ${name}…` : `Restarting into ${name}…`,
        progress: 1,
      }
    }
  }
}

/** One leg of the ordered shutdown, as it finishes. */
export type ShutdownLegReport = {
  name: string
  /** 1-based: how many legs have finished, this one included. */
  done: number
  total: number
  durationMs: number
  failed: boolean
}
