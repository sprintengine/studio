import { ipcRenderer } from 'electron'
import type { ColorScheme, ElectronApi } from '../../shared/electron-api'

type AppearanceIpcRenderer = {
  invoke(channel: 'appearance:set-color-scheme', scheme: ColorScheme): Promise<void>
}

export function createAppearanceApi(renderer: AppearanceIpcRenderer) {
  return {
    setColorScheme: (scheme: ColorScheme): Promise<void> =>
      renderer.invoke('appearance:set-color-scheme', scheme),
  } satisfies Pick<ElectronApi, 'setColorScheme'>
}

export const appearanceApi = createAppearanceApi(ipcRenderer)
