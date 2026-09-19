import type { IpcMain, IpcMainEvent } from 'electron'
import {
  BUILD_SKEW_LOG_PREFIX,
  BUILD_STAMP_CHANNEL,
  compareBuildStamps,
  formatBuildSkewLogLine,
  formatBuildSkewNotice,
  parseBuildStamp,
  type BuildSkewVerdict,
  type BuildStamp,
} from '../shared/build-stamp'

// Main's half of the build-identity check. Holds the stamp main booted
// with, takes each window's stamp as it reports, and says something exactly once
// when they disagree. Electron-free by construction so it is testable; the caller
// supplies where a line goes and where a person is told.

type BuildSkewWatchOptions = {
  mainStamp: BuildStamp
  /** One line per event. Defaults to the console. */
  log?: (line: string) => void
  /** Shows the operator one notice. Defaults to nothing — index.ts wires the dialog. */
  announce?: (notice: { headline: string; detail: string }) => void
}

export type BuildSkewWatch = {
  recordRendererStamp: (stamp: BuildStamp) => BuildSkewVerdict
  /** Feeds a raw IPC payload through validation. Returns null when it was not a stamp. */
  recordReportedPayload: (payload: unknown) => BuildSkewVerdict | null
}

export function createBuildSkewWatch({
  mainStamp,
  log = (line) => console.error(line),
  announce,
}: BuildSkewWatchOptions): BuildSkewWatch {
  // Keyed by the reported commit, not a bare boolean: a second window arriving on
  // the same divergent commit is the same fact repeated, while a third commit
  // showing up later is new and worth one more line.
  const announced = new Set<string>()
  let indeterminateLogged = false

  function recordRendererStamp(stamp: BuildStamp): BuildSkewVerdict {
    const verdict = compareBuildStamps(mainStamp, stamp)

    if (verdict.status === 'indeterminate') {
      // Not a skew and not a match — one side has no commit to compare, so the
      // check is off rather than quietly passing. Said once; it cannot change
      // for the life of the process.
      if (!indeterminateLogged) {
        indeterminateLogged = true
        log(
          `${BUILD_SKEW_LOG_PREFIX} build_skew_check_unavailable missing=${verdict.missing} ` +
            'reason=no_commit_identity',
        )
      }
      return verdict
    }

    if (verdict.status === 'match') return verdict

    // Keyed on the full sha, not the abbreviation the messages print: two
    // commits sharing a prefix are two incidents.
    const key = stamp.commit ?? ''
    if (announced.has(key)) return verdict
    announced.add(key)

    const notice = formatBuildSkewNotice(mainStamp, stamp)
    log(formatBuildSkewLogLine(mainStamp, stamp))
    log(`${BUILD_SKEW_LOG_PREFIX} ${notice.headline} ${notice.detail}`)
    announce?.(notice)
    return verdict
  }

  return {
    recordRendererStamp,
    recordReportedPayload: (payload) => {
      const stamp = parseBuildStamp(payload)
      if (!stamp) {
        log(`${BUILD_SKEW_LOG_PREFIX} build_stamp_report_rejected reason=malformed_payload`)
        return null
      }
      return recordRendererStamp(stamp)
    },
  }
}

/**
 * Listens for the windows' reports. `on`, not `handle`: the renderer is telling
 * main something and must never wait on the answer, the same shape as the boot
 * and startup-mark handshakes.
 */
export function attachBuildSkewWatch(ipcMain: IpcMain, watch: BuildSkewWatch): void {
  ipcMain.on(BUILD_STAMP_CHANNEL, (_event: IpcMainEvent, payload: unknown) => {
    watch.recordReportedPayload(payload)
  })
}
