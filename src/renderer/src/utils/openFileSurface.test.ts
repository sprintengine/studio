import { beforeEach, expect, test, vi } from 'vitest'

const spies = vi.hoisted(() => ({
  external: vi.fn(),
  tab: vi.fn(),
  focus: vi.fn(),
  landing: vi.fn(),
  store: { openFilesInExternalWindow: true, openFile: vi.fn() },
}))
vi.mock('../store/workspaceStore', () => ({ useWorkspaceStore: { getState: () => spies.store } }))
vi.mock('./modelRegistry', () => ({ focusOrAddFileTab: spies.tab }))
vi.mock('./editorFocus', () => ({ dispatchEditorFocusEvent: spies.focus }))
vi.mock('./agentEditorReveal', () => ({ queueEditorLanding: spies.landing }))
vi.mock('../components/auxWindows/openFileWindow', () => ({ openExternalFileWindow: spies.external }))
import { openFileSurface } from './openFileSurface'
import { recentFileVisit, workspaceFileVisits } from './recentFileVisits'

const file = { workspaceId: 'workspace', path: '/workspace/src/example.ts', name: 'example.ts' }
beforeEach(() => {
  vi.clearAllMocks()
  spies.store.openFilesInExternalWindow = true
})
test('line and column hints reach the separate editor window', () => {
  openFileSurface({ ...file, lineNumber: 14, column: 3 })
  expect(spies.external).toHaveBeenCalledWith(expect.objectContaining({ range: { startLine: 14, startColumn: 3 } }))
  expect(spies.tab).not.toHaveBeenCalled()
})
test('an explicit reveal range stays authoritative over a point hint', () => {
  const range = { startLine: 2, endLine: 5 }
  openFileSurface({ ...file, lineNumber: 14, range, takeFocus: false, background: true })
  expect(spies.external).toHaveBeenCalledWith(expect.objectContaining({ range, takeFocus: false, background: true }))
})
test('inline editor routing retains the existing focus event', () => {
  spies.store.openFilesInExternalWindow = false
  openFileSurface({ ...file, lineNumber: 14, column: 3 })
  expect(spies.focus).toHaveBeenCalledWith({ workspaceId: file.workspaceId, filePath: file.path, line: 14, column: 3 })
  expect(spies.external).not.toHaveBeenCalled()
})

test('ordinary editor opens record recency while background reveals do not', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  try {
    const path = '/workspace/recency/opened.ts'
    spies.store.openFilesInExternalWindow = false
    openFileSurface({ ...file, path })
    expect(recentFileVisit(path)).toBe(100)
    clock.mockReturnValue(200)
    spies.store.openFilesInExternalWindow = true
    openFileSurface({ ...file, path })
    expect(recentFileVisit(path)).toBe(200)
    clock.mockReturnValue(300)
    openFileSurface({ ...file, path, background: true })
    openFileSurface({ ...file, path, takeFocus: false })
    expect(recentFileVisit(path)).toBe(200)
    expect(workspaceFileVisits('/workspace/recency')).toEqual({ 'opened.ts': 200 })
    expect(workspaceFileVisits('/workspace/other')).toEqual({})
  } finally {
    clock.mockRestore()
  }
})
