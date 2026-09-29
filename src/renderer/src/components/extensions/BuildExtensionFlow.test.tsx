import assert from 'node:assert/strict'

// "Build your own extension", mounted: the plate on the Extensions home opens
// it (and so does a latched palette request), a template and a name lead to a
// folder main hands out and an agent that runs as a chat, the machine's
// readiness holds Create when a required tool is missing, and Create scaffolds
// the project and opens it in a chat with the skill and the brief.
//
// The preload boundary is stubbed; the store, the picker and the page are real.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { test } from 'vitest'

import type {
  ExtensionScaffoldCheck,
  ExtensionScaffoldCreateInput,
  ExtensionTemplateSummary,
} from '../../../../shared/extension-scaffold'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { BuildExtensionFlow } from './BuildExtensionFlow'
import ExtensionsHomeSurface from './ExtensionsHomeSurface'
import { requestBuildExtensionFlow, setBuildExtensionHost, type BuildExtensionChatLaunch } from './buildExtensionHost'

test('BuildExtensionFlow', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.CustomEvent = dom.window.CustomEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  anyGlobal.ResizeObserver = FakeResizeObserver
  domWindow.ResizeObserver = FakeResizeObserver
  // React evaluated before these globals existed and uses its IE input polyfill;
  // see ExtensionsHomeSurface.test.tsx for why these two no-ops are needed.
  const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto.attachEvent = () => {}
  proto.detachEvent = () => {}
  dom.window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia

  const TEMPLATES: ExtensionTemplateSummary[] = [
    {
      id: 'blank',
      title: 'Blank',
      summary: 'A command in the palette and nothing else.',
      permissions: [],
      capabilities: ['command'],
    },
    {
      id: 'panel',
      title: 'Panel',
      summary: 'A notes panel in a workspace of its own.',
      permissions: ['storage'],
      capabilities: ['panel'],
    },
  ]
  const ready = (overrides: Partial<Record<string, ExtensionScaffoldCheck['status']>> = {}) =>
    (
      [
        ['node', 'Node.js', true],
        ['npm', 'npm', true],
        ['git', 'git', false],
        ['agent', 'Claude Code', true],
      ] as const
    ).map(([id, label, required]): ExtensionScaffoldCheck => ({
      id,
      label,
      required,
      status: overrides[id] ?? 'ok',
      detail: overrides[id] === 'missing' ? `${label} is not on your PATH.` : 'fine',
    }))

  let checkAnswer = ready()
  const checkCalls: unknown[] = []
  const creates: ExtensionScaffoldCreateInput[] = []
  domWindow.api = {
    extensionScaffoldTemplates: async () => TEMPLATES,
    extensionScaffoldCheck: async (input: unknown) => {
      checkCalls.push(input)
      return checkAnswer
    },
    extensionScaffoldPickFolder: async () => ({ path: '/Users/dev/code', token: 'token-1' }),
    extensionScaffoldCreate: async (input: ExtensionScaffoldCreateInput) => {
      creates.push(input)
      return { ok: true, folder: `${input.parentDir}/${input.id}`, files: ['package.json'] }
    },
    studioAreaSkillsGet: async () => ({ enabled: [], dismissed: [] }),
    onStudioAreaSkillsChanged: () => () => {},
  }
  const launches: BuildExtensionChatLaunch[] = []
  setBuildExtensionHost({ openChat: (launch) => launches.push(launch) })

  act(() => {
    useWorkspaceStore.setState((state) => ({
      appSettings: { ...state.appSettings, lastSelectedCli: 'claude-code' },
      pluginCatalogEntries: [
        { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' },
        { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' },
        { id: 'gemini', displayName: 'Gemini', source: 'bundled', version: 1, binary: 'gemini' },
      ] as never,
      pluginCatalogStatus: 'ready' as never,
    }))
  })

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })
  }
  function mount(element: React.ReactElement): { host: HTMLElement; unmount: () => void } {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host as unknown as Element)
    act(() => root.render(element))
    return {
      host,
      unmount: () => {
        act(() => root.unmount())
        host.remove()
      },
    }
  }
  const body = dom.window.document.body
  const buttons = () => [...body.querySelectorAll('button')] as HTMLButtonElement[]
  const button = (text: string) => buttons().find((candidate) => candidate.textContent?.trim().startsWith(text))
  const dialog = () => body.querySelector('[role="dialog"][aria-modal="true"]')
  const type = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    // Focus, set, keyup: React DOM runs its change-event polyfill here (see
    // ExtensionsHomeSurface.test.tsx), which notices a value on keyup.
    act(() => {
      input.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
      setter.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      input.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }))
    })
  }
  const labelled = (label: string) => {
    const element = [...body.querySelectorAll('label')].find((candidate) => candidate.textContent?.startsWith(label))
    return element ? (body.querySelector(`#${CSS.escape(element.htmlFor)}`) as HTMLInputElement | null) : null
  }
  anyGlobal.CSS = { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) }

  // ── The whole way through ────────────────────────────────────────────────────
  let closed = 0
  const flow = mount(<BuildExtensionFlow open onClose={() => (closed += 1)} />)
  await flush()
  assert.ok(dialog(), 'the flow is a dialog')
  assert.ok(button('Panel'), 'the templates are the starting points')
  assert.match(button('Panel')!.textContent ?? '', /Asks for storage/)
  assert.match(button('Blank')!.textContent ?? '', /Asks for no permissions/)
  assert.equal(button('Next')?.disabled, true, 'nothing is chosen yet')

  act(() => button('Panel')!.click())
  assert.equal(button('Panel')!.getAttribute('aria-pressed'), 'true')
  act(() => button('Next')!.click())
  await flush()

  assert.deepEqual(checkCalls, [{ cli: 'claude-code' }], 'the machine is checked for the remembered chat agent')
  assert.match(body.textContent ?? '', /Claude Code/)
  type(labelled('Name')!, 'Focus notes')
  assert.equal(labelled('Id')!.value, 'focus-notes', 'the id follows the name until it is edited')
  assert.equal(button('Create and open chat')?.disabled, true)
  assert.match(body.textContent ?? '', /Choose where the project goes\./)

  act(() => button('Choose folder')!.click())
  await flush()
  assert.match(body.textContent ?? '', /\/Users\/dev\/code\/focus-notes/)
  assert.equal(button('Create and open chat')?.disabled, false)

  act(() => button('Create and open chat')!.click())
  await flush()
  assert.equal(creates.length, 1)
  assert.deepEqual(
    { ...creates[0], ideaMarkdown: undefined },
    {
      templateId: 'panel',
      id: 'focus-notes',
      displayName: 'Focus notes',
      parentDir: '/Users/dev/code',
      parentDirToken: 'token-1',
      ideaMarkdown: undefined,
    },
  )
  assert.match(creates[0]!.ideaMarkdown ?? '', /^# Focus notes\n\nStarted from the \*\*Panel\*\* template/)
  assert.equal(launches.length, 1)
  const launch = launches[0]!
  assert.equal(launch.folder, '/Users/dev/code/focus-notes')
  assert.deepEqual(launch.confirm.provider, {
    providerId: 'claude-agent',
    modelId: 'default',
    modelLabel: 'Claude Code',
  })
  assert.equal(launch.confirm.cli, 'claude-code')
  assert.deepEqual(launch.confirm.skills, [{ id: 'sprintengine-extension-builder' }])
  assert.match(
    launch.prompt,
    /^Use the sprintengine-extension-builder skill\. We're building "Focus notes" \(A notes panel in a workspace of its own\); the brief is in IDEA\.md\./,
  )
  assert.equal(closed, 1, 'the flow closes onto the chat')
  flow.unmount()

  // ── A machine that cannot build it yet ──────────────────────────────────────
  checkAnswer = ready({ node: 'missing', git: 'missing' })
  const blocked = mount(<BuildExtensionFlow open onClose={() => {}} />)
  await flush()
  act(() => button('Blank')!.click())
  act(() => button('Next')!.click())
  await flush()
  type(labelled('Name')!, 'Pomodoro')
  act(() => button('Choose folder')!.click())
  await flush()
  assert.equal(button('Create and open chat')?.disabled, true, 'a missing Node.js holds Create')
  assert.match(body.textContent ?? '', /Node\.js: Node\.js is not on your PATH\./)
  assert.match(body.textContent ?? '', /Optional/, 'a missing git is said, and only recommended')
  checkAnswer = ready({ git: 'missing' })
  act(() => button('Check again')!.click())
  await flush()
  assert.equal(button('Create and open chat')?.disabled, false, 'git alone does not hold it')

  // The agent picker offers only the CLIs that run as a chat.
  act(() => button('Claude Code')!.click())
  await flush()
  // The picker's CLI rail names each runtime; the chat roster leaves out the
  // ones with no chat runtime.
  const popover = body.querySelector('[aria-label="Agents that run as a chat"]')?.closest('[role="dialog"]')
  assert.ok(popover, 'the picker opens')
  assert.match(popover.outerHTML, /Codex/)
  assert.doesNotMatch(popover.outerHTML, /Gemini/)
  blocked.unmount()

  // ── The plate on the home, and a request from the palette ───────────────────
  const home = mount(<ExtensionsHomeSurface />)
  await flush()
  assert.equal(dialog(), null)
  act(() => button('Build your own extension')!.click())
  await flush()
  assert.ok(dialog(), 'the plate opens the flow')
  home.unmount()

  requestBuildExtensionFlow()
  const cold = mount(<ExtensionsHomeSurface />)
  await flush()
  assert.ok(dialog(), 'a request made before the home was up opens the flow when it mounts')
  cold.unmount()

  setBuildExtensionHost(null)
})
