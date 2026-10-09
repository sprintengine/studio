import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { FileSearchEntry, FileSearchResult } from '../../../../../shared/ipc/filesystem'
import { fileMentionCandidates } from './composerContextPicker'
import type { ComposerKeyEvent } from './ComposerField'
import { rememberFileVisit } from '../../../utils/recentFileVisits'
import { installStudioLoopback } from '../../../../../../tests/studio-chat-loopback'

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

test('equally relevant mention matches use file-open recency without overriding shorter paths or leaking timestamps', () => {
  const root = '/Users/dev/recency-project'
  rememberFileVisit(`${root}/ab/app.ts`, 10)
  rememberFileVisit(`${root}/cd/app.ts`, 20)
  rememberFileVisit('/Users/dev/other-project/ab/app.ts', 100)
  expect(fileMentionCandidates(root, [file('ab/app.ts'), file('cd/app.ts'), file('app.ts')], 'app')).toEqual([
    { path: 'app.ts', kind: 'file' },
    { path: 'cd/app.ts', kind: 'file' },
    { path: 'ab/app.ts', kind: 'file' },
  ])
  rememberFileVisit(`${root}/ab/app.ts`, 30)
  expect(fileMentionCandidates(root, [file('cd/app.ts'), file('ab/app.ts')], 'app')[0].path).toBe('ab/app.ts')
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
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
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
    expect(searchFiles).toHaveBeenCalledWith('/Users/dev/project', 'fi', {
      limit: 50,
      purpose: 'mention',
      channel: expect.stringMatching(/^mention:/),
      recentAt: {},
    })
    await act(async () => root.render(createElement(Harness, { query: 'file' })))
    expect(cancelFileSearch).toHaveBeenCalledOnce()
    expect(cancelFileSearch).toHaveBeenCalledWith(expect.stringMatching(/^mention:/))
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
    const key = (name: string, shiftKey = false) =>
      ({
        key: name,
        shiftKey,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }) as unknown as ComposerKeyEvent
    const select = vi.fn(() => true)
    const move = vi.fn(() => true)
    picker.pickerRef.current = { pickActive: select, moveSelection: move, matchCount: () => 1 }
    await act(async () => {
      expect(picker.handleKeyDown(key('ArrowDown'))).toBe(true)
      expect(picker.handleKeyDown(key('Tab'))).toBe(true)
    })
    expect(move).toHaveBeenCalledWith(1)
    expect(select).toHaveBeenCalledOnce()
    // Shift+Enter is a newline even with a highlighted result.
    expect(picker.handleKeyDown(key('Enter', true))).toBe(false)
    expect(select).toHaveBeenCalledOnce()
    // With nothing highlighted (no match yet, or the search still debouncing)
    // Enter sends, Tab moves focus and arrows move the caret.
    picker.pickerRef.current = { pickActive: select, moveSelection: move, matchCount: () => 0 }
    for (const name of ['Enter', 'Tab', 'ArrowUp', 'ArrowDown']) expect(picker.handleKeyDown(key(name))).toBe(false)
    expect(select).toHaveBeenCalledOnce()
    expect(move).toHaveBeenCalledOnce()
    picker.pickerRef.current = { pickActive: select, moveSelection: move, matchCount: () => 1 }
    await act(async () => {
      expect(picker.handleKeyDown(key('Escape'))).toBe(true)
    })
    expect(picker.trigger).toBeNull()
    await act(async () => root.render(createElement(Harness, { query: 'file', draft: '@file' })))
    expect(picker.trigger).toBeNull()
    // Esc holds while the person goes on typing into the same token…
    await act(async () => root.render(createElement(Harness, { query: null, draft: '@files' })))
    expect(picker.trigger).toBeNull()
    // …and a new token opens the picker again.
    await act(async () => root.render(createElement(Harness, { query: null, draft: '@files @x' })))
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

// ── The `/` command menu, driven through the hook the chat view uses ─────────

type CommandMenuInput = NonNullable<
  Parameters<typeof import('./composerContextPicker').useComposerContextPicker>[0]['commandMenu']
>

const COMMANDS: CommandMenuInput['commands'] = [
  { name: 'model', description: 'Choose the model', source: 'app' },
  { name: 'compact', description: 'Summarize the conversation', argumentHint: '[instructions]', source: 'cli' },
  { name: 'review', description: 'Review a pull request', argumentHint: '[pr-number]', source: 'custom' },
  { name: 'deploy', description: 'Ship the current branch', source: 'skill' },
]

async function mountCommandPicker() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  Object.assign(dom.window, { api: { workspaceSkillsList: async () => ({ ok: true, skills: [] }) } })
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useComposerContextPicker } = await import('./composerContextPicker')
  const onPickCommand = vi.fn()
  const onOpen = vi.fn()
  let picker!: ReturnType<typeof useComposerContextPicker>
  const status = { cliLabel: 'Claude Code', loading: false, answered: true, reportedCount: 2 }
  function Harness({ draft, commands = true }: { draft: string; commands?: boolean }) {
    picker = useComposerContextPicker({
      workspaceRoot: '/Users/dev/project',
      draft,
      caret: draft.length,
      skillsEnabled: true,
      commandMenu: commands ? { commands: COMMANDS, status, onOpen } : null,
      onPickSkill: () => undefined,
      onPickMention: () => undefined,
      onPickCommand,
    })
    return picker.picker
  }
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const render = (draft: string, commands = true) =>
    act(async () => root.render(createElement(Harness, { draft, commands })))
  const key = async (name: string, shiftKey = false) => {
    const event = {
      key: name,
      shiftKey,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as ComposerKeyEvent
    let handled = false
    await act(async () => {
      handled = picker.handleKeyDown(event)
    })
    return handled
  }
  const options = () => Array.from(dom.window.document.querySelectorAll('[role="option"]'))
  const highlighted = () => dom.window.document.querySelector('[role="option"][aria-selected="true"]')
  return {
    dom,
    picker: () => picker,
    render,
    key,
    options,
    highlighted,
    onPickCommand,
    onOpen,
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const name of Object.keys(globals)) {
        if (previous[name]) Object.defineProperty(globalThis, name, previous[name])
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

test('/ opens the command menu where the chat has one, and stays literal where it does not', async () => {
  const menu = await mountCommandPicker()
  try {
    await menu.render('/')
    expect(menu.picker().trigger?.kind).toBe('slash')
    expect(menu.options().map((row) => row.textContent)).toEqual([
      expect.stringContaining('/model'),
      expect.stringContaining('/compact'),
      expect.stringContaining('/review'),
      expect.stringContaining('/deploy'),
    ])
    expect(menu.onOpen).toHaveBeenCalledOnce()
    await menu.render('/', false)
    expect(menu.picker().trigger).toBeNull()
    expect(menu.options()).toHaveLength(0)
    expect(menu.picker().comboboxProps).toEqual({})
  } finally {
    await menu.unmount()
  }
})

test('$ still opens the skill picker, and the command menu names it in its footer', async () => {
  const menu = await mountCommandPicker()
  try {
    await menu.render('/')
    expect(menu.dom.window.document.body.textContent).toContain('$ for Studio skills')
    await menu.render('please use $rev')
    expect(menu.picker().trigger?.kind).toBe('skill')
    expect(menu.dom.window.document.querySelector('[role="menu"][aria-label="Use a skill"]')).not.toBeNull()
    expect(menu.options()).toHaveLength(0)
  } finally {
    await menu.unmount()
  }
})

test('arrows wrap around the command list', async () => {
  const menu = await mountCommandPicker()
  try {
    await menu.render('/')
    expect(menu.highlighted()?.textContent).toContain('/model')
    expect(await menu.key('ArrowUp')).toBe(true)
    expect(menu.highlighted()?.textContent).toContain('/deploy')
    expect(await menu.key('ArrowDown')).toBe(true)
    expect(menu.highlighted()?.textContent).toContain('/model')
    expect(await menu.key('ArrowDown')).toBe(true)
    expect(menu.highlighted()?.textContent).toContain('/compact')
  } finally {
    await menu.unmount()
  }
})

test('Enter and Tab pick the highlighted command, for the token under the caret', async () => {
  const menu = await mountCommandPicker()
  try {
    await menu.render('  /co')
    expect(await menu.key('Enter')).toBe(true)
    expect(menu.onPickCommand).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'compact' }), {
      start: 2,
      end: 5,
    })
    await menu.render('/r')
    expect(await menu.key('Tab')).toBe(true)
    expect(menu.onPickCommand).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'review' }), {
      start: 0,
      end: 2,
    })
    // Shift+Enter is a newline even with the menu open.
    expect(await menu.key('Enter', true)).toBe(false)
    expect(menu.onPickCommand).toHaveBeenCalledTimes(2)
  } finally {
    await menu.unmount()
  }
})

