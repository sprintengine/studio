import { ipcRenderer } from 'electron'
import type { ColorScheme, ElectronApi, WindowMaterial } from '../../shared/electron-api'

type AppearanceIpcRenderer = {
  invoke(channel: 'appearance:set-color-scheme', scheme: ColorScheme): Promise<void>
  invoke(channel: 'appearance:set-window-material', material: WindowMaterial): Promise<void>
  invoke(channel: 'app:set-background-mode', enabled: boolean): Promise<void>
}

export function createAppearanceApi(renderer: AppearanceIpcRenderer) {
  return {
    setColorScheme: (scheme: ColorScheme): Promise<void> =>
      renderer.invoke('appearance:set-color-scheme', scheme),
    setWindowMaterial: (material: WindowMaterial): Promise<void> =>
      renderer.invoke('appearance:set-window-material', material),
    // Not an appearance setting, but the same one-way push contract: the
    // renderer owns the preference, main keeps a copy it can read with no
    // window open (MC-2156).
    setBackgroundMode: (enabled: boolean): Promise<void> =>
      renderer.invoke('app:set-background-mode', enabled),
  } satisfies Pick<ElectronApi, 'setColorScheme' | 'setWindowMaterial' | 'setBackgroundMode'>
}

export const appearanceApi = createAppearanceApi(ipcRenderer)
