import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SplashProgress } from '../shared/electron-api'

// The launch plate's preload, and all of it: the one channel the plate listens
// on. The plate used to load the app's full preload — every API the app has,
// evaluated in a second renderer at the very moment the main window's renderer
// is starting — to read one progress line. It runs sandboxed, so it imports
// nothing but Electron; the same subscription lives in `api/splash.ts` for the
// app's own window.
contextBridge.exposeInMainWorld('api', {
  onSplashProgress: (cb: (update: SplashProgress) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, update: SplashProgress) => cb(update)
    ipcRenderer.on('splash:progress', handler)
    return () => ipcRenderer.removeListener('splash:progress', handler)
  },
})
