import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import {
  CHAT_LINK_OPEN_CHANNEL,
  CHAT_LINK_READY_CHANNEL,
  CHAT_LINK_UNREADY_CHANNEL,
  type ChatLink,
} from '../../shared/deep-link'
import type {
  AuxWindowRetargetPayload,
  CreateWorkspaceWindowInput,
  CreateWorkspaceWindowResult,
  DockDiffToWorkspaceInput,
  DockDiffToWorkspacePayload,
  DockDiffToWorkspaceResult,
  DockFileToWorkspaceInput,
  ElectronApi,
  OpenAuxWindowInput,
  OpenAuxWindowResult,
  OpenExternalResult,
  PanePopOutAction,
  PanePopOutActionEvent,
  PanePopOutClosedEvent,
  PanePopOutOpenInput,
  PanePopOutOpenResult,
  PanePopOutSnapshot,
  PanePopOutState,
  PanePopOutStatePush,
  WindowPlacement,
  WindowState,
} from '../../shared/electron-api'

export const windowApi = {
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: (): Promise<WindowState | null> => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  getWindowState: (): Promise<WindowState | null> => ipcRenderer.invoke('window:get-state'),
  getWindowPlacement: (): Promise<WindowPlacement | null> => ipcRenderer.invoke('window:get-placement'),
  createWorkspaceWindow: (input: CreateWorkspaceWindowInput): Promise<CreateWorkspaceWindowResult> =>
    ipcRenderer.invoke('window:create-workspace-window', input),
  openAuxWindow: (input: OpenAuxWindowInput): Promise<OpenAuxWindowResult> =>
    ipcRenderer.invoke('window:open-aux-window', input),
  onAuxWindowRetarget: (cb: (payload: AuxWindowRetargetPayload) => void): (() => void) => {
    const ch = 'aux:retarget'
    const handler = (_: IpcRendererEvent, payload: AuxWindowRetargetPayload) => cb(payload)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  dockFileToWorkspace: (input: DockFileToWorkspaceInput): Promise<void> =>
    ipcRenderer.invoke('window:dock-file', input),
  onDockFileToWorkspace: (cb: (input: DockFileToWorkspaceInput) => void): (() => void) => {
    const ch = 'workspace:dock-file'
    const handler = (_: IpcRendererEvent, input: DockFileToWorkspaceInput) => cb(input)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  dockDiffToWorkspace: (input: DockDiffToWorkspaceInput): Promise<DockDiffToWorkspaceResult> =>
    ipcRenderer.invoke('window:dock-diff', input),
  onDockDiffToWorkspace: (cb: (input: DockDiffToWorkspacePayload) => void): (() => void) => {
    const ch = 'workspace:dock-diff'
    const handler = (_: IpcRendererEvent, input: DockDiffToWorkspacePayload) => cb(input)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  // Fire-and-forget on purpose: main is already waiting on this and has its own
  // timeout, so there is nothing for the acking window to await.
  ackDockDiffToWorkspace: (requestId: string): void => {
    ipcRenderer.send('window:dock-diff-ack', requestId)
  },
  confirmWindowClose: (): Promise<void> => ipcRenderer.invoke('window:confirm-close'),
  openExternal: (url: string): Promise<OpenExternalResult> => ipcRenderer.invoke('window:open-external', url),
  onWindowStateChanged: (cb: (state: WindowState) => void): (() => void) => {
    const ch = 'window:state-changed'
    const handler = (_: IpcRendererEvent, state: WindowState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onWindowHiddenChanged: (cb: (hidden: boolean) => void): (() => void) => {
    const ch = 'window:hidden-changed'
    const handler = (_: IpcRendererEvent, hidden: boolean) => cb(hidden)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onWindowPlacementChanged: (cb: (placement: WindowPlacement) => void): (() => void) => {
    const ch = 'window:placement-changed'
    const handler = (_: IpcRendererEvent, placement: WindowPlacement) => cb(placement)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onWindowCloseRequested: (cb: () => void): (() => void) => {
    const ch = 'window:close-requested'
    const handler = () => cb()
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  // The listener first, then the word to main, so a link main was holding
  // cannot arrive before anyone hears it.
  onChatLinkOpen: (cb: (link: ChatLink) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, link: ChatLink) => cb(link)
    ipcRenderer.on(CHAT_LINK_OPEN_CHANNEL, handler)
    ipcRenderer.send(CHAT_LINK_READY_CHANNEL)
    return () => {
      ipcRenderer.removeListener(CHAT_LINK_OPEN_CHANNEL, handler)
      ipcRenderer.send(CHAT_LINK_UNREADY_CHANNEL)
    }
  },
  panePopOutOpen: (input: PanePopOutOpenInput): Promise<PanePopOutOpenResult> =>
    ipcRenderer.invoke('pane-popout:open', input),
  // Sends rather than invokes: the owner pushes on every change to the tabs it
  // has out, and nothing waits on main having relayed one.
  panePopOutPush: (popOutId: string, state: PanePopOutState): void => {
    ipcRenderer.send('pane-popout:push', { popOutId, state })
  },
  panePopOutFocus: (popOutId: string): Promise<void> => ipcRenderer.invoke('pane-popout:focus', { popOutId }),
  panePopOutClose: (popOutId: string): Promise<void> => ipcRenderer.invoke('pane-popout:close', { popOutId }),
  onPanePopOutAction: (cb: (event: PanePopOutActionEvent) => void): (() => void) => {
    const ch = 'pane-popout:action'
    const handler = (_: IpcRendererEvent, event: PanePopOutActionEvent) => cb(event)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onPanePopOutClosed: (cb: (event: PanePopOutClosedEvent) => void): (() => void) => {
    const ch = 'pane-popout:closed'
    const handler = (_: IpcRendererEvent, event: PanePopOutClosedEvent) => cb(event)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  panePopOutGetState: (popOutId: string): Promise<PanePopOutSnapshot | null> =>
    ipcRenderer.invoke('pane-popout:get-state', { popOutId }),
  onPanePopOutState: (cb: (push: PanePopOutStatePush) => void): (() => void) => {
    const ch = 'pane-popout:state'
    const handler = (_: IpcRendererEvent, push: PanePopOutStatePush) => cb(push)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  panePopOutAct: (popOutId: string, action: PanePopOutAction): void => {
    ipcRenderer.send('pane-popout:act', { popOutId, action })
  },
} satisfies Pick<
  ElectronApi,
  | 'windowMinimize'
  | 'windowToggleMaximize'
  | 'windowClose'
  | 'getWindowState'
  | 'getWindowPlacement'
  | 'createWorkspaceWindow'
  | 'openAuxWindow'
  | 'onAuxWindowRetarget'
  | 'dockFileToWorkspace'
  | 'onDockFileToWorkspace'
  | 'dockDiffToWorkspace'
  | 'onDockDiffToWorkspace'
  | 'ackDockDiffToWorkspace'
  | 'confirmWindowClose'
  | 'openExternal'
  | 'onWindowStateChanged'
  | 'onWindowHiddenChanged'
  | 'onWindowPlacementChanged'
  | 'onWindowCloseRequested'
  | 'onChatLinkOpen'
  | 'panePopOutOpen'
  | 'panePopOutPush'
  | 'panePopOutFocus'
  | 'panePopOutClose'
  | 'onPanePopOutAction'
  | 'onPanePopOutClosed'
  | 'panePopOutGetState'
  | 'onPanePopOutState'
  | 'panePopOutAct'
>
