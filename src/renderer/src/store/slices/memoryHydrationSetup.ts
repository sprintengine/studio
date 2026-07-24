const storage = new Map<string, string>()

const fakeLocalStorage = {
  getItem(key: string): string | null {
    return storage.has(key) ? storage.get(key)! : null
  },
  setItem(key: string, value: string): void {
    storage.set(key, value)
  },
  removeItem(key: string): void {
    storage.delete(key)
  },
  clear(): void {
    storage.clear()
  },
  key(index: number): string | null {
    return Array.from(storage.keys())[index] ?? null
  },
  get length(): number {
    return storage.size
  },
}

const seededWorkspace = {
  id: 'ws-hydrate-1',
  name: 'Hydration Fixture',
  mode: 'standard',
  folderPath: '/tmp/multicode-hydration-fixture',
  templateId: 'standard',
  layoutModel: {
    global: {},
    borders: [],
    layout: { type: 'row', weight: 100, children: [] },
  },
  agents: {},
  worktreeState: { entries: [], lastSyncedAt: null },
  memory: {
    relativeRoot: null,
    graphSettings: null,
  },
  editorState: { openFiles: [], activeFilePath: null },
  sprintEngineState: null,
  sprintEngineAutoState: {
    desiredMode: 'manual',
    runtimeState: 'idle',
    notificationsDelivered: {},
  },
  createdAt: 1_700_000_000_000,
}

const seededEnvelope = {
  state: {
    appSettings: undefined,
    sidebarCollapsed: false,
    workspaces: [seededWorkspace],
    activeWorkspaceId: seededWorkspace.id,
  },
  version: 44,
}

storage.set('multicode-workspaces', JSON.stringify(seededEnvelope))

const fakeWindow = {
  localStorage: fakeLocalStorage,
  api: undefined,
}
;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
;(globalThis as unknown as { localStorage: typeof fakeLocalStorage }).localStorage = fakeLocalStorage

export const hydrationStorage = storage
export const hydrationWorkspaceId = seededWorkspace.id
export { seededEnvelope }
