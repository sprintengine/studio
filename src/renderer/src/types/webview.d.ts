// The Electron <webview> tag as JSX, for the workspace pane's browser tab
// (browser-pane epic). Only the attributes and methods the pane uses are
// declared; the element is driven from main once its WebContents id is
// registered, so the renderer needs very little of Electron's WebviewTag.

import 'react'

export interface EmbeddedWebviewElement extends HTMLElement {
  src: string
  getWebContentsId(): number
  focus(): void
  /** Message the guest preload (`ipcRenderer.on(channel)` there). */
  send(channel: string, ...args: unknown[]): Promise<void>
}

/** The `ipc-message` DOM event a guest's `ipcRenderer.sendToHost` raises. */
export interface WebviewIpcMessageEvent extends Event {
  channel: string
  args: unknown[]
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<EmbeddedWebviewElement>, EmbeddedWebviewElement> & {
        src?: string
        partition?: string
        webpreferences?: string
        preload?: string
      }
    }
  }
}
