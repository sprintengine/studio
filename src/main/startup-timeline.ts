import { performance } from 'node:perf_hooks'
import type { IpcMain, IpcMainEvent } from 'electron'
import {
  createStartupTimeline,
  formatStartupTimeline,
  startupTimelineEnabledFor,
  STARTUP_MARK_CHANNEL,
  type StartupMarkId,
  type StartupTimeline,
  type StartupTimelineReport,
} from '../shared/startup-timeline'

// Main-process side of the boot measurement (MC-2075). Owns the clock origin,
// collects its own phases, listens for the renderer's, and prints one read-out
// when boot is done.
//
// Off unless asked for (`MULTICODE_STARTUP_TIMELINE=1`, or the diagnostics
// build flag). When off, `markStartup` is a no-op and no IPC listener is
// registered — a renderer that still sends a mark hits an unhandled channel,
// which is a no-op by design.

// `performance.timeOrigin` is this process's start, in epoch ms. Every offset in
// the report is measured from it, including the renderer's, which reports its
// marks in epoch ms for exactly this reason.
const ORIGIN_EPOCH_MS = performance.timeOrigin

const enabled = startupTimelineEnabledFor(process.env)

let timeline: StartupTimeline | null = enabled
  ? createStartupTimeline({ originEpochMs: ORIGIN_EPOCH_MS, onFinalize: reportStartupTimeline })
  : null

// The origin is a mark in its own right, so the read-out opens at 0 ms rather
// than at whatever the first instrumented call site happened to be.
timeline?.record('main.process-start', ORIGIN_EPOCH_MS)

// Records a main-process phase now. Also emits a real `performance.mark`, so a
// Node inspector session sees the same phases without this module's read-out.
export function markStartup(id: StartupMarkId): void {
  if (!timeline) return
  try {
    performance.mark(id)
  } catch {
    // The user-timing buffer is a convenience; the timeline is the record.
  }
  // Epoch ms at sub-millisecond resolution — `Date.now()` would quantise the
  // short main-side phases to whole milliseconds.
  timeline.record(id, ORIGIN_EPOCH_MS + performance.now())
}

// The renderer reports in epoch ms because its `performance.now()` origin is its
// own document navigation, not this process's start.
export function attachStartupTimeline(ipcMain: IpcMain): void {
  if (!timeline) return
  ipcMain.on(STARTUP_MARK_CHANNEL, (_event: IpcMainEvent, id: unknown, atEpochMs: unknown) => {
    timeline?.record(String(id), typeof atEpochMs === 'number' ? atEpochMs : Number.NaN)
  })
}

function reportStartupTimeline(report: StartupTimelineReport): void {
  timeline = null
  console.info(`[startup-timeline] boot measured (${report.complete ? 'complete' : report.finalizedBecause})`)
  console.info(formatStartupTimeline(report))
  // One machine-readable line, which is what `scripts/measure-startup.mjs`
  // parses. Kept on its own line and prefixed so it survives interleaved boot
  // logging from both processes.
  console.info(`[startup-timeline-json] ${JSON.stringify(report)}`)
}
