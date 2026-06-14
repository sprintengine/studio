import type { IpcStatsSnapshot } from '../../../../shared/electron-api'

// The preload reports monotonic IPC counters; the panel diffs two consecutive
// snapshots to get per-second rates. Pure so it unit-tests without a preload.
export type IpcChannelRate = {
  name: string
  callsPerSec: number
  outBytesPerSec: number
  inEventsPerSec: number
  inBytesPerSec: number
  totalCalls: number
}

export type IpcThroughput = {
  elapsedMs: number
  channels: IpcChannelRate[]
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

export function diffIpcSnapshots(prev: IpcStatsSnapshot | null, current: IpcStatsSnapshot): IpcThroughput {
  const elapsedMs = prev ? current.sampledAt - prev.sampledAt : 0
  const perSec = elapsedMs > 0 ? 1000 / elapsedMs : 0
  const prevByName = new Map((prev?.channels ?? []).map((channel) => [channel.name, channel]))

  const channels: IpcChannelRate[] = current.channels.map((channel) => {
    const before = prevByName.get(channel.name)
    return {
      name: channel.name,
      callsPerSec: round((channel.calls - (before?.calls ?? 0)) * perSec),
      outBytesPerSec: Math.round((channel.outBytes - (before?.outBytes ?? 0)) * perSec),
      inEventsPerSec: round((channel.inEvents - (before?.inEvents ?? 0)) * perSec),
      inBytesPerSec: Math.round((channel.inBytes - (before?.inBytes ?? 0)) * perSec),
      totalCalls: channel.calls,
    }
  })

  // Busiest channel first by combined byte rate, then call rate — the chatty
  // channels operators want to see.
  channels.sort(
    (a, b) =>
      b.outBytesPerSec + b.inBytesPerSec - (a.outBytesPerSec + a.inBytesPerSec) ||
      b.callsPerSec + b.inEventsPerSec - (a.callsPerSec + a.inEventsPerSec)
  )
  return { elapsedMs, channels }
}
