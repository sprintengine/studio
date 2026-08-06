import { ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  ContentSearchResult,
  ContextMenuItem,
  DiagnosticLogEntry,
  DiagnosticLogInput,
  ElectronApi,
  FileSearchResult,
  FileWatchEvent,
  FolderOpenRequest,
  FolderOpenResult,
  FolderOpenTargetAvailability,
  MemoryGraphIndexResult,
  MemoryPreviewResult,
  MemoryRootStatus,
  OpenDialogOptions,
  ProcessMetricsSnapshot,
  ProjectLogo,
  SaveDialogOptions,
  VersionControlProviderProbe,
  WorkspaceFolderCheckResult,
} from '../../shared/electron-api'

export const filesystemApi = {
  readdir: (path: string) => ipcRenderer.invoke('fs:readdir', path),
  searchFiles: (rootPath: string, query: string, options?: { limit?: number; excludes?: string[] }): Promise<FileSearchResult> =>
    ipcRenderer.invoke('fs:search-files', { rootPath, query, limit: options?.limit, excludes: options?.excludes }),
  searchContent: (rootPath: string, query: string, options?: { limit?: number; excludes?: string[] }): Promise<ContentSearchResult> =>
    ipcRenderer.invoke('fs:search-content', { rootPath, query, limit: options?.limit, excludes: options?.excludes }),
  cancelContentSearch: (): Promise<void> =>
    ipcRenderer.invoke('fs:cancel-content-search'),
  readfile: (path: string) => ipcRenderer.invoke('fs:readfile', path),
  readImageDataUrl: (path: string) => ipcRenderer.invoke('fs:read-image-data-url', path),
  pathExists: (path: string) => ipcRenderer.invoke('fs:path-exists', path),
  statPath: (path: string) => ipcRenderer.invoke('fs:stat', path),
  getPathForFile: (file: unknown): string => {
    try {
      return webUtils.getPathForFile(file as File)
    } catch {
      return ''
    }
  },
  checkWorkspaceFolder: (path: string): Promise<WorkspaceFolderCheckResult> =>
    ipcRenderer.invoke('fs:check-workspace-folder', path),
  detectProjectLogo: (folderPath: string): Promise<ProjectLogo | null> =>
    ipcRenderer.invoke('fs:detect-project-logo', folderPath),
  memoryResolveRoot: (input: { workspaceRoot: string | null; relativeRoot: string | null }): Promise<MemoryRootStatus> =>
    ipcRenderer.invoke('memory:resolve-root', input),
  memoryIndex: (input: { workspaceRoot: string | null; relativeRoot: string | null }): Promise<MemoryGraphIndexResult> =>
    ipcRenderer.invoke('memory:index', input),
  memoryReadPreview: (
    input: { workspaceRoot: string | null; relativeRoot: string | null; relativePath: string }
  ): Promise<MemoryPreviewResult> =>
    ipcRenderer.invoke('memory:read-preview', input),
  logDiagnostic: (input: DiagnosticLogInput): Promise<DiagnosticLogEntry> =>
    ipcRenderer.invoke('diagnostics:log', input),
  openDiagnosticsLogsFolder: (): Promise<{ opened: true; path: string }> =>
    ipcRenderer.invoke('diagnostics:open-logs-folder'),
  diagnosticsGetProcessMetrics: (): Promise<ProcessMetricsSnapshot> =>
    ipcRenderer.invoke('diagnostics:get-process-metrics'),
  diagnosticsOpenWindow: (): Promise<void> =>
    ipcRenderer.invoke('diagnostics:open-window'),
  writefile: (path: string, content: string) => ipcRenderer.invoke('fs:writefile', path, content),
  writeBinaryFile: (path: string, base64Content: string) => ipcRenderer.invoke('fs:write-binary-file', path, base64Content),
  createFile: (parentDir: string, name: string) => ipcRenderer.invoke('fs:create-file', parentDir, name),
  createDir: (parentDir: string, name: string) => ipcRenderer.invoke('fs:create-dir', parentDir, name),
  ensureDir: (parentDir: string, name: string) => ipcRenderer.invoke('fs:ensure-dir', parentDir, name),
  createWorkspaceFolder: (parentDir: string, name: string) =>
    ipcRenderer.invoke('fs:create-workspace-folder', parentDir, name),
  renamePath: (sourcePath: string, nextName: string) => ipcRenderer.invoke('fs:rename', sourcePath, nextName),
  movePath: (sourcePath: string, destinationDir: string) => ipcRenderer.invoke('fs:move', sourcePath, destinationDir),
  copyPath: (sourcePath: string, destinationDir: string) => ipcRenderer.invoke('fs:copy', sourcePath, destinationDir),
  copyPathInto: (sourcePath: string, destinationDir: string, options?: { overwrite?: boolean }) =>
    ipcRenderer.invoke('fs:copy-into', sourcePath, destinationDir, options),
  deletePath: (targetPath: string) => ipcRenderer.invoke('fs:delete', targetPath),
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke('fs:show-item-in-folder', targetPath),
  probeVersionControlProviders: (): Promise<VersionControlProviderProbe[]> =>
    ipcRenderer.invoke('version-control:probe-providers'),
  openHtmlFileInBrowser: (targetPath: string) => ipcRenderer.invoke('fs:open-html-file-in-browser', targetPath),
  listFolderOpenTargets: (): Promise<FolderOpenTargetAvailability[]> =>
    ipcRenderer.invoke('fs:folder-open-targets'),
  openFolderInTarget: (request: FolderOpenRequest): Promise<FolderOpenResult> =>
    ipcRenderer.invoke('fs:open-folder-in-target', request),
  watchPath: async (path: string, cb: (event: FileWatchEvent) => void) => {
    const watchId = await ipcRenderer.invoke('fs:watch-start', path)
    if (!watchId) {
      throw new Error(`Cannot watch missing path: ${path}`)
    }
    const ch = `fs:watch-event:${watchId}`
    const handler = (_: IpcRendererEvent, event: FileWatchEvent) => cb(event)
    ipcRenderer.on(ch, handler)
    return async () => {
      ipcRenderer.removeListener(ch, handler)
      await ipcRenderer.invoke('fs:watch-stop', watchId)
    }
  },
  openDir: () => ipcRenderer.invoke('fs:dialog:opendir'),
  defaultWorkspaceParentDir: () => ipcRenderer.invoke('app:default-workspace-parent'),
  saveFile: (options?: SaveDialogOptions) => ipcRenderer.invoke('fs:dialog:savefile', options),
  openFile: (options?: OpenDialogOptions) => ipcRenderer.invoke('fs:dialog:openfile', options),
  showContextMenu: (items: ContextMenuItem[]) => ipcRenderer.invoke('app:show-context-menu', items),
  showMenubarMenu: (label: string, position?: { x?: number; y?: number }) =>
    ipcRenderer.invoke('app:show-menubar-menu', label, position),
} satisfies Pick<
  ElectronApi,
  | 'readdir'
  | 'searchFiles'
  | 'searchContent'
  | 'cancelContentSearch'
  | 'readfile'
  | 'readImageDataUrl'
  | 'pathExists'
  | 'statPath'
  | 'getPathForFile'
  | 'checkWorkspaceFolder'
  | 'detectProjectLogo'
  | 'memoryResolveRoot'
  | 'memoryIndex'
  | 'memoryReadPreview'
  | 'logDiagnostic'
  | 'openDiagnosticsLogsFolder'
  | 'diagnosticsGetProcessMetrics'
  | 'diagnosticsOpenWindow'
  | 'writefile'
  | 'writeBinaryFile'
  | 'createFile'
  | 'createDir'
  | 'ensureDir'
  | 'createWorkspaceFolder'
  | 'renamePath'
  | 'movePath'
  | 'copyPath'
  | 'copyPathInto'
  | 'deletePath'
  | 'showItemInFolder'
  | 'probeVersionControlProviders'
  | 'openHtmlFileInBrowser'
  | 'listFolderOpenTargets'
  | 'openFolderInTarget'
  | 'watchPath'
  | 'openDir'
  | 'defaultWorkspaceParentDir'
  | 'saveFile'
  | 'openFile'
  | 'showContextMenu'
  | 'showMenubarMenu'
>
