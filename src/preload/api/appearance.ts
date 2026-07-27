import { ipcRenderer } from 'electron'
import type { ColorScheme, ElectronApi, WindowMaterial } from '../../shared/electron-api'

type AppearanceIpcRenderer = {
  invoke(channel: 'appearance:set-color-scheme', scheme: ColorScheme): Promise<void>
  invoke(channel: 'appearance:set-window-material', material: WindowMaterial): Promise<void>
}

export function createAppearanceApi(renderer: AppearanceIpcRenderer) {
  return {
    setColorScheme: (scheme: ColorScheme): Promise<void> =>
      renderer.invoke('appearance:set-color-scheme', scheme),
    setWindowMaterial: (material: WindowMaterial): Promise<void> =>
      renderer.invoke('appearance:set-window-material', material),
  } satisfies Pick<ElectronApi, 'setColorScheme' | 'setWindowMaterial'>
}

export const appearanceApi = createAppearanceApi(ipcRenderer)
