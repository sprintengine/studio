import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { FileSearchEntry, FileSearchResult } from '../../../../../shared/ipc/filesystem'
import { fileMentionCandidates } from './composerContextPicker'

const file = (path: string): FileSearchEntry => ({
  path,
  name: path.split('/').at(-1)!,
  parentPath: path.slice(0, path.lastIndexOf('/')),
  isDir: false,
})

test('mention candidates include confined parent folders and rank exact basenames first', () => {
  expect(
    fileMentionCandidates(
      '/Users/dev/project',
      [
        file('/Users/dev/project/src/app/main.ts'),
        file('/Users/dev/project/src/app.ts'),
        file('/Users/dev/elsewhere/private.ts'),
        file('../escape.ts'),
      ],
      'app',
    ),
  ).toEqual([
    { path: 'src/app', kind: 'folder' },
    { path: 'src/app.ts', kind: 'file' },
    { path: 'src/app/main.ts', kind: 'file' },
  ])
  expect(fileMentionCandidates('C:\\project', [file('C:\\project\\src\\app.ts')], 'app')).toEqual([
    { path: 'src/app.ts', kind: 'file' },
  ])
  expect(
    fileMentionCandidates('/Users/dev/project', [{ ...file('/Users/dev/project/empty'), isDir: true }], 'empty'),
  ).toEqual([{ path: 'empty', kind: 'folder' }])
  expect(
    fileMentionCandidates(
      '/Users/dev/project',
      Array.from({ length: 70 }, (_, index) => file(`file-${index}.ts`)),
      'file',
    ),
  ).toHaveLength(50)
})

test('file search debounces, cancels obsolete work and rejects stale results', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  vi.useFakeTimers()
  const pending: ((value: FileSearchResult) => void)[] = []
  const searchFiles = vi.fn(() => new Promise<FileSearchResult>((resolve) => pending.push(resolve)))
  const cancelFileSearch = vi.fn(async () => undefined)
  Object.assign(dom.window, { api: { searchFiles, cancelFileSearch } })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useFileMentionSearch, useComposerContextPicker } = await import('./composerContextPicker')
  let search!: ReturnType<typeof useFileMentionSearch>
  let picker!: ReturnType<typeof useComposerContextPicker>
  function Harness({
    query,
    draft = '@file',
    enabled = true,
  }: {
    query: string | null
    draft?: string
    enabled?: boolean
  }) {
    search = useFileMentionSearch('/Users/dev/project', query)
    picker = useComposerContextPicker({
      workspaceRoot: '/Users/dev/project',
      draft,
      caret: draft.length,
      skillsEnabled: enabled,
      onPickSkill: () => undefined,
      onPickMention: () => undefined,
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Harness, { query: 'fi' })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119)
    })
    expect(searchFiles).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(searchFiles).toHaveBeenCalledWith('/Users/dev/project', 'fi', { limit: 50, purpose: 'mention' })
    await act(async () => root.render(createElement(Harness, { query: 'file' })))
    expect(cancelFileSearch).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120)
    })
    await act(async () => {
      pending[0]({
        ok: true,
        results: [file('stale.ts')],
        truncated: false,
        engine: 'ripgrep',
        elapsedMs: 0,
        resultCount: 1,
      })
      pending[1]({
        ok: true,
        results: [file('file.ts')],
        truncated: false,
        engine: 'ripgrep',
        elapsedMs: 0,
        resultCount: 1,
      })
    })
    expect(search.rows).toEqual([{ path: 'file.ts', kind: 'file' }])
    const key = (name: string) =>
      ({
        key: name,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }) as unknown as React.KeyboardEvent<HTMLTextAreaElement>
    const select = vi.fn(() => true)
    const move = vi.fn(() => true)
    picker.pickerRef.current = { pickActive: select, moveSelection: move, matchCount: () => 1 }
    await act(async () => {
      expect(picker.handleKeyDown(key('ArrowDown'))).toBe(true)
      expect(picker.handleKeyDown(key('Tab'))).toBe(true)
    })
    expect(move).toHaveBeenCalledWith(1)
    expect(select).toHaveBeenCalledOnce()
    await act(async () => {
      expect(picker.handleKeyDown(key('Escape'))).toBe(true)
    })
    expect(picker.trigger).toBeNull()
    await act(async () => root.render(createElement(Harness, { query: 'file', draft: '@file' })))
    expect(picker.trigger).toBeNull()
    await act(async () => root.render(createElement(Harness, { query: null, draft: '@files' })))
    expect(picker.trigger?.kind).toBe('mention')
    await act(async () => root.render(createElement(Harness, { query: null, draft: '$review', enabled: false })))
    expect(picker.trigger).toBeNull()
    expect(picker.picker).toBeNull()
    await act(async () => root.render(createElement(Harness, { query: null, draft: '$review', enabled: true })))
    expect(picker.trigger?.kind).toBe('skill')
    expect(picker.handleKeyDown(key('Backspace'))).toBe(false)
    expect(cancelFileSearch).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
