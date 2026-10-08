import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type {
  ExtensionScaffoldCreateInput,
  ExtensionScaffoldCreateResult,
  ExtensionScaffoldTarget,
  ExtensionScaffoldTargetInput,
} from '../../shared/extension-scaffold'

// Build an extension (src/main/ipc/extension-scaffold-ipc.ts).
export const extensionScaffoldApi = {
  extensionScaffoldHome: (): Promise<string> => ipcRenderer.invoke('extensions:scaffold:home'),
  extensionScaffoldTarget: (input: ExtensionScaffoldTargetInput): Promise<ExtensionScaffoldTarget | null> =>
    ipcRenderer.invoke('extensions:scaffold:target', input),
  extensionScaffoldCreate: (input: ExtensionScaffoldCreateInput): Promise<ExtensionScaffoldCreateResult> =>
    ipcRenderer.invoke('extensions:scaffold:create', input),
} satisfies Pick<ElectronApi, 'extensionScaffoldHome' | 'extensionScaffoldTarget' | 'extensionScaffoldCreate'>
