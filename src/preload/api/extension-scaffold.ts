import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type {
  ExtensionScaffoldCheck,
  ExtensionScaffoldCheckInput,
  ExtensionScaffoldCreateInput,
  ExtensionScaffoldCreateResult,
  ExtensionScaffoldFolderPick,
  ExtensionTemplateSummary,
} from '../../shared/extension-scaffold'

// Build your own extension (src/main/ipc/extension-scaffold-ipc.ts).
export const extensionScaffoldApi = {
  extensionScaffoldTemplates: (): Promise<ExtensionTemplateSummary[]> =>
    ipcRenderer.invoke('extensions:scaffold:templates'),
  extensionScaffoldCheck: (input: ExtensionScaffoldCheckInput): Promise<ExtensionScaffoldCheck[]> =>
    ipcRenderer.invoke('extensions:scaffold:check', input),
  extensionScaffoldPickFolder: (): Promise<ExtensionScaffoldFolderPick | null> =>
    ipcRenderer.invoke('extensions:scaffold:pick-folder'),
  extensionScaffoldCreate: (input: ExtensionScaffoldCreateInput): Promise<ExtensionScaffoldCreateResult> =>
    ipcRenderer.invoke('extensions:scaffold:create', input),
} satisfies Pick<
  ElectronApi,
  'extensionScaffoldTemplates' | 'extensionScaffoldCheck' | 'extensionScaffoldPickFolder' | 'extensionScaffoldCreate'
>
