import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  fleetTerminalEventChannel,
  FLEET_ATTACH_TERMINAL_CHANNEL,
  FLEET_BROWSE_CHANNEL,
  FLEET_CREATE_TERMINAL_CHANNEL,
  FLEET_WORKSPACE_CHECKOUT_CHANNEL,
  FLEET_DETACH_TERMINAL_CHANNEL,
  FLEET_FORGET_CHANNEL,
  FLEET_GET_LIVE_STATE_CHANNEL,
  FLEET_LIST_CONNECTIONS_CHANNEL,
  FLEET_LIST_RUNS_CHANNEL,
  FLEET_CANCEL_PAIRING_CHANNEL,
  FLEET_CHECK_REACHABILITY_CHANNEL,
  FLEET_COLLECT_PAIRING_CHANNEL,
  FLEET_PAIR_CHANNEL,
  FLEET_REQUEST_PAIRING_CHANNEL,
  FLEET_TERMINAL_INPUT_CHANNEL,
  FLEET_TERMINAL_RESIZE_CHANNEL,
  type FleetTerminalEvent,
} from '../../shared/tailnet-fleet'
import type { AutomationService } from '../automation/automation-service'

// The window's door onto the Fleet (MC-2167).
//
// IPC-only, exactly like the tailnet configuration channels: no MCP tool
// reaches any of this, so neither a local agent nor a paired remote device can
// make this machine pair with a third one, enumerate what it is paired with, or
// open a terminal somewhere else. Pairing another machine is a decision a person
// makes at this keyboard.
//
// Attachments are owned by the WINDOW that opened them. A window that closes or
// reloads has no pane left to paint, so its sockets are torn down with it
// rather than left attached to a remote pty nobody is watching.

export function registerFleetIpc(ipcMain: IpcMain, service: AutomationService): void {
  // attachId -> the window that asked for it, so a reload cannot leave a stream
  // writing into a destroyed sender.
  const owners = new Map<string, WebContents>()
  const trackedSenders = new Set<number>()

  const releaseSender = (senderId: number): void => {
    for (const [attachId, sender] of [...owners]) {
      if (sender.id !== senderId) continue
      owners.delete(attachId)
      service.fleet().detachTerminal(attachId)
    }
    trackedSenders.delete(senderId)
  }

  const trackSender = (event: IpcMainInvokeEvent): void => {
    if (trackedSenders.has(event.sender.id)) return
    trackedSenders.add(event.sender.id)
    event.sender.once('destroyed', () => releaseSender(event.sender.id))
  }

  ipcMain.handle(FLEET_LIST_CONNECTIONS_CHANNEL, () => service.fleet().listConnections())
  // The initial read behind `fleet:event`: what is attached right now, so a
  // reloaded window is not stuck on "paired" until the next link change.
  ipcMain.handle(FLEET_GET_LIVE_STATE_CHANNEL, () => service.fleet().getLiveState())
  ipcMain.handle(FLEET_PAIR_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.fleet().pair({ pairingUrl: record?.pairingUrl, deviceName: record?.deviceName })
  })
  // Asking a machine to pair, and polling the answer. Like every other
  // `fleet:*` channel this is IPC-only: pairing WITH a machine stays a decision
  // made at this keyboard, reachable from no MCP tool.
  ipcMain.handle(FLEET_REQUEST_PAIRING_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.fleet().requestPairing({
      endpoint: record?.endpoint,
      deviceName: record?.deviceName,
      reverseScopes: record?.reverseScopes,
    })
  })
  // Reachability on demand (the row's Retry): main already checks on start,
  // wake, and a timer; this is the person asking for one more, now.
  ipcMain.handle(FLEET_CHECK_REACHABILITY_CHANNEL, (_event, connectionId: unknown) =>
    service.fleet().checkReachability(typeof connectionId === 'string' ? connectionId : undefined)
  )
  ipcMain.handle(FLEET_COLLECT_PAIRING_CHANNEL, (_event, requestId: unknown) =>
    service.fleet().collectPairing(requestId)
  )
  ipcMain.handle(FLEET_CANCEL_PAIRING_CHANNEL, (_event, requestId: unknown) => {
    service.fleet().cancelPairing(requestId)
  })
  ipcMain.handle(FLEET_FORGET_CHANNEL, (_event, connectionId: unknown) => service.fleet().forget(connectionId))
  ipcMain.handle(FLEET_BROWSE_CHANNEL, (_event, connectionId: unknown) => service.fleet().browse(connectionId))
  ipcMain.handle(FLEET_LIST_RUNS_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.fleet().listRuns(record?.connectionId, record?.workspaceId)
  })
  ipcMain.handle(FLEET_CREATE_TERMINAL_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.fleet().createTerminal({
      connectionId: record.connectionId,
      workspaceId: record.workspaceId,
      name: record.name,
      cli: record.cli,
      prompt: record.prompt,
      cliModel: record.cliModel,
      permissionPreset: record.permissionPreset,
      checkout: record.checkout,
    })
  })
  ipcMain.handle(FLEET_WORKSPACE_CHECKOUT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.fleet().workspaceCheckout(record?.connectionId, record?.workspaceId)
  })

  ipcMain.handle(FLEET_ATTACH_TERMINAL_CHANNEL, async (event, input: unknown) => {
    const record = asRecord(input) ?? {}
    const attachId = typeof record.attachId === 'string' ? record.attachId : ''
    if (!attachId) {
      return { ok: false, code: 'invalid_arguments', message: 'An attachment needs an id to deliver its output on.' }
    }
    trackSender(event)
    owners.set(attachId, event.sender)
    const channel = fleetTerminalEventChannel(attachId)
    return service.fleet().attachTerminal({
      attachId,
      connectionId: record.connectionId,
      sessionId: record.sessionId,
      emit: (frame: FleetTerminalEvent) => {
        const sender = owners.get(attachId)
        if (!sender || sender.isDestroyed()) return
        sender.send(channel, frame)
      },
    })
  })

  ipcMain.handle(FLEET_DETACH_TERMINAL_CHANNEL, (_event, attachId: unknown) => {
    if (typeof attachId === 'string') owners.delete(attachId)
    service.fleet().detachTerminal(attachId)
  })

  // Keystrokes and resizes are `send`, not `invoke`: a keystroke that waits for
  // a round trip through main before the next one is read is a terminal that
  // feels laggy, and the local terminal path made the same call.
  ipcMain.on(FLEET_TERMINAL_INPUT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    service.fleet().sendInput(record?.attachId, record?.data)
  })
  ipcMain.on(FLEET_TERMINAL_RESIZE_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    service.fleet().resizeTerminal(record?.attachId, record?.cols, record?.rows)
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