test('with no command matching, Enter falls through and the message is sent as typed', async () => {
  const menu = await mountCommandPicker()
  try {
    await menu.render('/zzz')
    expect(menu.picker().trigger?.kind).toBe('slash')
    expect(menu.options()).toHaveLength(0)
    expect(menu.dom.window.document.body.textContent).toContain('No command matches “/zzz”')
    for (const name of ['Enter', 'Tab', 'ArrowUp', 'ArrowDown']) expect(await menu.key(name)).toBe(false)
    expect(menu.onPickCommand).not.toHaveBeenCalled()
  } finally {
    await menu.unmount()
  }
})

test('Esc closes the menu until the caret leaves that token', async () => {
  const menu = await mountCommandPicker()
  try {
    await menu.render('/re')
    expect(await menu.key('Escape')).toBe(true)
    expect(menu.picker().trigger).toBeNull()
    await menu.render('/rev')
    expect(menu.picker().trigger, 'typing on into the same token keeps it shut').toBeNull()
    // A fresh `/` in a new token opens the menu again, on a later line too…
    await menu.render('/rev\n/')
    expect(menu.picker().trigger?.kind).toBe('slash')
    // …and so does one where the dismissed token was, once it is gone.
    await menu.render('')
    await menu.render('/')
    expect(menu.picker().trigger?.kind).toBe('slash')
    expect(menu.options().length).toBeGreaterThan(0)
  } finally {
    await menu.unmount()
  }
})

