import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('NewAgentPanel interaction', async () => {
  // The launch surface behind the tab strip's "+". Rendered for real,
  // because the acceptance is about what a person sees and presses:
  //
  //   1. the row shows what a launch usually changes — the engine and its
  //      access — while how it starts and what it starts with are behind the
  //      "+", and where it runs is on the strip under the box;
  //   2. the invocation main renders rides Start's hover, not a line of chrome;
  //   3. Start hands the host a confirm plus the typed prompt — and creates
  //      nothing itself;
  //   4. a suggestion card spawns on click, carrying its own full prompt;
  //   5. the skill trigger is the CLI's declared one, and a CLI that declares
  //      none still gets the Skills & MCPs picker, which every launch has;
  //   6. there is no greeting, signed in or not;
  //   7. with no agent CLI installed the surface offers the install route rather
  //      than controls that would fail on click.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.FileReader = dom.window.FileReader
  anyGlobal.File = dom.window.File
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = ResizeObserverStub
  ;(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {}
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  anyGlobal.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0)
  anyGlobal.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)

  // What main answers for a preview. The real handler renders through the spawn's
  // own argv renderer; here it stands in so the test can assert the surface SHOWS
  // what main said, verbatim, rather than composing a line of its own.
  const previewCalls: Array<Record<string, unknown>> = []
  const PREVIEW_DISPLAY = 'claude --model claude-opus-5'

  // The mesh the remote-machine tests drive (remote-sessions-ux /
  // new-chat-on-a-remote-machine). Reassigned per check.
  let meshConnections: Array<Record<string, unknown>> = []
  let meshBrowseAnswer: (connectionId: string) => Record<string, unknown> = () => ({
    connectionId: 'c',
    reachable: true,
    unreachableReason: null,
    unauthorized: false,
    scopes: [],
    workspaces: [],
    gaps: [],
  })

  // Which repository a local folder is (one-project-across-machines); null = no remote.
  let localIdentityAnswer: (folderPath: string) => Record<string, unknown> | null = () => null
  // The picked remote project's checkout facts (checkout-and-branch-on-remote-create).
  let meshCheckoutAnswer: (connectionId: string, workspaceId: string) => Record<string, unknown> = (
    _c,
    workspaceId,
  ) => ({
    ok: true,
    checkout: {
      workspaceId,
      git: true,
      branch: 'main',
      defaultBranch: 'main',
      branches: [{ name: 'main', current: true }],
      worktrees: [],
    },
  })

  // This computer's machines (Settings ▸ Machines). Empty reads as one
  // machine, which is every platform but a Windows with WSL turned on.
  let hostsAnswer: { hosts: Array<Record<string, unknown>>; wsl: unknown } = { hosts: [], wsl: null }
  const detectCalls: unknown[] = []
  // The CLIs a WSL machine's detection finds there.
  const claudeOnly = {
    'claude-code': { cli: 'claude-code', installed: true, resolvedPath: '/usr/bin/claude', version: '1' },
  }
  let detectAnswer: Record<string, unknown> = claudeOnly

  ;(dom.window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'darwin',
    hostsList: async () => hostsAnswer,
    onHostsChanged: () => () => {},
    pluginsDetectAvailability: async (input: unknown) => {
      detectCalls.push(input)
      return { ok: true, availability: detectAnswer }
    },
    getGitRepoRoot: async () => '/proj',
    meshListConnections: async () => meshConnections,
    meshBrowse: async (connectionId: string) => meshBrowseAnswer(connectionId),
    meshWorkspaceCheckout: async (connectionId: string, workspaceId: string) =>
      meshCheckoutAnswer(connectionId, workspaceId),
    getGitRepositoryIdentity: async (folderPath: string) => localIdentityAnswer(folderPath),
    onMeshEvent: () => () => {},
    defaultWorkspaceParentDir: async () => '/w',
    getPathForFile: () => '/tmp/shot.png',
    saveDroppedImage: async () => '/tmp/shot.png',
    agentLaunchPreview: async (input: Record<string, unknown>) => {
      previewCalls.push(input)
      return {
        ok: true,
        preview: { binary: 'claude', args: PREVIEW_DISPLAY.split(' ').slice(1), display: PREVIEW_DISPLAY },
      }
    },
    // The skill type-ahead reads the picker's inventory; an empty one is enough
    // to prove the trigger opens (and keeps this test off the capability service).
    agentCapabilities: async () => ({
      ok: true,
      support: 'native',
      harnessId: 'claude',
      skills: [{ id: 'backlog', name: 'backlog', description: 'Work a backlog item end to end', source: 'builtin' }],
      diagnostics: [],
    }),
    builtinSkillsList: async () => [
      {
        id: 'backlog',
        name: 'backlog',
        version: '1',
        description: 'Work a backlog item end to end',
        targetPolicy: 'all-native',
      },
      {
        id: 'design-system',
        name: 'design-system',
        version: '1',
        description: 'Build UI from the attached design system',
        targetPolicy: 'all-native',
      },
    ],
    workspaceSkillsList: async () => ({ ok: true, skills: [] }),
    // The Skills & MCPs picker's install-on-pick and add-on-pick paths.
    agentSkillAttach: async (input: Record<string, unknown>) => {
      attachCalls.push(input)
      return { ok: true, skillId: input.skillId, targets: [{ path: '.claude/skills/x', status: 'installed' }] }
    },
    mcpSync: async (input: Record<string, unknown>) => {
      syncCalls.push(input)
      if (syncFailure) return { ok: false, message: syncFailure }
      const settings = input.settings as { servers: Record<string, unknown> }
      return {
        ok: true,
        targets: [{ client: 'claude-code', path: '/proj/.mcp.json', serverIds: Object.keys(settings.servers) }],
        issues: [],
      }
    },
  }
  // The MCP server these checks pick. It is INSTALLED — since the third-party
  // retirement (2026-09-08) there is no catalogue to offer one from, so
  // the picker's rows are the workspace's own servers and nothing else. Its
  // `clients` deliberately do NOT include the launch CLI, because that is what
  // still makes picking it a real write: the pick adds the CLI and syncs the
  // workspace config before the server counts as picked.
  const LINEAR = {
    id: 'linear',
    name: 'Linear',
    description: 'Issues and projects',
    transport: 'http' as const,
    url: 'https://mcp.linear.app/sse',
    enabled: true,
    required: false,
    clients: ['codex'],
    scope: 'workspace' as const,
    source: 'custom' as const,
    riskLevel: 'network' as const,
  }

  const attachCalls: Array<Record<string, unknown>> = []
  const syncCalls: Array<Record<string, unknown>> = []
  let syncFailure: string | null = null

  async function main(): Promise<void> {
    const React = (await import('react')).default
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const NewAgentPanel = (await import('./NewAgentPanel')).default
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const { __resetCliPermissionPresetsForTest } = await import('../../ui/cliPermissionPresets')

    let failures = 0
    // Every mounted harness, so a check that throws before its own unmount
    // cannot leave a stale panel (and its open popovers) in the document for
    // the next check to query.
    const liveViews = new Set<{ unmount: () => void }>()
    const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      } finally {
        for (const view of [...liveViews]) view.unmount()
      }
    }

    const seedStore = (options: { plugins?: unknown[] } = {}): void => {
      // Permissions are remembered per CLI, in the store's launch-settings read
      // model, which would otherwise carry a preset from one check into the next.
      __resetCliPermissionPresetsForTest()
      const plugins = options.plugins ?? [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          source: 'bundled',
          version: 1,
          binary: 'claude',
          resumeSession: true,
          sessionIdFromCaller: true,
          reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
          skillIntegration: {
            support: 'native',
            harnessId: 'claude',
            installTargets: [],
            invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true, mentionPrefix: '/' },
          },
        },
      ]
      useWorkspaceStore.setState({
        workspaces: [
          {
            ...useWorkspaceStore.getState().workspaces[0],
            id: 'ws-1',
            name: 'sprintengine',
            folderPath: '/proj',
            mode: 'standard',
            agents: {},
            layoutModel: undefined,
          },
        ] as never,
        activeWorkspaceId: 'ws-1',
        pluginCatalogEntries: plugins as never,
        pluginCatalogStatus: 'ready' as never,
        appSettings: {
          ...useWorkspaceStore.getState().appSettings,
          mcp: { syncEnabled: true, servers: { linear: { ...LINEAR } } },
          // Engine picks persist on the store; a check that opens the picker
          // would otherwise leave its remembered engine for the next one.
          lastSelectedCli: 'claude-code',
          lastSelectedAgentModel: null,
        },
      } as never)
    }

    type Harness = {
      container: HTMLElement
      unmount: () => void
      launches: Array<Record<string, unknown>>
      closed: () => number
      text: () => string
      find: (predicate: (el: HTMLElement) => boolean) => HTMLElement | undefined
    }

    const render = async (props: Record<string, unknown> = {}): Promise<Harness> => {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      const launches: Array<Record<string, unknown>> = []
      let closes = 0
      await act(async () => {
        root.render(
          React.createElement(NewAgentPanel, {
            workspaceId: 'ws-1',
            initialSelection: { kind: 'general' },
            permissionPreset: 'none',
            onLaunch: (launch: Record<string, unknown>) => launches.push(launch),
            onClose: () => {
              closes += 1
            },
            ...props,
          } as never),
        )
      })
      // Let the preview IPC and the git-repo probe settle.
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
      const harness: Harness = {
        container,
        unmount: () => {
          liveViews.delete(harness)
          act(() => root.unmount())
          container.remove()
        },
        launches,
        closed: () => closes,
        text: () => container.textContent ?? '',
        find: (predicate) =>
          [...container.querySelectorAll('button, span, p')].find((el) => predicate(el as HTMLElement)) as
            HTMLElement | undefined,
      }
      liveViews.add(harness)
      return harness
    }

    // The "+" menu, and a Start as choice picked from it.
    const openOptions = async (view: Harness): Promise<Element | null> => {
      const plus = view.container.querySelector<HTMLElement>('button[aria-label="Options"]')
      await act(async () => {
        plus!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      return dom.window.document.querySelector('[aria-label="Options"][role="menu"]')
    }
    // Open the skills picker from its row of the "+" menu; it opens on the "+".
    const openSkills = async (view: Harness): Promise<void> => {
      const menu = await openOptions(view)
      const row = [...(menu?.querySelectorAll<HTMLElement>('[data-menu-item="true"]') ?? [])].find((item) =>
        (item.textContent ?? '').includes('Skills, plugins & MCPs'),
      )
      assert.ok(row, 'the "+" offers skills, plugins and MCPs')
      await act(async () => {
        row!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
    const pickKind = async (view: Harness, kind: 'conversation' | 'general' | 'terminal'): Promise<void> => {
      const menu = await openOptions(view)
      const tile = menu?.querySelector<HTMLElement>(`[data-start-as="${kind}"]`)
      assert.ok(tile, `the "+" offers ${kind}`)
      await act(async () => {
        tile!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    // ── Keyboard and the "+" menu ─────────────────────────────────────────────
    const typeInto = async (view: Harness, text: string): Promise<HTMLTextAreaElement> => {
      const field = view.container.querySelector('textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text)
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      return field
    }
    const plusOf = (view: Harness): HTMLElement =>
      view.container.querySelector<HTMLElement>('button[aria-label="Options"]')!
    const pressEscape = async (target: EventTarget = dom.window.document.activeElement ?? dom.window.document) => {
      await act(async () => {
        target.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
    }
    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }

    await check('Enter sends; Shift+Enter and an IME composition do not', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const field = await typeInto(view, 'hi')
      await act(async () => {
        field.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
        )
      })
      assert.equal(view.launches.length, 0, 'Shift+Enter is a new line')
      await act(async () => {
        field.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
        )
      })
      assert.equal(view.launches.length, 0, 'Enter that commits an IME composition is not a send')
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(view.launches.length, 1, 'a plain Enter sends')
      view.unmount()
    })

    await check('the "+" is a menu button, and the send is named', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const plus = plusOf(view)
      assert.equal(plus.getAttribute('aria-haspopup'), 'menu')
      assert.equal(plus.getAttribute('aria-expanded'), 'false')
      const menu = await openOptions(view)
      assert.ok(menu, 'it opens a menu named Options')
      assert.equal(plus.getAttribute('aria-expanded'), 'true')
      assert.equal(plus.getAttribute('aria-controls'), menu!.id, 'the trigger points at its menu')
      for (const item of menu!.querySelectorAll('[data-menu-item="true"]')) {
        assert.match(item.getAttribute('role') ?? '', /^menuitem/, `${item.textContent} is a menu item`)
      }
      assert.equal(menu!.querySelectorAll('[data-start-as]').length, 3, 'every kind a launch can start as')
      assert.ok(menu!.querySelector('[data-start-as][aria-checked="true"]'), 'the current kind is checked')
      await pressEscape()
      const send = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      assert.ok(send, 'the icon-only send has a name')
      view.unmount()
    })

    await check('Escape closes the "+" menu, keeps the panel, and returns focus to the "+"', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const menu = await openOptions(view)
      await settle()
      assert.ok(menu?.contains(dom.window.document.activeElement), 'focus moves into the menu on open')
      await pressEscape()
      assert.equal(dom.window.document.querySelector('[aria-label="Options"][role="menu"]'), null, 'the menu closes')
      assert.equal(view.closed(), 0, 'and the panel stays: the menu took the Escape')
      assert.ok(dom.window.document.activeElement === plusOf(view), 'focus is back on the "+"')
      view.unmount()
    })

    await check('picking a kind from the "+" leaves focus on the "+", not on the page', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const menu = await openOptions(view)
      await settle()
      const tile = menu!.querySelector<HTMLElement>('[data-start-as="general"]')!
      await act(async () => {
        tile.focus()
        tile.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await settle()
      assert.equal(dom.window.document.querySelector('[aria-label="Options"][role="menu"]'), null)
      assert.ok(
        dom.window.document.activeElement === plusOf(view),
        'a keyboard user is not dropped to the top of the document',
      )
      view.unmount()
    })

    await check('arrowing in the open "+" menu is not undone by a re-render', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const menu = await openOptions(view)
      await settle()
      const checked = menu!.querySelector<HTMLElement>('[data-start-as="conversation"]')!
      assert.ok(dom.window.document.activeElement === checked, 'the checked kind takes focus on open')
      await act(async () => {
        checked.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      const moved = dom.window.document.activeElement
      assert.ok(moved !== checked, 'the arrow moved focus')
      // Anything that re-renders the panel while the menu is open: typing
      // elsewhere, a preview arriving, a store write.
      await act(async () => {
        useWorkspaceStore.setState({
          appSettings: { ...useWorkspaceStore.getState().appSettings, cliRuntimes: {} },
        } as never)
      })
      await settle()
      assert.ok(dom.window.document.activeElement === moved, 'focus stays where the person put it')
      await pressEscape()
      view.unmount()
    })

    await check('the skills picker opened from the "+" closes on Escape back to the "+"', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      await openSkills(view)
      const dialog = dom.window.document.querySelector('[role="dialog"]')
      assert.ok(dialog, 'the picker opens')
      await pressEscape()
      assert.equal(dom.window.document.querySelector('[role="dialog"]'), null, 'Escape closes it')
      assert.equal(view.closed(), 0, 'and not the panel')
      assert.ok(dom.window.document.activeElement === plusOf(view), 'focus is back on the "+"')
      view.unmount()
    })

    // ── Attachments ───────────────────────────────────────────────────────────
    await check('an image picked through Attach files is staged and rides the launch', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const menu = await openOptions(view)
      const attach = [...menu!.querySelectorAll<HTMLElement>('[data-menu-item="true"]')].find((item) =>
        (item.textContent ?? '').includes('Attach files'),
      )
      assert.ok(attach, 'the "+" offers Attach files')
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
      let opened = 0
      input.click = () => {
        opened += 1
      }
      await act(async () => {
        attach!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(opened, 1, 'it opens the system dialog')
      const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => {
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      assert.ok(view.container.querySelector('img[src^="data:image/png"]'), 'the image is staged on the box')
      const field = await typeInto(view, 'look')
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(view.launches.length, 1)
      assert.match(String(view.launches[0]!.prompt), /\/tmp\/shot\.png/, 'its path rides the prompt')
      view.unmount()
    })

    await check('a pasted screenshot is staged and rides the launch', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      const field = view.container.querySelector('textarea')!
      const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' })
      const event = new dom.window.Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', {
        value: {
          items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
          files: [file],
          types: ['Files'],
          getData: () => '',
        },
      })
      await act(async () => {
        field.dispatchEvent(event)
      })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      assert.ok(view.container.querySelector('img[src^="data:image/png"]'), 'the screenshot is staged')
      await typeInto(view, 'see')
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.match(String(view.launches[0]?.prompt), /\/tmp\/shot\.png/)
      view.unmount()
    })

    // ── Drafts ────────────────────────────────────────────────────────────────
    await check('a parked draft comes back: prompt, kind and image', async () => {
      seedStore()
      const { readNewChatDraft, writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      const first = await render({ draftKey: 'win-2', initialSelection: { kind: 'conversation' } })
      await typeInto(first, 'keep me')
      await pickKind(first, 'general')
      first.unmount()
      const parked = readNewChatDraft('win-2')
      assert.equal(parked?.prompt, 'keep me')
      assert.equal(parked?.selection?.kind, 'general')
      const second = await render({ draftKey: 'win-2', initialSelection: { kind: 'conversation' } })
      assert.equal(second.container.querySelector('textarea')?.value, 'keep me', 'the words come back')
      assert.ok(second.text().includes('Terminal agent'), 'and the kind, as its tag')
      second.unmount()
      writeNewChatDraft('win-2', {
        images: [
          {
            id: 'img-1',
            mediaType: 'image/png',
            dataBase64: 'iVBORw0K',
            byteLength: 4,
            name: 'a.png',
            path: '/tmp/a.png',
          },
        ],
      })
      const third = await render({ draftKey: 'win-2', initialSelection: { kind: 'conversation' } })
      assert.ok(third.container.querySelector('img[src^="data:image/png"]'), 'a staged image comes back on the box')
      const start = [...third.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.match(String(third.launches[0]?.prompt), /^keep me \/tmp\/a\.png$/, 'and rides the launch')
      third.unmount()
      resetNewChatDraftsForTests()
    })

    // ── Tags ──────────────────────────────────────────────────────────────────
    await check('removing the kind tag returns to a conversation and the tag goes', async () => {
      seedStore()
      const view = await render({ initialSelection: { kind: 'conversation' } })
      await pickKind(view, 'terminal')
      const remove = view.container.querySelector<HTMLElement>(
        '[aria-label="Start as a conversation instead of terminal"]',
      )
      assert.ok(remove, 'the kind is a tag with a ×')
      assert.equal(view.container.querySelector('textarea')?.disabled, true, 'a plain shell takes no prompt')
      await act(async () => {
        remove!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(
        view.container.querySelector('[aria-label^="Start as a conversation instead of"]'),
        null,
        'the tag is gone',
      )
      assert.equal(view.container.querySelector('textarea')?.disabled, false, 'and the prompt takes words again')
      const field = await typeInto(view, 'go')
      await act(async () => {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(view.launches[0]?.kind, 'conversation', 'and the launch is a conversation again')
      view.unmount()
    })

    if (failures > 0) {
      console.error(`NewAgentPanel.interaction.test.tsx: ${failures} failing check(s)`)
      process.exit(1)
    }
    console.log('NewAgentPanel.interaction.test.tsx: ok')
  }

  await main()
})
