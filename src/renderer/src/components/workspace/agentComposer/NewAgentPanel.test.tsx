import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('NewAgentPanel', async () => {
  // The launch surface behind the tab strip's "+". Rendered for real,
  // because the acceptance is about what a person sees and presses:
  //
  //   1. the row shows what a launch usually changes — engine and access — while
  //      role, worktree, reasoning and debug stay behind the ⋯ menu until set;
  //   2. the invocation main renders rides Start's hover, not a line of chrome;
  //   3. Start hands the host a confirm plus the typed prompt — and creates
  //      nothing itself;
  //   4. a suggestion card spawns on click, carrying its own full prompt;
  //   5. the skill trigger is the CLI's declared one, and a CLI that declares
  //      none still gets the Skills & MCPs picker, which every launch has;
  //   6. the greeting uses a first name when there is one and reads correctly
  //      when there is not;
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
  const PREVIEW_DISPLAY = 'claude --permission-mode auto --model claude-opus-5'

  // The fleet the remote-machine tests drive (remote-sessions-ux /
  // new-chat-on-a-remote-machine). Reassigned per check.
  let fleetConnections: Array<Record<string, unknown>> = []
  let fleetBrowseAnswer: (connectionId: string) => Record<string, unknown> = () => ({
    connectionId: 'c',
    reachable: true,
    unreachableReason: null,
    unauthorized: false,
    scopes: [],
    terminalAccess: 'full',
    workspaces: [],
    terminals: [],
    gaps: [],
  })

  // Which repository a local folder is (one-project-across-machines); null = no remote.
  let localIdentityAnswer: (folderPath: string) => Record<string, unknown> | null = () => null
  // The picked remote project's checkout facts (checkout-and-branch-on-remote-create).
  let fleetCheckoutAnswer: (connectionId: string, workspaceId: string) => Record<string, unknown> = (
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

  ;(dom.window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'darwin',
    hostsList: async () => hostsAnswer,
    onHostsChanged: () => () => {},
    pluginsDetectAvailability: async (input: unknown) => {
      detectCalls.push(input)
      return {
        ok: true,
        availability: {
          'claude-code': { cli: 'claude-code', installed: true, resolvedPath: '/usr/bin/claude', version: '1' },
        },
      }
    },
    getGitRepoRoot: async () => '/proj',
    fleetListConnections: async () => fleetConnections,
    fleetBrowse: async (connectionId: string) => fleetBrowseAnswer(connectionId),
    fleetWorkspaceCheckout: async (connectionId: string, workspaceId: string) =>
      fleetCheckoutAnswer(connectionId, workspaceId),
    getGitRepositoryIdentity: async (folderPath: string) => localIdentityAnswer(folderPath),
    onFleetEvent: () => () => {},
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
    const { resetRememberedMachineForTests, sortMachines } = await import('./NewAgentPanel')
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const { projectHue } = await import('../../../utils/projectColor')
    const { useToastStore } = await import('../../../store/toastStore')
    const {
      __reloadCliPermissionPresetsForTest,
      __resetCliPermissionPresetsForTest,
      storedCliPermissionPreset,
      resolveCliPermissionPreset,
    } = await import('../../ui/cliPermissionPresets')

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
      // Permissions are remembered per CLI, in a module-level store that would
      // otherwise carry a preset from one check into the next.
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
            conversationAvailable: false,
            initialSelection: { kind: 'general' },
            permissionPreset: 'auto',
            debugMode: false,
            onChangeDebugMode: () => {},
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

    // 1. The row carries the usual decisions; the rare ones stay behind ⋯.
    await check('the row shows engine and access, and hides the rest behind ⋯', async () => {
      seedStore()
      previewCalls.length = 0
      const view = await render()
      const text = view.text()

      // The PROJECT folder, not the workspace name: a solo-chat workspace is
      // called things like "new chat panel", which says nothing about where the
      // agent runs. The fixture names them differently on purpose.
      assert.ok(text.includes('proj'), 'the scope line names the folder the agent will run in')
      assert.ok(!text.includes('sprintengine'), 'and not the workspace’s own name')
      // Permissions used to stand beside the engine as their own chip. They are a
      // property of the runtime the row names, so they moved INSIDE the model
      // picker (owner, 2026-09-05) and are remembered per CLI — the row itself
      // no longer carries the value.
      assert.ok(!text.includes('Auto'), 'access is not a second chip on the row')
      assert.ok(
        [...view.container.querySelectorAll('button')].some((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
        ),
        'the engine chip is the one control the row spends on the runtime',
      )
      assert.ok(text.includes('Skills & MCPs'), 'the one picker for skills and MCP servers is offered')
      assert.ok(text.includes('⋯'), 'the overflow is there')

      assert.ok(!text.includes('+ Worktree'), 'worktree is not on the row until it is set')
      assert.ok(!text.includes('+ Skill') && !text.includes('+ Connector'), 'the two old chips are gone')
      assert.ok(!/debug/i.test(text), 'nor is debug')

      // The command line is not printed under the box any more.
      assert.ok(!text.includes(PREVIEW_DISPLAY), 'the invocation is not a line of chrome')

      // It rides Start's hover, and it is main's answer verbatim.
      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      assert.ok(start, 'the launch control is there, named for what it does')
      assert.equal(start?.textContent?.trim(), '⏎', 'and wears the key that triggers it, not a chat send-arrow')
      // Real focus, not a synthetic 'focus' event: React binds onFocus to focusin,
      // which is also what a Tab press produces — the path this must work on.
      await act(async () => {
        ;(start as HTMLElement).focus()
      })
      const tooltip = dom.window.document.querySelector('[role="tooltip"]')
      assert.ok(tooltip, 'focusing Start opens its tip — keyboard reaches it, not only the pointer')
      assert.ok(
        (tooltip?.textContent ?? '').includes(PREVIEW_DISPLAY),
        `the tip is main's own line; got: ${tooltip?.textContent}`,
      )

      assert.equal(previewCalls.length >= 1, true, 'the surface asked main rather than composing the line itself')
      assert.equal(previewCalls[0]?.cli, 'claude-code', 'it asked about the selected agent’s CLI')
      assert.equal(
        previewCalls[0]?.cliPermissionPreset,
        'auto',
        'and forwarded the approval preset, so the line moves when the chip does',
      )
      assert.ok(!('debugMode' in (previewCalls[0] ?? {})), 'debug is a prompt concern and stays out of the receipt')

      view.unmount()

      // Bypass is the value that removes a safeguard, so it is the one that also
      // changes colour rather than only its text.
      const bypassed = await render({ permissionPreset: 'bypass' })
      // The presets are an inline strip on the picker's one trailing row now, so
      // opening the engine is what reveals them — all four, no menu to open.
      const engine = [...bypassed.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )
      await act(async () => {
        engine!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const chip = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Permissions: Bypass permissions',
      )
      assert.ok(chip, 'the permission chip is named for the preset it carries')
      assert.ok((chip?.textContent ?? '').includes('Bypass'), 'and reads Bypass when that is the preset')
      // Bypass is the value that removes a safeguard, so it is the one that also
      // changes colour rather than only its text. The chip carries that colour as
      // the kit's `tint` — an ink plus a 12%-of-the-same ground, applied inline so
      // it cannot meet the variant's own `bg-`/`hover:bg-` at equal specificity —
      // so the tone reads from the style attribute rather than the class list.
      assert.ok(
        (chip?.getAttribute('style') ?? '').includes('--tone-warn'),
        'and wears the warn tone, not the ordinary accent',
      )
      // The two settings about the row above are the same kind of control, on the
      // same line: effort first, permissions to its right (owner, 2026-09-05).
      const trailing = [...dom.window.document.querySelectorAll('button')].filter((button) => {
        const name = button.getAttribute('aria-label') ?? ''
        return name.startsWith('Permissions: ') || name.startsWith('Reasoning effort: ')
      })
      assert.deepEqual(
        trailing.map((button) => (button.getAttribute('aria-label') ?? '').split(':')[0]),
        ['Reasoning effort', 'Permissions'],
        'effort on the left, permissions on the right, in one row',
      )
      // Each chip is a Popover trigger, so it sits inside that Popover's own
      // wrapper; the row is the grandparent. Compared as a BOOLEAN, never as the
      // nodes themselves — a failed assert on two DOM elements makes Node
      // serialise both trees for its diff, which exhausts memory and kills the
      // runner instead of printing a failure.
      const rowOf = (button: Element | undefined) => button?.parentElement?.parentElement
      assert.ok(
        trailing.length === 2 && rowOf(trailing[0]) !== undefined && rowOf(trailing[0]) === rowOf(trailing[1]),
        'and they share one row, rather than sitting on two stacked bands',
      )
      bypassed.unmount()
    })

    // 1b. The ⋯ menu holds exactly what the row does not — which is now two
    //     things. The Role control left with the identity picker it belonged to;
    //     reasoning effort moved into the model's own picker, where it is a
    //     property of the model.
    await check('the ⋯ menu holds worktree and debug, and nothing else', async () => {
      seedStore()
      const view = await render()
      const more = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'More launch options',
      )
      assert.ok(more, 'the overflow has an accessible name')
      await act(async () => {
        more!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const menu = dom.window.document.querySelector('[aria-label="More launch options"][role="menu"]')
      const menuText = menu?.textContent ?? ''
      assert.ok(menuText.includes('Worktree'), 'worktree is a row')
      assert.ok(menuText.includes('Off'), 'showing its current value')
      assert.ok(menuText.includes('Debug mode'), 'and debug')
      // The kind of thing being launched lives here too — the only surface that
      // starts a plain shell or a conversation agent.
      assert.ok(menuText.includes('Agent'), 'an agent is the default kind')
      assert.ok(menuText.includes('Terminal'), 'a plain shell is reachable')
      assert.ok(!menuText.includes('Role'), 'the Role control is gone from this surface entirely')
      assert.ok(!menuText.includes('Reasoning'), 'and reasoning lives in the model picker now')
      // Debug is about the user's software, not the agent.
      assert.ok(/instruments your code/i.test(menuText), `debug says what it actually does; got: ${menuText}`)

      // Worktree expands in place to type its branch — the click that turns it on
      // is the click that starts typing.
      const worktreeRow = [...(menu?.querySelectorAll('button') ?? [])].find((button) =>
        (button.textContent ?? '').startsWith('Worktree'),
      )
      assert.ok(worktreeRow, 'the worktree row is pressable')
      await act(async () => {
        worktreeRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const branchInput = dom.window.document.querySelector('[aria-label="Worktree branch name"]')
      assert.ok(branchInput, 'and reveals the branch field')
      assert.notEqual(branchInput?.getAttribute('aria-hidden'), 'true', 'which is reachable once open')
      view.unmount()
    })

    // 2b. Picking Terminal or Conversation drops every CLI-shaped control: neither
    //     launches one, so neither may show a model, a permission flag, or a
    //     command line.
    await check('a terminal or conversation launch shows no CLI chrome', async () => {
      seedStore()
      const view = await render({ conversationAvailable: true })
      const openMore = async () => {
        const more = [...view.container.querySelectorAll('button')].find(
          (button) => button.getAttribute('aria-label') === 'More launch options',
        )
        await act(async () => {
          more!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        return dom.window.document.querySelector('[aria-label="More launch options"][role="menu"]')
      }

      const menu = await openMore()
      // Listed whether or not a provider is configured — an option that vanishes
      // reads as unimplemented rather than unconfigured.
      assert.ok((menu?.textContent ?? '').includes('Chat'), 'the chat launch is listed')
      assert.ok(
        (menu?.textContent ?? '').includes('An agent in a chat window'),
        'and says what it is, where a provider can serve one',
      )
      const terminalRow = [...(menu?.querySelectorAll('button') ?? [])].find((button) =>
        (button.textContent ?? '').startsWith('Terminal'),
      )
      await act(async () => {
        terminalRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })

      const text = view.text()
      // A shell launches nothing that reads a permission flag or a model, so it
      // shows neither — and the engine chip that opens the picker holding both
      // is gone with them.
      assert.ok(!text.includes('Opus'), 'no model')
      assert.ok(
        ![...view.container.querySelectorAll('button')].some((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
        ),
        'and no engine chip, so no way to a permission preset a shell would ignore',
      )

      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      await act(async () => {
        ;(start as HTMLElement).focus()
      })
      const tip = dom.window.document.querySelector('[role="tooltip"]')
      assert.ok(
        (tip?.textContent ?? '').includes('shell'),
        `it says what it opens instead of a command; got: ${tip?.textContent}`,
      )

      // A shell runs nothing on your behalf: no suggested tasks, and a prompt
      // field that says so rather than dropping what was typed.
      const { SUGGESTION_BANK } = await import('./suggestionBank')
      assert.ok(!SUGGESTION_BANK.some((entry) => text.includes(entry.title)), 'no suggestion cards for a plain shell')
      const promptField = view.container.querySelector('textarea')
      assert.equal(promptField?.disabled, true, 'and no prompt to type into')
      assert.ok((promptField?.getAttribute('placeholder') ?? '').includes('nothing typed'), 'which says why')

      // The menu is the ONLY way to change what is being launched, so hiding it
      // for a terminal stranded the surface with no way back to an agent.
      const stillThere = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'More launch options',
      )
      assert.ok(stillThere, 'the ⋯ menu survives a terminal selection')
      await act(async () => {
        stillThere!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const backMenu = dom.window.document.querySelector('[aria-label="More launch options"][role="menu"]')
      const agentRow = [...(backMenu?.querySelectorAll('button') ?? [])].find((button) =>
        (button.textContent ?? '').startsWith('Agent'),
      )
      assert.ok(agentRow, 'and still offers Agent')
      await act(async () => {
        agentRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.ok(
        [...view.container.querySelectorAll('button')].some((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
        ),
        'picking Agent brings the engine chip — and the permission control inside it — back',
      )
      const back = view.text()
      assert.equal(view.container.querySelector('textarea')?.disabled, false, 'and the prompt is typeable again')
      assert.ok(
        SUGGESTION_BANK.some((entry) => back.includes(entry.title)),
        'and the suggested tasks return',
      )
      view.unmount()
    })

    // 2b-ii. A surface that offers a conversation agent must ASK for the provider
    //        catalog — the row is gated on availability, and while the catalog was
    //        loaded by the top bar's menu alone this option could never appear here.
    // 2b-iii. Unavailable is not invisible: with no provider the row stays, says
    //         what is missing, and routes to Settings instead of disappearing.
    await check('the chat launch is listed even with no provider configured', async () => {
      seedStore()
      const view = await render({ conversationAvailable: false })
      const more = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'More launch options',
      )
      await act(async () => {
        more!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const menu = dom.window.document.querySelector('[aria-label="More launch options"][role="menu"]')
      const chatRow = [...(menu?.querySelectorAll('button') ?? [])].find((button) =>
        (button.textContent ?? '').startsWith('Chat'),
      )
      assert.ok(chatRow, 'the row is there')
      assert.equal(chatRow?.getAttribute('aria-disabled'), 'true', 'marked unavailable')
      assert.ok(
        (chatRow?.textContent ?? '').includes('Needs a model provider'),
        'and says what is missing rather than vanishing',
      )
      // The whole sentence, not "connect one in S…": these hints wrap, because a
      // tooltip to recover text the surface had room for is a worse answer.
      assert.ok(
        (chatRow?.textContent ?? '').includes('connect one in Settings'),
        'the reason is readable in full, not truncated',
      )
      assert.ok(!chatRow?.querySelector('.truncate'), 'no truncation inside a row whose text IS the explanation')
      view.unmount()
    })

    await check('the feature flag removes the chat launch and skips its catalog request', async () => {
      seedStore()
      let requests = 0
      const view = await render({
        conversationModeEnabled: false,
        conversationAvailable: true,
        onRequestConversationCatalog: () => {
          requests += 1
        },
      })
      const more = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'More launch options',
      )
      await act(async () => {
        more!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const menu = dom.window.document.querySelector('[aria-label="More launch options"][role="menu"]')
      assert.ok(!(menu?.textContent ?? '').includes('Chat'), 'the unfinished conversation mode is absent')
      assert.equal(requests, 0, 'a hidden feature does not load its provider catalog')
      view.unmount()
    })

    await check('the surface asks the host for the conversation catalog', async () => {
      seedStore()
      let requests = 0
      const view = await render({
        onRequestConversationCatalog: () => {
          requests += 1
        },
      })
      assert.equal(requests, 1, 'asked once on open, so a provider added since last time shows up')
      view.unmount()
    })

    // 2c. There is always a way out. The tab host has its tab's ×; the door host
    //     has none, so the surface carries the control — and Escape cancels from
    //     anywhere on it, not only from the prompt field.
    await check('the surface can always be cancelled', async () => {
      seedStore()

      // Escape from a control that is not the prompt.
      const view = await render()
      const chip = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'More launch options',
      )
      await act(async () => {
        ;(chip as HTMLElement).focus()
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      assert.equal(view.closed(), 1, 'Escape cancels from anywhere on the surface')
      view.unmount()

      // The door host draws its own close control, because it has no tab.
      const withButton = await render({ showCloseButton: true })
      const close = [...withButton.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Cancel',
      )
      assert.ok(close, 'a hosted surface with no tab carries its own way out')
      await act(async () => {
        close!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(withButton.closed(), 1, 'and it cancels')
      withButton.unmount()

      // The tab host does NOT draw one — its tab already closes it.
      const tabHosted = await render()
      assert.ok(
        ![...tabHosted.container.querySelectorAll('button')].some(
          (button) => button.getAttribute('aria-label') === 'Cancel',
        ),
        'the tab host relies on its tab, and draws no second control',
      )
      tabHosted.unmount()
    })

    // 3. Start hands the host a confirm plus the prompt, and creates nothing.
    await check('Start reports the launch to the host with the typed prompt', async () => {
      seedStore()
      const view = await render()
      const textarea = view.container.querySelector('textarea')
      assert.ok(textarea, 'the prompt field exists')

      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(textarea, 'review the auth flow')
        textarea!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })

      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      assert.ok(start, 'the primary action is named for what it does')
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })

      assert.equal(view.launches.length, 1, 'exactly one launch was reported')
      assert.equal(view.launches[0]?.prompt, 'review the auth flow', 'carrying what was typed')
      assert.equal(view.launches[0]?.kind, 'general', 'and which agent was chosen')
      assert.equal(
        'model' in (view.launches[0] ?? {}),
        true,
        'the confirm always names the model, even when it is the CLI’s own default',
      )
      assert.equal(
        view.launches[0]?.model,
        null,
        'and with no pick that name is null — not an omitted field the host would re-read',
      )
      assert.equal('reasoning' in (view.launches[0] ?? {}), true, 'and it always names the effort, for the same reason')
      assert.equal(view.launches[0]?.reasoning, null, 'with no pick that is the CLI’s own default too')
      view.unmount()
    })

    // Codex with no `--model` launches Astra. The chip’s pick has to ride Start,
    // not a later re-read of the remembered defaults (which can miss in the same
    // turn and leave the flag off).
    await check('picking a catalog model puts that id on Start, not the CLI’s own default', async () => {
      seedStore({
        plugins: [
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            source: 'bundled',
            version: 1,
            binary: 'claude',
            resumeSession: true,
            sessionIdFromCaller: true,
            modelSelection: { options: [{ id: 'claude-opus-5', label: 'Opus 5' }], allowCustomId: true },
            reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
            skillIntegration: {
              support: 'native',
              harnessId: 'claude',
              installTargets: [],
              invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true, mentionPrefix: '/' },
            },
          },
          {
            id: 'codex',
            displayName: 'Codex',
            source: 'bundled',
            version: 1,
            binary: 'codex',
            resumeSession: true,
            sessionIdFromCaller: true,
            modelSelection: {
              options: [
                { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
                { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
              ],
              allowCustomId: true,
            },
            reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], default: 'medium' },
            skillIntegration: {
              support: 'native',
              harnessId: 'codex',
              installTargets: [],
              invocation: { explicitTemplate: '${{skillId}}', nativeSlashCommand: false },
            },
          },
        ],
      })
      const view = await render({ permissionPreset: 'bypass' })
      const engine = [...view.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )
      await act(async () => {
        engine!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const codexTab = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.getAttribute('role') === 'radio' && button.getAttribute('aria-label') === 'Codex',
      )
      assert.ok(codexTab, 'Codex is on the runtime rail')
      assert.ok(
        dom.window.document.querySelector('[aria-label="Permissions: Bypass permissions"]'),
        'Claude names its bypass preset',
      )
      await act(async () => {
        codexTab!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.ok(
        dom.window.document.querySelector('[aria-label="Permissions: YOLO"]'),
        'switching to Codex updates the permission chip',
      )
      assert.equal(
        dom.window.document.querySelector('[aria-label="Permissions: Bypass permissions"]'),
        null,
        'the previous runtime label is gone',
      )
      const sol = [...dom.window.document.querySelectorAll('[data-model-row="true"]')].find((row) =>
        (row.textContent ?? '').includes('GPT-5.6 Sol'),
      )
      assert.ok(sol, 'the Sol row is in the picker')
      await act(async () => {
        sol!.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }))
      })
      const permissions = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Permissions: YOLO"]')!
      await act(async () => permissions.click())
      const manual = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')].find(
        (row) => row.textContent?.startsWith('Manual'),
      )!
      await act(async () => manual.click())
      assert.equal(storedCliPermissionPreset('codex'), 'manual', 'the highlighted model’s CLI owns the choice')
      assert.equal(storedCliPermissionPreset('claude-code'), undefined, 'the previous runtime is untouched')
      await act(async () => {
        sol!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(view.launches.length, 1, 'exactly one launch')
      assert.equal(view.launches[0]?.cli, 'codex', 'on the runtime that owned the row')
      assert.equal(view.launches[0]?.model, 'gpt-5.6-sol', 'carrying the id the chip named, not the CLI’s own default')
      assert.equal(
        resolveCliPermissionPreset(String(view.launches[0]?.cli), 'bypass'),
        'manual',
        'the launch host resolves the launched CLI’s permission choice',
      )
      assert.equal('reasoning' in (view.launches[0] ?? {}), true, 'and the effort rides the same confirm')
      view.unmount()
    })

    // 4. A card is a launch button, and it carries the bank's real prompt.
    await check('a suggestion card spawns on click with its full prompt', async () => {
      seedStore()
      const { SUGGESTION_BANK } = await import('./suggestionBank')
      const view = await render()

      const card = [...view.container.querySelectorAll('button')].find((button) =>
        SUGGESTION_BANK.some((entry) => (button.textContent ?? '').startsWith(entry.title)),
      )
      assert.ok(card, 'the surface drew cards')
      await act(async () => {
        card!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })

      assert.equal(view.launches.length, 1, 'one click, one launch')
      const prompt = String(view.launches[0]?.prompt ?? '')
      const matched = SUGGESTION_BANK.find((entry) => entry.prompt === prompt)
      assert.ok(matched, 'the card sent the bank’s real instruction, not its title')
      assert.notEqual(prompt, matched?.title, 'and never the label')
      view.unmount()
    })

    // 5. Skills are offered by the picker whatever the CLI can type; the
    //    inline `/` route stays but is no longer the placeholder's job.
    await check('the picker is there for every CLI and the placeholder stops advertising the trigger', async () => {
      seedStore()
      const withPrefix = await render()
      assert.equal(withPrefix.container.querySelector('textarea')?.getAttribute('placeholder'), 'Describe the task…')
      assert.ok(withPrefix.text().includes('Skills & MCPs'), 'a claude runtime gets the picker')
      withPrefix.unmount()

      seedStore({
        plugins: [
          {
            id: 'opencode',
            displayName: 'OpenCode',
            source: 'bundled',
            version: 1,
            binary: 'opencode',
            resumeSession: false,
            sessionIdFromCaller: false,
            skillIntegration: {
              support: 'native',
              harnessId: 'opencode',
              installTargets: [],
              invocation: { explicitTemplate: 'Use the {{skillId}} skill.', explicitMention: true },
            },
          },
        ],
      })
      const noPrefix = await render()
      assert.equal(noPrefix.container.querySelector('textarea')?.getAttribute('placeholder'), 'Describe the task…')
      assert.ok(noPrefix.text().includes('Skills & MCPs'), 'and so does a CLI with no typed form')
      noPrefix.unmount()
    })

    // 5b. The picker itself: three groups, install and add on pick, chips,
    //     keyboard toggling, and the picks on the confirm in pick order.
    await check('the Skills & MCPs picker installs, adds and carries its picks onto the launch', async () => {
      seedStore()
      attachCalls.length = 0
      syncCalls.length = 0
      const view = await render()
      const settle = async () => {
        for (let i = 0; i < 3; i += 1) {
          await act(async () => {
            await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
          })
        }
      }
      const trigger = view.find((el) => el.tagName === 'BUTTON' && /Skills & MCPs/.test(el.textContent ?? ''))
      assert.ok(trigger, 'the trigger is a button')
      await act(async () => {
        trigger!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await settle()
      // The surface is portalled to the body; the chips stay in the panel.
      const surface = () =>
        dom.window.document.querySelector('[role="dialog"][aria-label="Skills and MCPs"]') as HTMLElement | null
      assert.ok(surface(), 'the picker opened')
      const text = surface()!.textContent ?? ''
      // No "Add": the picker's Add rows were the bundled catalogue's servers,
      // and the catalogue is gone. What is left under MCP servers is
      // the studio gateway (Included) and the servers this workspace installed.
      for (const label of [
        'Skills in this workspace',
        'Available to install',
        'MCP servers',
        'Install',
        'Included',
        'sprintengine-studio',
      ]) {
        assert.ok(text.includes(label), `the open picker shows "${label}"`)
      }
      const listbox = surface()!.querySelector('[role="listbox"]')
      assert.equal(listbox?.getAttribute('aria-multiselectable'), 'true', 'the list is a multi-select listbox')
      const input = surface()!.querySelector('input[aria-controls]') as HTMLInputElement | null
      assert.ok(input, 'the search field names the list it drives')
      assert.equal(input!.getAttribute('aria-controls'), listbox?.id, 'through aria-controls')
      assert.equal(input!.getAttribute('role'), null, 'and is not a combobox: rows toggle, they do not commit')

      // Pointer: an installed skill toggles straight to a chip.
      const backlogRow = surface()!.querySelector('[data-picker-row="skill:backlog"]') as HTMLElement | null
      assert.ok(backlogRow, 'the reachable skill is listed')
      await act(async () => {
        backlogRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(
        surface()!.querySelector('[data-picker-row="skill:backlog"]')?.getAttribute('aria-selected'),
        'true',
        'the row is checked',
      )
      assert.ok(
        view.find((el) => el.getAttribute('aria-label') === 'Remove skill backlog'),
        'and a chip appears',
      )
      assert.equal(attachCalls.length, 0, 'an installed skill installs nothing')

      // Keyboard: ↓ to the installable skill, ⏎ installs it and checks it.
      await act(async () => {
        input!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      const designRow = surface()!.querySelector('[data-picker-row="skill:design-system"]') as HTMLElement | null
      assert.equal(
        input!.getAttribute('aria-activedescendant'),
        designRow?.id,
        'the highlight moved to the Install row',
      )
      await act(async () => {
        input!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      await settle()
      assert.deepEqual(
        attachCalls.map((call) => call.skillId),
        ['design-system'],
        'Enter installed it before anything else',
      )
      assert.ok(
        view.find((el) => el.getAttribute('aria-label') === 'Remove skill design-system'),
        'and it became a chip',
      )

      // An installed MCP server whose clients do not yet reach the launch CLI:
      // the pick adds the CLI and syncs the workspace config before it counts.
      const linearRow = surface()!.querySelector('[data-picker-row="mcp:linear"]') as HTMLElement | null
      assert.ok(linearRow, 'the installed server is listed')
      await act(async () => {
        linearRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await settle()
      assert.equal(syncCalls.length, 1, 'the workspace config was synced once')
      const synced = syncCalls[0] as {
        workspaceRoot: string
        settings: { servers: Record<string, { clients: string[]; enabled: boolean }> }
        clients?: string[]
      }
      assert.equal(synced.workspaceRoot, '/proj')
      assert.ok(synced.settings.servers.linear?.enabled, 'with the server enabled')
      assert.ok(synced.settings.servers.linear?.clients.includes('claude-code'), 'reaching the launch CLI')
      assert.ok(
        view.find((el) => el.getAttribute('aria-label') === 'Remove MCP server Linear'),
        'and it became a chip',
      )
      assert.deepEqual(synced.clients, ['claude-code'], 'the sync is scoped to the launch CLI')

      // The picks ride the confirm in pick order.
      const start = view.find((el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Start agent')
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const launch = view.launches[0] as
        { skills?: Array<{ id: string }>; mcpServers?: Array<{ id: string }> } | undefined
      assert.deepEqual(
        launch?.skills?.map((skill) => skill.id),
        ['backlog', 'design-system'],
      )
      assert.deepEqual(
        launch?.mcpServers?.map((server) => server.id),
        ['linear'],
      )
      view.unmount()
    })

    // 5c. A sync that fails leaves nothing behind: the app's MCP settings are
    //     put back and the row says why.
    await check('a failed MCP sync rolls the settings back and stays on the row', async () => {
      // seedStore puts Linear back as it started: installed, but not yet
      // reaching the launch CLI, which is what makes the pick attempt a sync.
      seedStore()
      syncCalls.length = 0
      syncFailure = 'EACCES: .mcp.json is read-only'
      const view = await render()
      const trigger = view.find((el) => el.tagName === 'BUTTON' && /Skills & MCPs/.test(el.textContent ?? ''))
      await act(async () => {
        trigger!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
        })
      }
      const surface = dom.window.document.querySelector('[role="dialog"][aria-label="Skills and MCPs"]') as HTMLElement
      const linearRow = surface.querySelector('[data-picker-row="mcp:linear"]') as HTMLElement
      await act(async () => {
        linearRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
        })
      }
      assert.equal(syncCalls.length, 1)
      assert.ok((surface.textContent ?? '').includes('EACCES'), 'the row carries the error')
      assert.equal(
        view.find((el) => el.getAttribute('aria-label') === 'Remove MCP server Linear'),
        undefined,
        'no chip',
      )
      assert.deepEqual(
        useWorkspaceStore.getState().appSettings.mcp?.servers?.linear?.clients,
        ['codex'],
        'the settings were put back — the launch CLI the failed pick added is gone again',
      )
      syncFailure = null
      view.unmount()
    })

    // 5d. The door's connector list is the union of what is installed and what
    //     the catalogue offers — so a server that arrived by installing a PLUGIN
    //     is listed here on its own — which is now the only way a server gets
    //     here at all, since the bundled catalogue was retired
    //     (2026-09-08; backlog/2026-09-06-shipped-mcp-servers-are-plugins.md).
    //     Checked against the row builder rather than through the render above,
    //     because the claim is about which rows exist, not about pressing one.
    await check('a server installed from a plugin is a row of its own', async () => {
      const { buildMcpRows } = await import('./SkillsAndMcpsPicker')
      const fromPlugin = {
        id: 'io-snyk-mcp',
        name: 'io-snyk-mcp',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'snyk@latest', 'mcp', '-t', 'stdio'],
        enabled: true,
        required: false,
        clients: ['claude-code'],
        scope: 'workspace' as const,
        source: 'source' as const,
        sourceRef: {
          sourceId: 'sprintengine-studio',
          itemId: 'io-snyk-mcp',
          commitSha: '4f2a91c0000',
          // Where the declaring plugin's own files landed — what makes this a
          // server that arrived by installing a plugin.
          pluginRoot: '/proj/.claude/plugins/snyk',
        },
        riskLevel: 'local-command' as const,
      }
      const rows = buildMcpRows({ 'io-snyk-mcp': fromPlugin })
      const row = rows.find((entry) => entry.id === 'io-snyk-mcp')
      assert.ok(row, 'the plugin-installed server is a row')
      assert.equal(row!.state, 'installed', 'and it is installed — there is no Add row left to confuse it with')
      assert.equal(rows.filter((entry) => entry.id === 'io-snyk-mcp').length, 1, 'exactly once')

      // A disabled server is not offered: the picker adds servers to a launch,
      // and a launch cannot use one the person turned off.
      const off = buildMcpRows({ 'io-snyk-mcp': { ...fromPlugin, enabled: false } })
      assert.equal(
        off.some((entry) => entry.id === 'io-snyk-mcp'),
        false,
        'a disabled server is not a row',
      )
    })

    // 6. The greeting: a name when there is one, and a sentence either way.
    await check('the greeting uses a first name only when there is one', async () => {
      seedStore()
      useWorkspaceStore.setState({
        authState: {
          ...useWorkspaceStore.getState().authState,
          user: { id: 'u', email: 'c@example.com', displayName: 'Sam Rivera', photoUrl: null },
        },
      } as never)
      const named = await render()
      assert.ok(named.text().includes('Sam'), 'it greets by first name, not full name')
      assert.ok(!named.text().includes('Smith'), 'and not by surname')
      named.unmount()

      useWorkspaceStore.setState({
        authState: { ...useWorkspaceStore.getState().authState, user: null },
      } as never)
      const anon = await render()
      const text = anon.text()
      assert.ok(!text.includes('Sam'), 'signed out, no name')
      assert.ok(!/,\s*\?/.test(text), 'and no dangling comma where the name was')
      assert.ok(!/sign in/i.test(text), 'a launch surface is not a sign-in prompt')
      anon.unmount()
    })

    // 7. Nothing installed: the install route, not live-looking controls.
    await check('with no agent CLI the surface offers the install route', async () => {
      seedStore({ plugins: [] })
      const view = await render()
      const text = view.text()
      assert.ok(text.includes('No agent CLI is installed'), 'it says so plainly')
      assert.equal(view.container.querySelector('textarea'), null, 'and offers no prompt that could not run')
      view.unmount()
    })

    // 8. The project choice is offered because the HOST can change it, never
    // because a project already happens to be set or other workspaces happen to
    // be open. Both of those were the old condition, and both hid the picker —
    // and the Browse row inside it — at exactly the moment it was needed.
    await check('a project can be chosen with nothing open and nothing selected', async () => {
      seedStore()
      // No folder at all: what the New chat door looks like on a fresh app.
      const empty = await render({
        folderPath: null,
        projectOptions: [],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      const trigger = empty.find((el) => /choose a project/i.test(el.textContent ?? ''))
      assert.ok(trigger, 'with no project set the surface still offers to pick one')
      assert.equal(trigger?.tagName, 'BUTTON', 'and it is actionable, not a label')
      empty.unmount()

      // A folder, but no other workspace open — so no options to switch between.
      // Browse alone still has to be reachable.
      const soleProject = await render({
        folderPath: '/tmp/proj',
        projectOptions: [],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      const named = soleProject.find((el) => el.tagName === 'BUTTON' && /proj/.test(el.textContent ?? ''))
      assert.ok(named, 'the sole project is still a picker, because Browse is the point')
      soleProject.unmount()

      // The tab strip's "+": the project is a fact, not a choice, so no handlers
      // and no picker — the plain line is correct here and must not regress.
      const fixed = await render({ folderPath: '/tmp/proj' })
      assert.ok(fixed.text().includes('proj'), 'it still says where the agent will run')
      assert.equal(
        fixed.find((el) => el.tagName === 'BUTTON' && /choose a project/i.test(el.textContent ?? '')),
        undefined,
        'but offers no choice it cannot honour',
      )
      fixed.unmount()
    })

    // ── Remote machines (remote-sessions-ux / new-chat-on-a-remote-machine) ──

    const machine = (id: string, machineName: string): Record<string, unknown> => ({
      id,
      machineName,
      endpoint: `${id}.tail:7777`,
      deviceId: `d-${id}`,
      deviceName: 'this-mac',
      scopes: ['workspace:read', 'workspace:operate'],
    })
    const workspace = (id: string, name: string, folderPath: string | null = `/home/${name}`) => ({
      id,
      name,
      mode: 'standard',
      folderPath,
    })
    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
    const click = async (el: Element | null | undefined) => {
      assert.ok(el, 'the element to click exists')
      await act(async () => {
        el!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }
    const buttonWithText = (root: ParentNode, text: string) =>
      [...root.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim().startsWith(text))
    // Permissions moved inside the model picker (owner, 2026-09-05), onto the one
    // trailing row beside the effort control, so reaching the rows is two clicks:
    // the engine chip on the panel, then the permission chip in the picker. The
    // picker is portaled, so both live on the document rather than in the panel's
    // own container.
    const engineChip = (view: Harness) =>
      [...view.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )
    const openPermissionsMenu = async (view: Harness, label: string): Promise<Element> => {
      await click(engineChip(view))
      const trigger = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === `Permissions: ${label}`,
      )
      await click(trigger)
      const menu = dom.window.document.querySelector(`[role="menu"][aria-label="Permissions: ${label}"]`)
      assert.ok(menu, `the permission menu opens inside the model picker; wanted "Permissions: ${label}"`)
      return menu!
    }
    const machineTrigger = (view: Harness) =>
      view.container.querySelector<HTMLButtonElement>('[data-machine-trigger="true"]') ?? undefined
    const openMachineMenu = async (view: Harness) => {
      await click(machineTrigger(view))
      const menu = dom.window.document.querySelector('[role="menu"][aria-label="Machine this chat runs on"]')
      assert.ok(menu, 'the machine menu opens on the popover surface')
      return menu!
    }
    const pickMachine = async (view: Harness, name: string) => {
      const menu = await openMachineMenu(view)
      await click(buttonWithText(menu, name))
      await settle()
    }
    const remoteRender = async (props: Record<string, unknown> = {}) =>
      render({
        folderPath: '/proj',
        projectOptions: [{ path: '/proj', label: 'proj' }],
        onSelectProject: () => {},
        onLaunchRemote: async () => {},
        ...props,
      })

    await check(
      'the machine dropdown lists This device first and default, paired machines alphabetically after',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        fleetConnections = [machine('m2', 'Studio'), machine('m1', 'Air'), machine('m3', 'mini')]
        assert.deepEqual(
          sortMachines(fleetConnections as never).map((m) => m.machineName),
          ['Air', 'mini', 'Studio'],
        )
        const view = await remoteRender()
        await settle()
        const trigger = machineTrigger(view)
        assert.ok(trigger, 'the dropdown is offered once a machine is paired')
        assert.equal(
          trigger?.textContent?.trim(),
          'This device',
          'and opens on This device — never a remote on first open',
        )
        assert.equal(
          trigger?.querySelector('svg.icon-xs.shrink-0'),
          null,
          'no machine glyph on the trigger while local',
        )
        const menu = await openMachineMenu(view)
        const rows = [...menu.querySelectorAll('[role="menuitemradio"]')].map((row) =>
          (row.querySelector('span.min-w-0')?.textContent ?? '').trim(),
        )
        assert.equal(rows[0], 'This device', 'This device heads the list')
        assert.deepEqual(rows.slice(1), ['Air', 'mini', 'Studio'], 'then the machines, sorted')
        assert.equal(menu.querySelectorAll('[role="menu"]').length, 0, 'one menu role: the surface, no nested menu')
        view.unmount()
      },
    )

    await check(
      'picking a remote machine shows the glyph, requires an explicit project unless there is exactly one, and is remembered for the session',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        fleetConnections = [machine('m1', 'Air'), machine('m2', 'Mini')]
        fleetBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          terminalAccess: 'full',
          workspaces: id === 'm1' ? [workspace('w1', 'alpha'), workspace('w2', 'beta')] : [workspace('w9', 'solo')],
          terminals: [],
          gaps: [],
        })
        const view = await remoteRender()
        await settle()
        await pickMachine(view, 'Air')
        const trigger = machineTrigger(view)
        assert.ok(trigger?.textContent?.includes('Air'), 'the trigger names the machine')
        assert.ok(trigger?.querySelector('svg'), 'and wears the shared machine glyph only when remote')
        assert.ok(view.text().includes('Choose a project'), 'two projects → nobody picks for you')
        const projectTrigger = buttonWithText(view.container, 'Choose a project')
        await click(projectTrigger)
        const projects = dom.window.document.querySelector('[role="menu"][aria-label="Project on Air"]')
        assert.ok(projects, 'the remote project list opens')
        assert.equal(projects!.querySelectorAll('[role="menu"]').length, 0, 'no nested menu role')
        await click(buttonWithText(projects!, 'beta'))
        assert.ok(buttonWithText(view.container, 'beta'), 'an explicit pick is shown')
        view.unmount()

        // One project on the Mini: it is the only possible answer, so it is picked.
        const again = await remoteRender()
        await settle()
        assert.ok(machineTrigger(again)?.textContent?.includes('Air'), 'reopening keeps the session’s last machine')
        await pickMachine(again, 'Mini')
        assert.ok(buttonWithText(again.container, 'solo'), 'a lone project is chosen without a click')
        await pickMachine(again, 'This device')
        again.unmount()
        const fresh = await remoteRender()
        await settle()
        assert.equal(
          machineTrigger(fresh)?.textContent?.trim(),
          'This device',
          'choosing This device forgets the remote',
        )
        fresh.unmount()
      },
    )

    await check(
      "on Windows this computer's machines lead the dropdown, a pick rides the launch, and a WSL folder picks its distribution",
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        fleetConnections = []
        hostsAnswer = {
          hosts: [
            { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
            {
              id: 'wsl:Ubuntu',
              kind: 'wsl',
              label: 'WSL: Ubuntu',
              pathStyle: 'wsl',
              state: 'ready',
              isDefaultDistro: true,
              enabled: true,
            },
            { id: 'wsl:Debian', kind: 'wsl', label: 'WSL: Debian', pathStyle: 'wsl', state: 'stopped', enabled: true },
          ],
          wsl: { available: true },
        }
        try {
          const view = await render({
            folderPath: 'C:\\Users\\dev\\repo',
            projectOptions: [{ path: 'C:\\Users\\dev\\repo', label: 'repo' }],
            onSelectProject: () => {},
          })
          await settle()
          assert.equal(
            machineTrigger(view)?.textContent?.trim(),
            'This PC (Windows)',
            'a Windows folder starts on This PC, with no remote paired at all',
          )
          const menu = await openMachineMenu(view)
          const rows = [...menu.querySelectorAll('[role="menuitemradio"]')].map((row) =>
            (row.querySelector('span.min-w-0')?.textContent ?? '').trim(),
          )
          assert.deepEqual(rows.slice(0, 3), ['This PC (Windows)', 'WSL: Ubuntu', 'WSL: Debian'])
          assert.match(
            menu.querySelector('[data-machine-host="wsl:Ubuntu"]')?.textContent ?? '',
            /default$/u,
            'the default distribution is marked',
          )
          await click(buttonWithText(menu, 'WSL: Debian'))
          await settle()
          assert.equal(machineTrigger(view)?.textContent?.trim(), 'WSL: Debian')
          assert.ok(detectCalls.some((call) => JSON.stringify(call).includes('"hostId":"wsl:Debian"')))
          const start = [...view.container.querySelectorAll('button')].find(
            (button) => button.getAttribute('aria-label') === 'Start agent',
          )
          await act(async () => {
            start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
          })
          assert.equal(view.launches.at(-1)?.hostId, 'wsl:Debian', 'the machine rides the launch')
          view.unmount()

          // Debian is then turned off: the remembered pick no longer counts.
          const offered = hostsAnswer.hosts
          hostsAnswer = { ...hostsAnswer, hosts: offered.filter((host) => host.id !== 'wsl:Debian') }
          const afterOff = await render({
            folderPath: 'C:\\Users\\dev\\repo',
            projectOptions: [],
            onSelectProject: () => {},
          })
          await settle()
          assert.equal(
            machineTrigger(afterOff)?.textContent?.trim(),
            'This PC (Windows)',
            'a machine no longer offered',
          )
          afterOff.unmount()
          hostsAnswer = { ...hostsAnswer, hosts: offered }

          const inDistro = await render({
            folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
            projectOptions: [],
            onSelectProject: () => {},
          })
          await settle()
          assert.equal(machineTrigger(inDistro)?.textContent?.trim(), 'WSL: Ubuntu', 'the folder names its machine')
          const distroMenu = await openMachineMenu(inDistro)
          const debian = [...distroMenu.querySelectorAll<HTMLButtonElement>('[data-machine-host="wsl:Debian"]')][0]
          assert.equal(debian?.disabled, true, 'another distribution cannot take a folder inside this one')
          assert.match(debian?.textContent ?? '', /inside WSL: Ubuntu/u)
          inDistro.unmount()
        } finally {
          hostsAnswer = { hosts: [], wsl: null }
          resetRememberedMachineForTests()
        }
      },
    )

    await check('unreachable, unauthorized and workspace-gap machines say their real reason', async () => {
      seedStore()
      resetRememberedMachineForTests()
      fleetConnections = [machine('down', 'Down'), machine('revoked', 'Revoked'), machine('gap', 'Gap')]
      fleetBrowseAnswer = (id) => ({
        connectionId: id,
        reachable: id !== 'down',
        unreachableReason: id === 'down' ? 'Down is asleep.' : null,
        unauthorized: id === 'revoked',
        scopes: [],
        terminalAccess: 'full',
        workspaces: [],
        terminals: [],
        gaps:
          id === 'gap' ? [{ part: 'workspaces', code: 'scope', message: 'This pairing may not list workspaces.' }] : [],
      })
      const view = await remoteRender()
      await settle()
      const reasonFor = async (name: string) => {
        await pickMachine(view, name)
        await click(buttonWithText(view.container, 'Unavailable'))
        const menu = dom.window.document.querySelector(`[role="menu"][aria-label="Project on ${name}"]`)
        const text = menu?.textContent ?? ''
        await act(async () => {
          dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        return text
      }
      assert.ok((await reasonFor('Down')).includes('Down is asleep.'), 'unreachable carries the machine’s reason')
      assert.ok(/refused this pairing/.test(await reasonFor('Revoked')), 'unauthorized says re-pair')
      assert.ok(
        (await reasonFor('Gap')).includes('may not list workspaces'),
        'a scope gap is the gap’s message, never "no workspaces"',
      )
      view.unmount()
    })

    await check(
      'a remote launch refuses what cannot travel — attached images included — and refuses a second submit while one is in flight',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        fleetConnections = [machine('m1', 'Air')]
        fleetBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          terminalAccess: 'full',
          workspaces: [workspace('w1', 'alpha', '/srv/alpha')],
          terminals: [],
          gaps: [],
        })
        const remoteLaunches: Array<Record<string, unknown>> = []
        let release: () => void = () => {}
        const view = await remoteRender({
          onLaunchRemote: (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
            return new Promise<void>((resolve) => {
              release = resolve
            })
          },
        })
        await settle()
        await pickMachine(view, 'Air')
        const textarea = view.container.querySelector('textarea')!
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
          setter.call(textarea, 'fix the build')
          textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })

        // Drop an image: its chip stays on screen, so the refusal must name it.
        useToastStore.setState({ toasts: [] })
        const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
        const box = textarea.closest('[class*="relative"]')!
        const dropEvent = new dom.window.Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(dropEvent, 'dataTransfer', {
          value: { types: ['Files'], items: [{ kind: 'file', getAsFile: () => file }], files: [file] },
        })
        await act(async () => {
          box.dispatchEvent(dropEvent)
        })
        await settle()
        await settle()
        const enter = () =>
          act(async () => {
            textarea.dispatchEvent(
              new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            )
          })
        await enter()
        assert.equal(remoteLaunches.length, 0, 'nothing launched with an image attached')
        const refusal = useToastStore.getState().toasts.find((toast) => toast.title === 'That launch cannot travel yet')
        assert.ok(refusal, 'the stranded refusal is announced')
        assert.ok(
          refusal?.description?.includes('the attached images'),
          `it names the images; got: ${refusal?.description}`,
        )

        // Remove the image and launch: one Enter starts, the second is refused
        // while the first is still in flight.
        const remove = [...view.container.querySelectorAll('button')].find((button) =>
          /remove/i.test(button.getAttribute('aria-label') ?? ''),
        )
        await click(remove)
        await enter()
        await enter()
        assert.equal(remoteLaunches.length, 1, 'a second submit during an in-flight remote create is refused')
        assert.equal(
          remoteLaunches[0]?.remoteWorkspaceRoot,
          '/srv/alpha',
          'the launch carries the remote folder for provenance',
        )
        assert.equal(remoteLaunches[0]?.remoteWorkspaceName, 'alpha')
        await act(async () => {
          release()
        })
        await settle()
        await enter()
        assert.equal(remoteLaunches.length, 2, 'and is accepted once the first settles')
        view.unmount()
      },
    )

    await check(
      'a remote target disables the presets its gateway refuses and moves the choice with a note',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        fleetConnections = [machine('m1', 'Air')]
        fleetBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: [],
          terminalAccess: 'full',
          workspaces: [workspace('w1', 'alpha')],
          terminals: [],
          gaps: [],
        })
        const view = await remoteRender({ permissionPreset: 'bypass' })
        await settle()
        await pickMachine(view, 'Air')
        // The narrowing is what THIS launch runs on, not a rewrite of the stored
        // choice: every local launch of Claude Code still reads Bypass.
        assert.ok(/Switched permissions from Bypass permissions to Auto/.test(view.text()), 'and says so under the box')
        // Bypass shows as the nearest supported preset, Auto, for the remote.
        await openPermissionsMenu(view, 'Auto')
        assert.equal(storedCliPermissionPreset('claude-code'), undefined, 'and nothing is written for the CLI')
        view.unmount()

        const local = await remoteRender({ permissionPreset: 'auto' })
        await settle()
        await pickMachine(local, 'Air')
        const menu = await openPermissionsMenu(local, 'Auto')
        assert.equal(menu.querySelectorAll('[role="menu"]').length, 0, 'one menu role')
        const rows = [...menu.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')]
        assert.deepEqual(
          rows.map((row) => row.disabled),
          [true, false, false, true],
          'None and Bypass are disabled for a remote',
        )
        assert.equal(
          (menu.textContent ?? '').match(/Not available on a remote machine/g)?.length,
          2,
          'each with the one-line reason',
        )
        // Roving skips the disabled rows and wraps.
        const checked = rows.find((row) => row.getAttribute('aria-checked') === 'true')!
        assert.equal(dom.window.document.activeElement, checked, 'focus lands on the checked row on open')
        assert.equal(checked.tabIndex, 0, 'which is the one tab stop')
        const key = (el: Element, k: string) =>
          act(async () => {
            el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
          })
        await key(checked, 'ArrowDown')
        assert.equal(
          dom.window.document.activeElement,
          rows[1],
          'ArrowDown from Auto wraps past Bypass and None to Manual',
        )
        await key(rows[1]!, 'End')
        assert.equal(dom.window.document.activeElement, rows[2], 'End lands on the last enabled row')
        await key(rows[2]!, 'Home')
        assert.equal(dom.window.document.activeElement, rows[1], 'Home on the first enabled row')
        local.unmount()
      },
    )

    // The worktree question lives in ONE place now (owner, 2026-09-11): the ⋯
    // row, for a local target and a remote one alike. The scope line used to
    // grow a "Current checkout" chip and a branch segment the moment a remote
    // project was picked, which asked the same question twice on one surface.
    const openMore = async (view: { container: Element }) => {
      const more = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'More launch options',
      )
      await click(more)
      return dom.window.document.querySelector('[aria-label="More launch options"][role="menu"]')!
    }
    const worktreeRowOf = (menu: Element) =>
      [...menu.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        (button.textContent ?? '').startsWith('Worktree'),
      )

    await check(
      'the scope line carries no checkout control, and the ⋯ worktree row is what sends a remote launch to a fresh worktree',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        fleetConnections = [machine('m1', 'Air')]
        fleetBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: ['workspace:operate', 'terminal:control'],
          terminalAccess: 'control',
          workspaces: [workspace('w1', 'alpha', '/srv/alpha')],
          terminals: [],
          gaps: [],
        })
        const checkoutReads: string[] = []
        fleetCheckoutAnswer = (_c, workspaceId) => {
          checkoutReads.push(workspaceId)
          return {
            ok: true,
            checkout: {
              workspaceId,
              git: true,
              branch: 'main',
              defaultBranch: 'main',
              branches: [
                { name: 'feat/x', current: false },
                { name: 'main', current: true },
              ],
              worktrees: [{ path: '/srv/alpha', branch: 'main', isMain: true }],
            },
          }
        }
        const remoteLaunches: Array<Record<string, unknown>> = []
        const view = await remoteRender({
          onLaunchRemote: async (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
          },
        })
        await settle()
        await pickMachine(view, 'Air')
        await settle()
        // The checkout is still READ on the pick — the ⋯ row's gate is built from
        // it — but nothing on the scope line reports it.
        assert.deepEqual(checkoutReads, ['w1'], 'the lone project is picked, and its checkout read once')
        assert.equal(
          view.container.querySelector('[data-checkout-trigger="true"]'),
          null,
          'no checkout chip on the scope line',
        )
        assert.equal(view.container.querySelector('[data-branch-trigger="true"]'), null, 'and no branch picker')
        assert.equal(view.container.querySelector('[data-branch-fact="true"]'), null, 'and no branch fact')

        const textarea = view.container.querySelector('textarea')!
        const type = (value: string) =>
          act(async () => {
            const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
            setter.call(textarea, value)
            textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
          })
        const enter = () =>
          act(async () => {
            textarea.dispatchEvent(
              new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            )
          })
        await type('fix the build')
        await enter()
        await settle()
        assert.deepEqual(
          remoteLaunches[0]?.checkout,
          { mode: 'current' },
          'with no worktree asked for, the current checkout travels',
        )
        assert.equal(remoteLaunches[0]?.branch, 'main', 'with the branch the panel read, for the row')

        // Turn the ⋯ row on and the same launch forks a worktree over there,
        // based on the remote checkout's own branch.
        const menu = await openMore(view)
        const row = worktreeRowOf(menu)
        assert.ok(row, 'the worktree row is offered once a remote project is picked')
        assert.equal(row!.disabled, false, 'and a workspace:operate pairing may take it')
        await click(row)
        await settle()
        const branchInput = dom.window.document.querySelector<HTMLInputElement>('[aria-label="Worktree branch name"]')
        assert.ok(branchInput, 'and reveals the branch field')
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
          setter.call(branchInput!, 'fix/build')
          branchInput!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
        await settle()
        await type('fix the build again')
        await enter()
        await settle()
        assert.deepEqual(
          remoteLaunches[1]?.checkout,
          { mode: 'worktree', baseRef: 'main', name: 'fix/build' },
          'the worktree request carries the typed branch name and forks the remote’s own branch',
        )
        assert.equal(remoteLaunches[1]?.branch, null, 'the worktree’s branch is minted there, so none is claimed here')
        view.unmount()
      },
    )

    await check(
      'the ⋯ worktree row stays closed while the checkout is being read, and a detached remote forks its trunk',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        fleetConnections = [machine('m1', 'Air')]
        fleetBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes: ['workspace:operate', 'terminal:control'],
          terminalAccess: 'control',
          workspaces: [workspace('w1', 'alpha')],
          terminals: [],
          gaps: [],
        })
        let release: (value: Record<string, unknown>) => void = () => {}
        fleetCheckoutAnswer = () =>
          new Promise<Record<string, unknown>>((resolve) => {
            release = resolve
          }) as never
        const remoteLaunches: Array<Record<string, unknown>> = []
        const view = await remoteRender({
          onLaunchRemote: async (launch: Record<string, unknown>) => {
            remoteLaunches.push(launch)
          },
        })
        await settle()
        await pickMachine(view, 'Air')
        await settle()
        let menu = await openMore(view)
        let row = worktreeRowOf(menu)!
        assert.equal(row.disabled, true, 'while the checkout is unread the worktree row is closed')
        assert.ok(row.textContent?.includes('Reading the checkout'), 'and says it is reading')
        await act(async () => {
          dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        // The read lands on a detached checkout: no branch, a trunk to fork.
        await act(async () => {
          release({
            ok: true,
            checkout: {
              workspaceId: 'w1',
              git: true,
              branch: null,
              defaultBranch: 'main',
              branches: [{ name: 'main', current: false }],
              worktrees: [],
            },
          })
        })
        await settle()
        menu = await openMore(view)
        row = worktreeRowOf(menu)!
        assert.equal(row.disabled, false, 'once read, a repo with a trunk can fork')
        await click(row)
        await settle()
        const textarea = view.container.querySelector('textarea')!
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
          setter.call(textarea, 'go')
          textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
        await act(async () => {
          textarea.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        await settle()
        assert.deepEqual(
          remoteLaunches[0]?.checkout,
          { mode: 'worktree', baseRef: 'main' },
          'the trunk is the base when there is no branch, and an unnamed worktree sends no name',
        )
        view.unmount()
        fleetCheckoutAnswer = (_c, workspaceId) => ({
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
      },
    )

    await check(
      'a pairing without workspace:operate, an unreadable checkout, and a non-repo each dim the ⋯ worktree row with the real reason',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        fleetConnections = [machine('m1', 'Air')]
        let scopes: string[] = ['terminal:control']
        fleetBrowseAnswer = (id) => ({
          connectionId: id,
          reachable: true,
          unreachableReason: null,
          unauthorized: false,
          scopes,
          terminalAccess: 'control',
          workspaces: [workspace('w1', 'alpha')],
          terminals: [],
          gaps: [],
        })
        const reasonFor = async () => {
          const view = await remoteRender()
          await settle()
          await pickMachine(view, 'Air')
          await settle()
          const menu = await openMore(view)
          const row = worktreeRowOf(menu)!
          const hint = row.textContent ?? ''
          const disabled = row.disabled ? 'true' : null
          await click(row)
          await settle()
          const opened = dom.window.document
            .querySelector('[aria-label="Worktree branch name"]')
            ?.getAttribute('aria-hidden')
          view.unmount()
          return { hint, disabled, opened }
        }
        const scopeless = await reasonFor()
        assert.equal(scopeless.disabled, 'true', 'no workspace:operate ⇒ the row is dimmed, not removed')
        assert.ok(scopeless.hint.includes('workspace:operate'), `the reason names the scope; got: ${scopeless.hint}`)
        assert.equal(scopeless.opened, 'true', 'and clicking it opens nothing')

        scopes = ['workspace:operate', 'terminal:control']
        fleetCheckoutAnswer = () => ({
          ok: false,
          code: 'tailnet_scope_required',
          message: 'This device is not granted "workspace:read".',
        })
        const unreadable = await reasonFor()
        assert.equal(unreadable.disabled, 'true')
        assert.ok(
          unreadable.hint.includes('not granted "workspace:read"'),
          'an unreadable checkout carries the gateway’s words',
        )

        fleetCheckoutAnswer = (_c, workspaceId) => ({
          ok: true,
          checkout: { workspaceId, git: false, branch: null, defaultBranch: null, branches: [], worktrees: [] },
        })
        const plain = await reasonFor()
        assert.equal(plain.disabled, 'true')
        assert.ok(plain.hint.includes('not a git repository'), 'a non-repo says so')
        fleetCheckoutAnswer = (_c, workspaceId) => ({
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
      },
    )

    await check(
      'with a project in hand the machine list says which machines have it, picking one keeps the project, and This device returns to the local clone',
      async () => {
        seedStore()
        resetRememberedMachineForTests()
        const sprintengine = {
          canonicalKey: 'github.com/acme/sprintengine',
          remoteUrl: 'git@github.com:acme/sprintengine.git',
          name: 'sprintengine',
        }
        localIdentityAnswer = (folderPath) => (folderPath === '/proj' ? sprintengine : null)
        fleetConnections = [machine('m1', 'Air'), machine('m2', 'Mini'), machine('m3', 'Down')]
        const browsed: string[] = []
        fleetBrowseAnswer = (id) => {
          browsed.push(id)
          return {
            connectionId: id,
            reachable: id !== 'm3',
            unreachableReason: id === 'm3' ? 'Down is asleep.' : null,
            unauthorized: false,
            scopes: ['workspace:operate', 'terminal:control'],
            terminalAccess: 'control',
            workspaces:
              id === 'm1'
                ? [
                    {
                      ...workspace('w1', 'other', '/srv/other'),
                      repository: { canonicalKey: 'github.com/acme/other', remoteUrl: '', name: 'other' },
                    },
                    { ...workspace('w2', 'sprintengine-air', '/srv/sprintengine'), repository: sprintengine },
                  ]
                : [{ ...workspace('w9', 'scratch', '/srv/scratch'), repository: null }],
            terminals: [],
            gaps: [],
          }
        }
        const selected: string[] = []
        const view = await remoteRender({
          folderPath: '/proj',
          projectOptions: [
            { path: '/proj', label: 'proj' },
            { path: '/other', label: 'other' },
          ],
          onSelectProject: (path: string) => selected.push(path),
        })
        await settle()
        await settle()
        assert.deepEqual(browsed, [], 'nothing is asked until the list is opened')
        const menu = await openMachineMenu(view)
        await settle()
        await settle()
        assert.deepEqual(browsed.sort(), ['m1', 'm2', 'm3'], 'opening the list asks every machine what it holds — once')
        const rowsByName = new Map(
          [...menu.querySelectorAll<HTMLButtonElement>('[data-machine-option="true"]')].map((row) => [
            (row.querySelector('span.block')?.textContent ?? row.textContent ?? '').trim(),
            row,
          ]),
        )
        const air = rowsByName.get('Air')!
        const mini = rowsByName.get('Mini')!
        const down = rowsByName.get('Down')!
        assert.equal(air.getAttribute('data-machine-availability'), 'has')
        assert.equal(air.disabled, false)
        assert.ok(air.textContent?.includes('Has sprintengine'), `the row names the copy; got: ${air.textContent}`)
        assert.equal(mini.getAttribute('data-machine-availability'), 'lacks')
        assert.equal(mini.disabled, true, 'a machine without the project is dimmed, not removed')
        assert.ok(
          mini.textContent?.includes('No copy of sprintengine on Mini'),
          `with the reason; got: ${mini.textContent}`,
        )
        assert.equal(down.disabled, true)
        assert.ok(down.textContent?.includes('Down is asleep.'), 'an unreachable machine carries its reason')
        assert.equal(rowsByName.get('This device')!.disabled, false, 'This device is always open')

        await click(air)
        await settle()
        await settle()
        // The chip names the FOLDER, not the chat standing in it: `w2` is a
        // conversation called "sprintengine-air" open in /srv/sprintengine, and the
        // project the launch is scoped to is /srv/sprintengine.
        assert.equal(
          view.container.querySelector('[data-project-trigger="true"]')?.textContent?.trim(),
          'sprintengine',
          'picking the machine keeps the project: its copy is chosen, not the first row',
        )
        assert.equal(browsed.filter((id) => id === 'm1').length, 2, 'the pick re-reads the machine for freshness')

        // Back to This device: the local clone of the same repository is the project.
        await pickMachine(view, 'This device')
        await settle()
        assert.equal(selected.length, 0, 'the door was already on /proj, the local clone, so nothing is re-selected')
        assert.equal(machineTrigger(view)?.textContent?.trim(), 'This device')
        view.unmount()

        // From a remote project to This device when the door is scoped elsewhere.
        resetRememberedMachineForTests()
        const elsewhere = await remoteRender({
          folderPath: '/other',
          projectOptions: [
            { path: '/proj', label: 'proj' },
            { path: '/other', label: 'other' },
          ],
          onSelectProject: (path: string) => selected.push(path),
        })
        await settle()
        await pickMachine(elsewhere, 'Air')
        await settle()
        // Two projects on the Air and none in hand (/other has no identity): an explicit pick.
        await click(buttonWithText(elsewhere.container, 'Choose a project'))
        const projects = dom.window.document.querySelector('[role="menu"][aria-label="Project on Air"]')!
        // The row is the folder /srv/sprintengine, whatever the chat standing in it
        // happens to be called over there.
        await click(
          [...projects.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((row) =>
            (row.textContent ?? '').includes('/srv/sprintengine'),
          ),
        )
        await settle()
        await pickMachine(elsewhere, 'This device')
        await settle()
        assert.deepEqual(selected, ['/proj'], 'This device keeps the project by selecting the open local clone of it')
        elsewhere.unmount()
        localIdentityAnswer = () => null
      },
    )

    // The chip and its menu were lifted out of this file into ProjectScopePicker
    // so the Design door can ask the same question with the same control. New chat
    // must be unchanged by the move: the chip is still here, and it still offers
    // BOTH sources — Browse… and Import from Git.
    await check('the lifted project chip still opens New chat’s own sources', async () => {
      seedStore()
      resetRememberedMachineForTests()
      fleetConnections = []
      const view = await render({
        folderPath: '/proj',
        projectOptions: [
          { path: '/proj', label: 'proj' },
          { path: '/other', label: 'other' },
        ],
        onSelectProject: () => {},
        onBrowseProject: () => {},
      })
      await settle()
      const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
      assert.ok(trigger, 'the scope line still carries the project chip')
      await click(trigger)
      await settle()
      const menu = dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')
      assert.ok(menu, 'the chip opens the shared project menu')
      assert.ok(buttonWithText(menu!, 'Browse…'), 'Browse… is still offered')
      assert.ok(buttonWithText(menu!, 'Import from Git'), 'and so is the Git import')
      assert.ok(buttonWithText(menu!, 'other'), 'with the open projects under them')
      view.unmount()
    })

    // ── One colour per project, on the scope line ────────────────────────────
    // Owner ruling 2026-09-09, backlog item
    // `one-colour-per-project-on-the-folder-glyph`, decision 7: "I keep opening
    // up a new chat and forgetting to pick the project." The fix is that a chosen
    // project and no project stop LOOKING alike — a solid folder in the project's
    // own hue against a dashed, colourless one reading "Choose a project".

    // The glyph is the first svg inside the control; the chevron follows it. Its
    // hue is the angle it carries, or null when it wears none.
    const glyphMark = (el: Element | null | undefined): number | null => {
      const hue = el?.querySelector('svg')?.getAttribute('data-project-hue')
      return hue === null || hue === undefined ? null : Number(hue)
    }
    const glyphIsUnfiled = (el: Element | null | undefined): boolean => {
      const glyph = el?.querySelector('svg')
      return Boolean(glyph?.querySelector('path')?.getAttribute('stroke-dasharray'))
    }
    const seedColours = (): void => {
      useWorkspaceStore.setState(
        (state) =>
          ({
            appSettings: { ...state.appSettings, projectColors: {} },
          }) as never,
      )
    }

    await check(
      'the scope line wears the project’s colour, and no project at all wears the dashed folder',
      async () => {
        seedStore()
        seedColours()
        resetRememberedMachineForTests()
        fleetConnections = []
        const sprintengine = {
          canonicalKey: 'github.com/acme/sprintengine',
          remoteUrl: 'git@github.com:acme/sprintengine.git',
          name: 'sprintengine',
        }
        localIdentityAnswer = (folderPath) => (folderPath === '/proj' ? sprintengine : null)

        const view = await render({
          folderPath: '/proj',
          projectOptions: [
            { path: '/proj', label: 'proj' },
            { path: '/other', label: 'other' },
          ],
          onSelectProject: () => {},
          onBrowseProject: () => {},
        })
        await settle()
        await settle()
        const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
        const mark = glyphMark(trigger)
        assert.ok(
          mark,
          `the chosen project’s chip carries a hue; got class ${trigger?.querySelector('svg')?.getAttribute('class')}`,
        )
        assert.equal(glyphIsUnfiled(trigger), false, 'and a solid folder, because this IS a project')
        // The hue is hashed from the REPOSITORY key, not the folder: two clones of
        // one repo are one project and one hue (decision 3). Derived, so nothing
        // is written — the map holds only what a person chose.
        assert.equal(
          mark,
          projectHue('repo:github.com/acme/sprintengine'),
          'the chip wears the hue hashed from the repository key',
        )
        assert.deepEqual(useWorkspaceStore.getState().appSettings.projectColors ?? {}, {}, 'and nothing is stored')
        // The list is where a person chooses BETWEEN projects, so the rows carry
        // their own colours rather than only the chip that opened them.
        await click(trigger)
        await settle()
        const menu = dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')
        assert.ok(menu, 'the chip opens the project menu')
        const chosenRow = [...menu!.querySelectorAll('[role="menuitemradio"]')].find((row) =>
          (row.textContent ?? '').includes('/proj'),
        )
        assert.equal(glyphMark(chosenRow), mark, 'the row for the chosen project wears the same hue as the chip')
        view.unmount()

        // No project at all: the dashed, colourless folder and the words that say
        // there is a choice to make. And no hint text under it — the owner cut that.
        seedColours()
        const empty = await render({
          folderPath: null,
          projectOptions: [],
          onSelectProject: () => {},
          onBrowseProject: () => {},
        })
        await settle()
        const emptyTrigger = empty.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
        assert.ok(emptyTrigger?.textContent?.includes('Choose a project'), 'it says there is a project to choose')
        assert.equal(glyphMark(emptyTrigger), null, 'no folder is not a project, so it has no hue')
        assert.equal(
          glyphIsUnfiled(emptyTrigger),
          true,
          'and the outline is dashed, not a solid folder waiting on a colour',
        )
        assert.deepEqual(
          useWorkspaceStore.getState().appSettings.projectColors,
          {},
          'and nothing was written: an unfiled chat is not a project',
        )
        empty.unmount()
        localIdentityAnswer = () => null
      },
    )

    await check('the same repository on a paired machine wears the same hue as the local clone', async () => {
      seedStore()
      seedColours()
      resetRememberedMachineForTests()
      const sprintengine = {
        canonicalKey: 'github.com/acme/sprintengine',
        remoteUrl: 'git@github.com:acme/sprintengine.git',
        name: 'sprintengine',
      }
      localIdentityAnswer = (folderPath) => (folderPath === '/proj' ? sprintengine : null)
      fleetConnections = [machine('m1', 'Air')]
      fleetBrowseAnswer = (id) => ({
        connectionId: id,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        scopes: ['workspace:operate'],
        terminalAccess: 'control',
        workspaces: [
          {
            ...workspace('w1', 'other', '/srv/other'),
            repository: { canonicalKey: 'github.com/acme/other', remoteUrl: '', name: 'other' },
          },
          { ...workspace('w2', 'sprintengine-air', '/srv/sprintengine'), repository: sprintengine },
        ],
        terminals: [],
        gaps: [],
      })
      const view = await remoteRender()
      await settle()
      await settle()
      const localMark = glyphMark(view.container.querySelector('[data-project-trigger="true"]'))
      assert.ok(localMark, 'the local clone has a hue to match')

      await pickMachine(view, 'Air')
      await settle()
      await settle()
      // Two projects on the Air, but one of them is the repository in hand, so
      // the machine pick keeps the project.
      const remoteTrigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
      assert.equal(
        remoteTrigger?.textContent?.trim(),
        'sprintengine',
        `the remote copy is the picked project; got ${remoteTrigger?.textContent}`,
      )
      assert.equal(
        glyphMark(remoteTrigger),
        localMark,
        'and it wears the SAME hue: the machine is a glyph on the line, never a second colour',
      )
      assert.equal(glyphIsUnfiled(remoteTrigger), false, 'a picked remote project is a project')

      // The machine's own list is where a person picks one project out of a
      // dozen, so its rows carry the hues too — and the row for the repository
      // open here is the colour it is here.
      await click(remoteTrigger)
      await settle()
      const remoteMenu = dom.window.document.querySelector('[role="menu"][aria-label="Project on Air"]')!
      const rows = [...remoteMenu.querySelectorAll('[role="menuitemradio"]')]
      // The rows are FOLDERS: /srv/sprintengine and /srv/other, not the chats
      // standing in them.
      const twinRow = rows.find((row) => (row.textContent ?? '').includes('/srv/sprintengine'))
      const strangerRow = rows.find((row) => (row.textContent ?? '').includes('/srv/other'))
      assert.equal(glyphMark(twinRow), localMark, 'the row for the repository open here wears the hue it wears here')
      assert.equal(
        glyphMark(strangerRow),
        projectHue('repo:github.com/acme/other'),
        'a repository this app has never opened still has its hue: it is hashed from the name, not handed out on sight',
      )
      view.unmount()
      localIdentityAnswer = () => null
      fleetConnections = []
    })

    await check(
      'every state of the scope line wears the hue: the plain line, a folder with no remote, and a recent clone of the open project',
      async () => {
        seedStore()
        seedColours()
        resetRememberedMachineForTests()
        fleetConnections = []
        const sprintengine = {
          canonicalKey: 'github.com/acme/sprintengine',
          remoteUrl: 'git@github.com:acme/sprintengine.git',
          name: 'sprintengine',
        }
        localIdentityAnswer = (folderPath) => (folderPath === '/proj' || folderPath === '/clone' ? sprintengine : null)

        // The tab strip's "+": the project is a fact rather than a choice, so the
        // line is a `<p>` and not a control — and it still wears the colour, or the
        // hue stops being how you tell one project from another.
        const fixed = await render({ folderPath: '/proj' })
        await settle()
        await settle()
        const line = [...fixed.container.querySelectorAll('p')].find((el) => (el.textContent ?? '').includes('proj'))
        assert.ok(line, 'the plain scope line is there')
        assert.equal(
          fixed.container.querySelector('[data-project-trigger="true"]'),
          null,
          'and it is a line, not a chip — this host offers no choice it cannot honour',
        )
        const fixedMark = glyphMark(line)
        assert.ok(
          fixedMark,
          `the plain line carries the hue too; got ${line?.querySelector('svg')?.getAttribute('class')}`,
        )
        assert.equal(glyphIsUnfiled(line), false, 'and a solid folder')
        fixed.unmount()

        // A folder with no remote is still a project — keyed by its path, because
        // that is the only identity it has. It must not stay colourless.
        seedColours()
        const noRemote = await render({
          folderPath: '/plain',
          projectOptions: [{ path: '/plain', label: 'plain' }],
          onSelectProject: () => {},
        })
        await settle()
        await settle()
        const noRemoteMark = glyphMark(noRemote.container.querySelector('[data-project-trigger="true"]'))
        assert.equal(
          noRemoteMark,
          projectHue('folder:/plain'),
          'a folder with no remote wears the hue of its folder key once its identity read has ANSWERED',
        )
        noRemote.unmount()

        // A recent clone of the OPEN project is the same project, so it is the same
        // hue — a grey row beside its blue twin is exactly the confusion the colour
        // exists to end. The recents are the picker's own rows, so it asks for
        // their identities itself.
        seedColours()
        useWorkspaceStore.setState(
          (state) =>
            ({
              appSettings: { ...state.appSettings, recentWorkspaceFolders: ['/clone'] },
            }) as never,
        )
        const view = await render({
          folderPath: '/proj',
          projectOptions: [{ path: '/proj', label: 'proj' }],
          onSelectProject: () => {},
          onBrowseProject: () => {},
        })
        await settle()
        await settle()
        const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
        const mark = glyphMark(trigger)
        assert.ok(mark, 'the open clone has a hue')
        await click(trigger)
        await settle()
        await settle()
        const menu = dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')!
        const recentRow = [...menu.querySelectorAll('[role="menuitemradio"]')].find((row) =>
          (row.textContent ?? '').includes('/clone'),
        )
        assert.ok(recentRow, 'the recent folder is offered')
        assert.equal(
          glyphMark(recentRow),
          mark,
          'and it wears the same hue as the open clone: one repository is one project',
        )
        assert.equal(
          mark,
          projectHue('repo:github.com/acme/sprintengine'),
          'because both clones read ONE key: the repository’s',
        )
        view.unmount()
        useWorkspaceStore.setState(
          (state) =>
            ({
              appSettings: { ...state.appSettings, recentWorkspaceFolders: [] },
            }) as never,
        )
        localIdentityAnswer = () => null
      },
    )

    await check('a remote project the machine could not identify takes no hue and no key', async () => {
      seedStore()
      seedColours()
      resetRememberedMachineForTests()
      // No identity on this disk either, so the machine list has no project to
      // filter by and the Air is pickable; the point of the check is what happens
      // to the REMOTE key, not to the local one.
      localIdentityAnswer = () => null
      fleetConnections = [machine('m1', 'Air')]
      // One workspace, so it is picked without a click — and its machine reported
      // no repository, which is what an older peer and a non-repo folder both do.
      fleetBrowseAnswer = (id) => ({
        connectionId: id,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        scopes: ['workspace:operate'],
        terminalAccess: 'control',
        workspaces: [{ ...workspace('w1', 'mystery', '/srv/mystery'), repository: null }],
        terminals: [],
        gaps: [],
      })
      const view = await remoteRender()
      await settle()
      await settle()
      const before = { ...useWorkspaceStore.getState().appSettings.projectColors }
      await pickMachine(view, 'Air')
      await settle()
      await settle()
      const trigger = view.container.querySelector<HTMLButtonElement>('[data-project-trigger="true"]')
      assert.ok(trigger?.textContent?.includes('mystery'), `the lone project is picked; got ${trigger?.textContent}`)
      assert.equal(
        glyphMark(trigger),
        null,
        'with no hue: its path is a path on ANOTHER disk, never a key this one can match',
      )
      assert.equal(
        glyphIsUnfiled(trigger),
        false,
        'and a solid glyph, not the dashed one — there IS a folder, we just cannot say which repository it is',
      )
      assert.deepEqual(
        useWorkspaceStore.getState().appSettings.projectColors,
        before,
        'and no hue was burned on a key nothing will ever resolve to again',
      )
      view.unmount()
      localIdentityAnswer = () => null
      fleetConnections = []
    })

    await check('the local access menu walks with the arrows and selects on Enter', async () => {
      seedStore()
      resetRememberedMachineForTests()
      fleetConnections = []
      const view = await render({ permissionPreset: 'manual' })
      const menu = await openPermissionsMenu(view, 'Manual')
      const rows = [...menu.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')]
      assert.equal(rows.length, 4)
      assert.ok(rows[0]?.textContent?.includes('None'), 'the no-flag row says None, not "CLI default"')
      assert.ok(menu.textContent?.includes('Default'), 'and still wears the Default chip')
      assert.ok(menu.querySelector('.rounded-xs'), 'on the token chip radius')
      assert.equal(dom.window.document.activeElement, rows[1], 'focus opens on the checked row')
      const key = (el: Element, k: string) =>
        act(async () => {
          el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
        })
      await key(rows[1]!, 'ArrowUp')
      assert.equal(dom.window.document.activeElement, rows[0])
      await key(rows[0]!, 'ArrowUp')
      assert.equal(dom.window.document.activeElement, rows[3], 'ArrowUp wraps to the end')
      await key(rows[3]!, 'Enter')
      assert.equal(
        storedCliPermissionPreset('claude-code'),
        'bypass',
        'Enter selects the focused row, and the pick is remembered for the CLI it was made on',
      )
      view.unmount()
    })

    // One permission mode per CLI, not per model (owner ruling 2026-09-24):
    // choosing Bypass while one Claude model is highlighted is choosing it for
    // every Claude model, it outlives the app, and Codex keeps its own.
    await check(
      'a permission pick on one model applies to every model of that CLI, survives a reload, and leaves Codex alone',
      async () => {
        const claude = {
          id: 'claude-code',
          displayName: 'Claude Code',
          source: 'bundled',
          version: 1,
          binary: 'claude',
          resumeSession: true,
          sessionIdFromCaller: true,
          modelSelection: {
            options: [
              { id: 'claude-opus-5', label: 'Opus 5' },
              { id: 'claude-sonnet-5', label: 'Sonnet 5' },
            ],
            allowCustomId: true,
          },
          reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
        }
        const codex = {
          id: 'codex',
          displayName: 'Codex',
          source: 'bundled',
          version: 1,
          binary: 'codex',
          resumeSession: true,
          sessionIdFromCaller: true,
          modelSelection: {
            options: [
              { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
              { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
            ],
            allowCustomId: true,
          },
          reasoningSelection: { levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], default: 'medium' },
        }
        seedStore({ plugins: [claude, codex] })
        const modelRow = (label: string) =>
          [...dom.window.document.querySelectorAll('[data-model-row="true"]')].find((row) =>
            (row.textContent ?? '').includes(label),
          )
        const hover = async (label: string) => {
          const row = modelRow(label)
          assert.ok(row, `the ${label} row is in the picker`)
          await act(async () => {
            row!.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }))
          })
        }
        const chip = (label: string) => dom.window.document.querySelector(`[aria-label="Permissions: ${label}"]`)
        const tab = (name: string) =>
          [...dom.window.document.querySelectorAll('button')].find(
            (button) => button.getAttribute('role') === 'radio' && button.getAttribute('aria-label') === name,
          )

        const view = await render({ permissionPreset: 'manual' })
        await click(engineChip(view))
        await hover('Opus 5')
        await click(chip('Manual') as HTMLElement)
        const bypass = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')].find(
          (row) => row.textContent?.startsWith('Bypass'),
        )
        await click(bypass)
        assert.equal(storedCliPermissionPreset('claude-code'), 'bypass', 'the pick is stored for Claude Code')

        await hover('Sonnet 5')
        assert.ok(chip('Bypass permissions'), 'Sonnet shows the Bypass that was chosen on Opus')
        await click(tab('Codex'))
        await hover('GPT-5.6 Sol')
        assert.ok(chip('Manual'), 'Codex keeps its own value, the app-wide default it never moved from')
        assert.equal(chip('YOLO'), null, 'and does not inherit Claude’s bypass')
        assert.equal(storedCliPermissionPreset('codex'), undefined)
        view.unmount()

        // A reload reads the store back from storage, the way an app restart does.
        __reloadCliPermissionPresetsForTest()
        const again = await render({ permissionPreset: 'manual' })
        await click(engineChip(again))
        await click(tab('Claude Code'))
        await hover('Sonnet 5')
        assert.ok(chip('Bypass permissions'), 'the Claude Code choice survives the reload')
        const sonnet = modelRow('Sonnet 5')
        await act(async () => {
          sonnet!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
        const start = [...again.container.querySelectorAll('button')].find(
          (button) => button.getAttribute('aria-label') === 'Start agent',
        )
        await click(start)
        assert.equal(again.launches[0]?.cli, 'claude-code')
        assert.equal(again.launches[0]?.model, 'claude-sonnet-5')
        assert.equal(
          resolveCliPermissionPreset('claude-code', 'manual'),
          'bypass',
          'and the launch host resolves Bypass for a model it was never chosen on',
        )
        again.unmount()
      },
    )

    // ── The parked draft (new-chat-survives-back-and-forward) ─────────────────
    // The door's surface seeds from the draft parked under its key and writes
    // every change back, so an unmount from any direction loses nothing; the
    // host, not the surface, decides when the draft is forgotten.
    await check(
      'with a draft key the surface resumes the parked prompt and images, and writes changes through',
      async () => {
        const { readNewChatDraft, writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
        resetNewChatDraftsForTests()
        const shot = { id: 'img-1', mediaType: 'image/png', dataBase64: 'AAAA', byteLength: 4, path: '/tmp/shot.png' }
        writeNewChatDraft('win-1', { prompt: 'review the auth flow', images: [shot], folderPath: '/w/app' })
        const view = await render({ draftKey: 'win-1' })
        const textarea = view.container.querySelector('textarea')
        assert.equal(textarea?.value, 'review the auth flow', 'the parked words are back in the box')
        assert.ok(view.container.querySelector('img[src^="data:image/png"]'), 'and so is the pasted screenshot')
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
          setter?.call(textarea, 'review the auth flow, then the session store')
          textarea!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
        assert.equal(
          readNewChatDraft('win-1')?.prompt,
          'review the auth flow, then the session store',
          'typing is parked as it happens',
        )
        assert.equal(
          readNewChatDraft('win-1')?.folderPath,
          '/w/app',
          'the surface never touches the scope the host owns',
        )
        view.unmount()
        assert.equal(
          readNewChatDraft('win-1')?.prompt,
          'review the auth flow, then the session store',
          "unmounting forgets nothing — forgetting is the host's call",
        )
        resetNewChatDraftsForTests()
      },
    )

    // A draft can also carry the ENGINE its pick was made on, for the one caller
    // that picks a row and deliberately stores nothing: a card's `Go` picker
    // (item 2473, ruling R4b). Choosing how to run one card must not move the
    // engine of the next New chat, so the row travels in the draft instead — and
    // the door has to open standing on it and launch it, or the pick is lost
    // between the press and the composer.
    await check('a draft carrying an engine opens the door on that row and launches it, storing nothing', async () => {
      seedStore()
      const { writeNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      const { useWorkspaceStore } = await import('../../../store/workspaceStore')
      resetNewChatDraftsForTests()
      writeNewChatDraft('win-1', {
        prompt: 'set up the design system',
        folderPath: '/w/app',
        selection: { kind: 'general' },
        engine: { cli: 'claude-code', model: 'a-parked-model', reasoning: 'high' },
      })
      const view = await render({ draftKey: 'win-1' })
      const engine = [...view.container.querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? '').startsWith('Engine: '),
      )
      assert.ok(
        (engine?.getAttribute('aria-label') ?? '').includes('a-parked-model'),
        'the door opens standing on the row the draft carried',
      )
      const start = [...view.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Start agent',
      )
      await act(async () => {
        start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(view.launches[0]?.model, 'a-parked-model', 'and launches on it')
      assert.equal(view.launches[0]?.reasoning, 'high', 'at the effort that was chosen with it')
      assert.equal(
        useWorkspaceStore.getState().appSettings.lastSelectedAgentModel,
        null,
        'and standing on a parked row writes no remembered engine of its own',
      )
      view.unmount()
      resetNewChatDraftsForTests()
    })

    await check('without a draft key the surface keeps its per-tab state and parks nothing', async () => {
      const { readNewChatDraft, resetNewChatDraftsForTests } = await import('./newChatDraft')
      resetNewChatDraftsForTests()
      const view = await render()
      const textarea = view.container.querySelector('textarea')
      assert.equal(textarea?.value, '')
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(textarea, 'tab-local words')
        textarea!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      assert.equal(readNewChatDraft('win-1'), null, 'the tab-strip host has no draft')
      view.unmount()
    })

    if (failures > 0) {
      console.error(`NewAgentPanel.test.tsx: ${failures} failing check(s)`)
      process.exit(1)
    }
    console.log('NewAgentPanel.test.tsx: ok')
  }

  const suiteRun = main()

  await suiteRun
})
