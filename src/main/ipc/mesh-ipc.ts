import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  meshTerminalEventChannel,
  MESH_ATTACH_TERMINAL_CHANNEL,
  MESH_BROWSE_CHANNEL,
  MESH_CREATE_TERMINAL_CHANNEL,
  MESH_WORKSPACE_CHECKOUT_CHANNEL,
  MESH_DETACH_TERMINAL_CHANNEL,
  MESH_FORGET_CHANNEL,
  MESH_GET_LIVE_STATE_CHANNEL,
  MESH_LIST_CONNECTIONS_CHANNEL,
  MESH_CANCEL_PAIRING_CHANNEL,
  MESH_CHECK_REACHABILITY_CHANNEL,
  MESH_PAIR_CHANNEL,
  MESH_REQUEST_PAIRING_CHANNEL,
  MESH_TERMINAL_INPUT_CHANNEL,
  MESH_TERMINAL_RESIZE_CHANNEL,
  type MeshTerminalEvent,
  meshConversationFrameChannel,
  MESH_CONVERSATION_COMMAND_CHANNEL,
  MESH_CONVERSATION_EARLIER_CHANNEL,
  MESH_CONVERSATION_FOLLOW_CHANNEL,
  MESH_CONVERSATION_LIST_CHANNEL,
  MESH_CONVERSATION_TOOL_DETAIL_CHANNEL,
  MESH_CONVERSATION_TURN_DIFF_CHANNEL,
  MESH_CONVERSATION_UNFOLLOW_CHANNEL,
  type MeshConversationFrame,
} from '../../shared/tailnet-mesh'
import type { AutomationService } from '../automation/automation-service'
import { asRecord } from '../../shared/records'

// The window's door onto the Mesh.
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

