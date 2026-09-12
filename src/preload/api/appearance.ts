import { ipcRenderer } from 'electron'
import type { ColorScheme, ElectronApi, WindowMaterial } from '../../shared/electron-api'

type AppearanceIpcRenderer = {
  invoke(channel: 'appearance:set-color-scheme', scheme: ColorScheme): Promise<void>
  invoke(channel: 'appearance:set-window-material', material: WindowMaterial): Promise<void>
  invoke(channel: 'app:set-background-mode', enabled: boolean): Promise<void>
  invoke(channel: 'app:set-telemetry-enabled', enabled: boolean): Promise<void>
}

function createAppearanceApi(renderer: AppearanceIpcRenderer) {
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
    // Third rider on the same contract: the renderer owns the usage-data
    // choice, main holds the copy it consults with no window open.
    setTelemetryEnabled: (enabled: boolean): Promise<void> =>
      renderer.invoke('app:set-telemetry-enabled', enabled),
  } satisfies Pick<
    ElectronApi,
    'setColorScheme' | 'setWindowMaterial' | 'setBackgroundMode' | 'setTelemetryEnabled'
  >
}

export const appearanceApi = createAppearanceApi(ipcRenderer)