test('the field is the combobox for the command list', async () => {
  const menu = await mountCommandPicker()
  try {
    await menu.render('hello')
    expect(menu.picker().comboboxProps).toMatchObject({ role: 'combobox', 'aria-expanded': false })
    expect(menu.picker().comboboxProps['aria-controls']).toBeUndefined()
    await menu.render('/')
    await menu.key('ArrowDown')
    const props = menu.picker().comboboxProps
    expect(props['aria-expanded']).toBe(true)
    const listbox = menu.dom.window.document.getElementById(props['aria-controls']!)
    expect(listbox?.getAttribute('role')).toBe('listbox')
    expect(props['aria-activedescendant']).toBe(menu.highlighted()?.id)
    expect(menu.highlighted()?.textContent).toContain('/compact')
    await menu.render('/zzz')
    expect(menu.picker().comboboxProps['aria-activedescendant']).toBeUndefined()
  } finally {
    await menu.unmount()
  }
})

test('the command and skill lists stay open past the frame after they open', async () => {
  // The popover shell closes a surface whose anchor sits in a hidden subtree,
  // checked on the frame after any attribute change under <body> — which its
  // own positioning makes at once.
  const menu = await mountCommandPicker()
  const nextFrames = () =>
    new Promise<void>((resolve) => menu.dom.window.requestAnimationFrame(() => setTimeout(resolve, 20)))
  try {
    await menu.render('/')
    menu.dom.window.document.body.setAttribute('class', 'probe-1')
    await nextFrames()
    await menu.render('/')
    expect(menu.picker().trigger?.kind).toBe('slash')
    expect(menu.options().length).toBeGreaterThan(0)
    await menu.render('$')
    menu.dom.window.document.body.setAttribute('class', 'probe-2')
    await nextFrames()
    await menu.render('$')
    expect(menu.picker().trigger?.kind).toBe('skill')
    expect(menu.dom.window.document.querySelector('[aria-label="Use a skill"]')).not.toBeNull()
  } finally {
    await menu.unmount()
  }
})

test('a / after text opens the menu, on a later line or after a space, but not inside a word or path', async () => {
  const menu = await mountCommandPicker()
  try {
    for (const draft of ['A paragraph of context.\n/', 'some text /', 'some text /dep']) {
      await menu.render(draft)
      expect(menu.picker().trigger?.kind, draft).toBe('slash')
      expect(menu.options().length, draft).toBeGreaterThan(0)
    }
    for (const draft of ['and/or', 'see src/foo', 'see https://example.com/', 'a/b']) {
      await menu.render(draft)
      expect(menu.picker().trigger, draft).toBeNull()
      expect(menu.options(), draft).toHaveLength(0)
    }
  } finally {
    await menu.unmount()
  }
})

test('later in the message the menu lists what works there, and a pick replaces just the token', async () => {
  const menu = await mountCommandPicker()
  try {
    // The CLI's built-ins and custom commands run only as the first word, so
    // they are left out; Studio's own and the skills stay.
    await menu.render('Fix the flaky test.\n/')
    expect(menu.options().map((row) => row.textContent)).toEqual([
      expect.stringContaining('/model'),
      expect.stringContaining('/deploy'),
    ])
    await menu.render('Fix the flaky test, then /dep')
    expect(await menu.key('Enter')).toBe(true)
    expect(menu.onPickCommand).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'deploy' }), {
      start: 25,
      end: 29,
    })
    // At the start of the draft every row is offered again.
    await menu.render('/')
    expect(menu.options()).toHaveLength(COMMANDS.length)
    // Esc closes it mid-message as it does at the start.
    await menu.render('then /')
    expect(await menu.key('Escape')).toBe(true)
    expect(menu.picker().trigger).toBeNull()
  } finally {
    await menu.unmount()
  }
})