export function registerMeshIpc(ipcMain: IpcMain, service: AutomationService): void {
  // attachId -> the window that asked for it, so a reload cannot leave a stream
  // writing into a destroyed sender.
  const owners = new Map<string, WebContents>()
  const trackedSenders = new Set<number>()

  // followId -> the window following, for the same reason: a followed
  // conversation's frames go to one window, and end with it.
  const followers = new Map<string, WebContents>()

  const releaseSender = (senderId: number): void => {
    for (const [attachId, sender] of [...owners]) {
      if (sender.id !== senderId) continue
      owners.delete(attachId)
      service.mesh().detachTerminal(attachId)
    }
    for (const [followId, sender] of [...followers]) {
      if (sender.id !== senderId) continue
      followers.delete(followId)
      service.mesh().unfollowConversation(followId)
    }
    trackedSenders.delete(senderId)
  }

  const trackSender = (event: IpcMainInvokeEvent): void => {
    if (trackedSenders.has(event.sender.id)) return
    trackedSenders.add(event.sender.id)
    event.sender.once('destroyed', () => releaseSender(event.sender.id))
  }

  ipcMain.handle(MESH_LIST_CONNECTIONS_CHANNEL, () => service.mesh().listConnections())
  // The initial read behind `mesh:event`: what is attached right now, so a
  // reloaded window is not stuck on "paired" until the next link change.
  ipcMain.handle(MESH_GET_LIVE_STATE_CHANNEL, () => service.mesh().getLiveState())
  ipcMain.handle(MESH_PAIR_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.mesh().pair({ pairingUrl: record?.pairingUrl, deviceName: record?.deviceName })
  })
  // Asking a machine to pair, and polling the answer. Like every other
  // `mesh:*` channel this is IPC-only: pairing WITH a machine stays a decision
  // made at this keyboard, reachable from no MCP tool.
  ipcMain.handle(MESH_REQUEST_PAIRING_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.mesh().requestPairing({
      endpoint: record?.endpoint,
      deviceName: record?.deviceName,
      // Both halves of a both-ways pairing carry their own set: `scopes` is
      // what this machine asks to do THERE, `reverseScopes` what that machine
      // may do here. Absent leaves each end's own default in force.
      scopes: record?.scopes,
      reverseScopes: record?.reverseScopes,
    })
  })
  // Reachability on demand (the row's Retry): main already checks on start,
  // wake, and a timer; this is the person asking for one more, now.
  ipcMain.handle(MESH_CHECK_REACHABILITY_CHANNEL, (_event, connectionId: unknown) =>
    service.mesh().checkReachability(typeof connectionId === 'string' ? connectionId : undefined),
  )
  ipcMain.handle(MESH_CANCEL_PAIRING_CHANNEL, (_event, requestId: unknown) => {
    service.mesh().cancelPairing(requestId)
  })
  ipcMain.handle(MESH_FORGET_CHANNEL, (_event, connectionId: unknown) => service.mesh().forget(connectionId))
  ipcMain.handle(MESH_BROWSE_CHANNEL, (_event, connectionId: unknown) => service.mesh().browse(connectionId))
  ipcMain.handle(MESH_CREATE_TERMINAL_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().createTerminal({
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
  ipcMain.handle(MESH_WORKSPACE_CHECKOUT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.mesh().workspaceCheckout(record?.connectionId, record?.workspaceId)
  })

  ipcMain.handle(MESH_ATTACH_TERMINAL_CHANNEL, async (event, input: unknown) => {
    const record = asRecord(input) ?? {}
    const attachId = typeof record.attachId === 'string' ? record.attachId : ''
    if (!attachId) {
      return { ok: false, code: 'invalid_arguments', message: 'An attachment needs an id to deliver its output on.' }
    }
    trackSender(event)
    owners.set(attachId, event.sender)
    const channel = meshTerminalEventChannel(attachId)
    return service.mesh().attachTerminal({
      attachId,
      connectionId: record.connectionId,
      sessionId: record.sessionId,
      emit: (frame: MeshTerminalEvent) => {
        const sender = owners.get(attachId)
        if (!sender || sender.isDestroyed()) return
        sender.send(channel, frame)
      },
    })
  })

  ipcMain.handle(MESH_DETACH_TERMINAL_CHANNEL, (_event, attachId: unknown) => {
    if (typeof attachId === 'string') owners.delete(attachId)
    service.mesh().detachTerminal(attachId)
  })

  // Conversations on a paired machine. Like every `mesh:*` channel these
  // are IPC-only: following another machine's chat is something a person
  // here asks for, reachable from no MCP tool.
  ipcMain.handle(MESH_CONVERSATION_LIST_CHANNEL, (_event, connectionId: unknown) =>
    service.mesh().listConversations(connectionId),
  )
  ipcMain.handle(MESH_CONVERSATION_FOLLOW_CHANNEL, (event, input: unknown) => {
    const record = asRecord(input) ?? {}
    const followId = typeof record.followId === 'string' ? record.followId : ''
    if (!followId) {
      return { ok: false, code: 'invalid_arguments', message: 'A follow needs an id to deliver its frames on.' }
    }
    trackSender(event)
    followers.set(followId, event.sender)
    const channel = meshConversationFrameChannel(followId)
    return service.mesh().followConversation({
      followId,
      key: record.key,
      turnLimit: record.turnLimit,
      emit: (frame: MeshConversationFrame) => {
        const sender = followers.get(followId)
        if (!sender || sender.isDestroyed()) return
        sender.send(channel, frame)
      },
    })
  })
  ipcMain.handle(MESH_CONVERSATION_UNFOLLOW_CHANNEL, (_event, followId: unknown) => {
    if (typeof followId === 'string') followers.delete(followId)
    service.mesh().unfollowConversation(followId)
  })
  ipcMain.handle(MESH_CONVERSATION_EARLIER_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service
      .mesh()
      .conversationLoadEarlier({ key: record.key, beforeCursor: record.beforeCursor, turnLimit: record.turnLimit })
  })
  ipcMain.handle(MESH_CONVERSATION_COMMAND_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationCommand({ key: record.key, command: record.command })
  })
  ipcMain.handle(MESH_CONVERSATION_TOOL_DETAIL_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationToolDetail({ key: record.key, toolUseId: record.toolUseId })
  })
  ipcMain.handle(MESH_CONVERSATION_TURN_DIFF_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationTurnDiff({ key: record.key, turnSeq: record.turnSeq, path: record.path })
  })

  // Keystrokes and resizes are `send`, not `invoke`: a keystroke that waits for
  // a round trip through main before the next one is read is a terminal that
  // feels laggy, and the local terminal path made the same call.
  ipcMain.on(MESH_TERMINAL_INPUT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    service.mesh().sendInput(record?.attachId, record?.data)
  })
  ipcMain.on(MESH_TERMINAL_RESIZE_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    service.mesh().resizeTerminal(record?.attachId, record?.cols, record?.rows)
  })
}
