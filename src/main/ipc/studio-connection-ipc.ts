import { MessageChannelMain, type IpcMain, type MessagePortMain } from 'electron'

import { STUDIO_CONNECT_CHANNEL, STUDIO_PORT_CHANNEL, type StudioConnectResult } from '../../shared/studio-connection'
import type { StudioFramePort } from '../../server/rpc/studio-frame-port'
import { assertAppSender } from './ipc-sender'

// A Studio window's connection to the Studio RPC. Main makes a message channel,
// serves one end in process and transfers the other to the asking window's
// preload, which keeps it out of the page. Only an app window's own top-level
// document is given one (the check every IPC that acts for the person makes),
// so a subframe, a webview guest or a page the window navigated to gets none.
//
// When the server runs in a process of its own, this is where its end goes
// instead: main brokers the channel and hands the server the other end, and
// the window sees no difference.

// A window has one connection, and a few more while it reconnects or an aux
// view of it opens its own; past this, the oldest is closed.
const MAX_CONNECTIONS_PER_WINDOW = 4

type WindowConnector = { connectWindow(port: StudioFramePort): StudioConnectResult }

/**
 * Main's end of a channel, as the frames a connection reads and writes. It
 * ends when the window's end goes (a reload, a closed window) or when main
 * closes it, and says so either way.
 */
export function messagePortFrames(port: MessagePortMain): StudioFramePort {
  const closeListeners: Array<() => void> = []
  let closed = false
  const end = () => {
    if (closed) return
    closed = true
    for (const listener of closeListeners.splice(0)) listener()
  }
  port.once('close', end)
  return {
    post: (frame) => {
      if (!closed) port.postMessage(frame)
    },
    onFrame: (listener) => {
      port.on('message', (event) => {
        if (typeof event.data === 'string') listener(event.data)
      })
      port.start()
    },
    onClose: (listener) => {
      if (closed) listener()
      else closeListeners.push(listener)
    },
    close: () => {
      port.close()
      end()
    },
  }
}

export function registerStudioConnectionIpc(ipcMain: IpcMain, studio: WindowConnector): void {
  const open = new Map<number, StudioFramePort[]>()
  ipcMain.handle(STUDIO_CONNECT_CHANNEL, (event): StudioConnectResult => {
    assertAppSender(event)
    const sender = event.sender
    let held = open.get(sender.id)
    if (!held) {
      held = []
      open.set(sender.id, held)
      sender.once('destroyed', () => open.delete(sender.id))
    }
    const { port1, port2 } = new MessageChannelMain()
    const frames = messagePortFrames(port1)
    const list = held
    list.push(frames)
    frames.onClose(() => {
      const index = list.indexOf(frames)
      if (index >= 0) list.splice(index, 1)
    })
    let connection: StudioConnectResult
    try {
      connection = studio.connectWindow(frames)
    } catch (error) {
      // No connection to hand over: main's end goes with it, and the window's
      // end is never sent.
      frames.close()
      throw error
    }
    while (list.length > MAX_CONNECTIONS_PER_WINDOW) list[0].close()
    sender.postMessage(STUDIO_PORT_CHANNEL, { connectionId: connection.connectionId }, [port2])
    return connection
  })
}
