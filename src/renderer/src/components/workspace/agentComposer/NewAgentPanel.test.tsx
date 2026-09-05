import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// MC-2147 — the launch surface behind the tab strip's "+". Rendered for real,
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

;(dom.window as unknown as { api: Record<string, unknown> }).api = {
  platform: 'darwin',
  getGitRepoRoot: async () => '/proj',
  fleetListConnections: async () => fleetConnections,
  fleetBrowse: async (connectionId: string) => fleetBrowseAnswer(connectionId),
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
    { id: 'backlog', name: 'backlog', version: '1', description: 'Work a backlog item end to end', targetPolicy: 'all-native' },
    { id: 'design-system', name: 'design-system', version: '1', description: 'Build UI from the attached design system', targetPolicy: 'all-native' },
  ],
  workspaceSkillsList: async () => ({ ok: true, skills: [] }),
  // The Skills & MCPs picker's install-on-pick and add-on-pick paths.
  agentSkillAttach: async (input: Record<string, unknown>) => {
    attachCalls.push(input)
    return { ok: true, skillId: input.skillId, targets: [{ path: '.claude/skills/x', status: 'installed' }] }
  },
  mcpListCatalog: async () => ({
    ok: true,
    servers: [
      { id: 'linear', name: 'Linear', description: 'Issues and projects', transport: 'http', url: 'https://mcp.linear.app/sse', clients: ['claude-code'], riskLevel: 'network' },
    ],
  }),
  mcpSync: async (input: Record<string, unknown>) => {
    syncCalls.push(input)
    if (syncFailure) return { ok: false, message: syncFailure }
    const settings = input.settings as { servers: Record<string, unknown> }
    return { ok: true, targets: [{ client: 'claude-code', path: '/proj/.mcp.json', serverIds: Object.keys(settings.servers) }], issues: [] }
  },
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
  const { useToastStore } = await import('../../../store/toastStore')

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
          ...(useWorkspaceStore.getState().workspaces[0] ?? {}),
          id: 'ws-1',
          name: 'multicode',
          folderPath: '/proj',
          mode: 'standard',
          agents: {},
          layoutModel: undefined,
        },
      ] as never,
      activeWorkspaceId: 'ws-1',
      pluginCatalogEntries: plugins as never,
      pluginCatalogStatus: 'ready' as never,
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
          onChangePermissionPreset: () => {},
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
        [...container.querySelectorAll('button, span, p')].find((el) =>
          predicate(el as HTMLElement),
        ) as HTMLElement | undefined,
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
    assert.ok(!text.includes('multicode'), 'and not the workspace’s own name')
    assert.ok(text.includes('Auto'), 'access carries its own value on the chip — here, the seeded preset')
    assert.ok(text.includes('Skills & MCPs'), 'the one picker for skills and MCP servers is offered')
    assert.ok(text.includes('⋯'), 'the overflow is there')

    assert.ok(!text.includes('+ Worktree'), 'worktree is not on the row until it is set')
    assert.ok(!text.includes('+ Skill') && !text.includes('+ Connector'), 'the two old chips are gone')
    assert.ok(!text.includes('Role'), 'no role control anywhere on the row')
    assert.ok(!/debug/i.test(text), 'nor is debug')
    assert.ok(!text.includes('Architect'), 'and no role picker sits where the model goes')

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
    assert.ok(bypassed.text().includes('Bypass'), 'the chip reads Bypass when that is the preset')
    const chip = [...bypassed.container.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('Bypass'),
    )
    assert.ok(
      (chip?.className ?? '').includes('tone-warn'),
      'and wears the warn tone, not the ordinary accent',
    )
    bypassed.unmount()
  })

  // 1b. The ⋯ menu holds exactly what the row does not — which is now two
  //     things. Role left with the specialist picker; reasoning effort moved
  //     into the model's own picker, where it is a property of the model.
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
    assert.ok(!menuText.includes('Role'), 'the specialist picker is gone from this surface entirely')
    assert.ok(!menuText.includes('Reasoning'), 'and reasoning lives in the model picker now')
    // Debug is about the user's software, not the agent.
    assert.ok(
      /instruments your code/i.test(menuText),
      `debug says what it actually does; got: ${menuText}`,
    )

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
    const terminalRow = [...(menu?.querySelectorAll('button') ?? [])].find(
      (button) => (button.textContent ?? '').startsWith('Terminal'),
    )
    await act(async () => {
      terminalRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    const text = view.text()
    // The fixture seeds auto, so the access chip would read "Auto".
    assert.ok(!text.includes('Auto'), 'a shell has no permission preset')
    assert.ok(!text.includes('Opus'), 'and no model')

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
    assert.ok(
      !SUGGESTION_BANK.some((entry) => text.includes(entry.title)),
      'no suggestion cards for a plain shell',
    )
    const promptField = view.container.querySelector('textarea')
    assert.equal(promptField?.disabled, true, 'and no prompt to type into')
    assert.ok(
      (promptField?.getAttribute('placeholder') ?? '').includes('nothing typed'),
      'which says why',
    )

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
    const agentRow = [...(backMenu?.querySelectorAll('button') ?? [])].find(
      (button) => (button.textContent ?? '').startsWith('Agent'),
    )
    assert.ok(agentRow, 'and still offers Agent')
    await act(async () => {
      agentRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const back = view.text()
    assert.ok(back.includes('Auto'), 'picking Agent brings the permission control back')
    assert.equal(
      view.container.querySelector('textarea')?.disabled,
      false,
      'and the prompt is typeable again',
    )
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
    assert.ok(
      !(chatRow?.querySelector('.truncate')),
      'no truncation inside a row whose text IS the explanation',
    )
    view.unmount()
  })

  await check('the surface asks the host for the conversation catalog', async () => {
    seedStore()
    let requests = 0
    const view = await render({ onRequestConversationCatalog: () => { requests += 1 } })
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
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
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
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
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
    const surface = () => dom.window.document.querySelector('[role="dialog"][aria-label="Skills and MCPs"]') as HTMLElement | null
    assert.ok(surface(), 'the picker opened')
    const text = surface()!.textContent ?? ''
    for (const label of ['Skills in this workspace', 'Available to install', 'MCP servers', 'Install', 'Add', 'Included', 'sprintengine-studio']) {
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
    assert.equal(surface()!.querySelector('[data-picker-row="skill:backlog"]')?.getAttribute('aria-selected'), 'true', 'the row is checked')
    assert.ok(view.find((el) => el.getAttribute('aria-label') === 'Remove skill backlog'), 'and a chip appears')
    assert.equal(attachCalls.length, 0, 'an installed skill installs nothing')

    // Keyboard: ↓ to the installable skill, ⏎ installs it and checks it.
    await act(async () => {
      input!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const designRow = surface()!.querySelector('[data-picker-row="skill:design-system"]') as HTMLElement | null
    assert.equal(input!.getAttribute('aria-activedescendant'), designRow?.id, 'the highlight moved to the Install row')
    await act(async () => {
      input!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle()
    assert.deepEqual(attachCalls.map((call) => call.skillId), ['design-system'], 'Enter installed it before anything else')
    assert.ok(view.find((el) => el.getAttribute('aria-label') === 'Remove skill design-system'), 'and it became a chip')

    // A catalog MCP server: added to settings and synced into the workspace before it is a pick.
    const linearRow = surface()!.querySelector('[data-picker-row="mcp:linear"]') as HTMLElement | null
    assert.ok(linearRow, 'the catalog server is listed')
    await act(async () => {
      linearRow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle()
    assert.equal(syncCalls.length, 1, 'the workspace config was synced once')
    const synced = syncCalls[0] as { workspaceRoot: string; settings: { servers: Record<string, { clients: string[]; enabled: boolean }> } }
    assert.equal(synced.workspaceRoot, '/proj')
    assert.ok(synced.settings.servers.linear?.enabled, 'with the server enabled')
    assert.ok(synced.settings.servers.linear?.clients.includes('claude-code'), 'reaching the launch CLI')
    assert.ok(view.find((el) => el.getAttribute('aria-label') === 'Remove MCP server Linear'), 'and it became a chip')
    assert.deepEqual(synced.clients, ['claude-code'], 'the sync is scoped to the launch CLI')

    // The picks ride the confirm in pick order.
    const start = view.find((el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Start agent')
    await act(async () => {
      start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const launch = view.launches[0] as { skills?: Array<{ id: string }>; mcpServers?: Array<{ id: string }> } | undefined
    assert.deepEqual(launch?.skills?.map((skill) => skill.id), ['backlog', 'design-system'])
    assert.deepEqual(launch?.mcpServers?.map((server) => server.id), ['linear'])
    view.unmount()
  })

  // 5c. A sync that fails leaves nothing behind: the app's MCP settings are
  //     put back and the row says why.
  await check('a failed MCP sync rolls the settings back and stays on the row', async () => {
    seedStore()
    // The previous check added Linear to the app's settings; this one needs
    // it back in the catalog-only state.
    useWorkspaceStore.getState().removeMcpServer('linear')
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
    assert.equal(view.find((el) => el.getAttribute('aria-label') === 'Remove MCP server Linear'), undefined, 'no chip')
    assert.equal(useWorkspaceStore.getState().appSettings.mcp?.servers?.linear, undefined, 'the settings were put back')
    syncFailure = null
    view.unmount()
  })

  // 6. The greeting: a name when there is one, and a sentence either way.
  await check('the greeting uses a first name only when there is one', async () => {
    seedStore()
    useWorkspaceStore.setState({
      authState: { ...useWorkspaceStore.getState().authState, user: { id: 'u', email: 'c@example.com', displayName: 'Conal Smith', photoUrl: null } },
    } as never)
    const named = await render()
    assert.ok(named.text().includes('Conal'), 'it greets by first name, not full name')
    assert.ok(!named.text().includes('Smith'), 'and not by surname')
    named.unmount()

    useWorkspaceStore.setState({
      authState: { ...useWorkspaceStore.getState().authState, user: null },
    } as never)
    const anon = await render()
    const text = anon.text()
    assert.ok(!text.includes('Conal'), 'signed out, no name')
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
    const named = soleProject.find(
      (el) => el.tagName === 'BUTTON' && /proj/.test(el.textContent ?? ''),
    )
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
    render({ folderPath: '/proj', projectOptions: [{ path: '/proj', label: 'proj' }], onSelectProject: () => {}, onLaunchRemote: async () => {}, ...props })

  await check('the machine dropdown lists This Mac first and default, paired machines alphabetically after', async () => {
    seedStore()
    resetRememberedMachineForTests()
    fleetConnections = [machine('m2', 'Studio'), machine('m1', 'Air'), machine('m3', 'mini')]
    assert.deepEqual(sortMachines(fleetConnections as never).map((m) => m.machineName), ['Air', 'mini', 'Studio'])
    const view = await remoteRender()
    await settle()
    const trigger = machineTrigger(view)
    assert.ok(trigger, 'the dropdown is offered once a machine is paired')
    assert.equal(trigger?.textContent?.trim(), 'This Mac', 'and opens on This Mac — never a remote on first open')
    assert.equal(trigger?.querySelector('svg.icon-xs.shrink-0'), null, 'no machine glyph on the trigger while local')
    const menu = await openMachineMenu(view)
    const rows = [...menu.querySelectorAll('[role="menuitemradio"]')].map(
      (row) => (row.querySelector('span.min-w-0')?.textContent ?? '').trim(),
    )
    assert.equal(rows[0], 'This Mac', 'This Mac heads the list')
    assert.deepEqual(rows.slice(1), ['Air', 'mini', 'Studio'], 'then the machines, sorted')
    assert.equal(menu.querySelectorAll('[role="menu"]').length, 0, 'one menu role: the surface, no nested menu')
    view.unmount()
  })

  await check('picking a remote machine shows the glyph, requires an explicit project unless there is exactly one, and is remembered for the session', async () => {
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
    await pickMachine(again, 'This Mac')
    again.unmount()
    const fresh = await remoteRender()
    await settle()
    assert.equal(machineTrigger(fresh)?.textContent?.trim(), 'This Mac', 'choosing This Mac forgets the remote')
    fresh.unmount()
  })

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
      gaps: id === 'gap' ? [{ part: 'workspaces', code: 'scope', message: 'This pairing may not list workspaces.' }] : [],
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
    assert.ok((await reasonFor('Gap')).includes('may not list workspaces'), 'a scope gap is the gap’s message, never "no workspaces"')
    view.unmount()
  })

  await check('a remote launch refuses what cannot travel — attached images included — and refuses a second submit while one is in flight', async () => {
    seedStore()
    resetRememberedMachineForTests()
    fleetConnections = [machine('m1', 'Air')]
    fleetBrowseAnswer = (id) => ({
      connectionId: id, reachable: true, unreachableReason: null, unauthorized: false, scopes: [],
      terminalAccess: 'full', workspaces: [workspace('w1', 'alpha', '/srv/alpha')], terminals: [], gaps: [],
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
        textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
    await enter()
    assert.equal(remoteLaunches.length, 0, 'nothing launched with an image attached')
    const refusal = useToastStore.getState().toasts.find((toast) => toast.title === 'That launch cannot travel yet')
    assert.ok(refusal, 'the stranded refusal is announced')
    assert.ok(refusal?.description?.includes('the attached images'), `it names the images; got: ${refusal?.description}`)

    // Remove the image and launch: one Enter starts, the second is refused
    // while the first is still in flight.
    const remove = [...view.container.querySelectorAll('button')].find((button) =>
      /remove/i.test(button.getAttribute('aria-label') ?? ''),
    )
    await click(remove)
    await enter()
    await enter()
    assert.equal(remoteLaunches.length, 1, 'a second submit during an in-flight remote create is refused')
    assert.equal(remoteLaunches[0]?.remoteWorkspaceRoot, '/srv/alpha', 'the launch carries the remote folder for provenance')
    assert.equal(remoteLaunches[0]?.remoteWorkspaceName, 'alpha')
    await act(async () => {
      release()
    })
    await settle()
    await enter()
    assert.equal(remoteLaunches.length, 2, 'and is accepted once the first settles')
    view.unmount()
  })

  await check('a remote target disables the presets its gateway refuses and moves the choice with a note', async () => {
    seedStore()
    resetRememberedMachineForTests()
    fleetConnections = [machine('m1', 'Air')]
    fleetBrowseAnswer = (id) => ({
      connectionId: id, reachable: true, unreachableReason: null, unauthorized: false, scopes: [],
      terminalAccess: 'full', workspaces: [workspace('w1', 'alpha')], terminals: [], gaps: [],
    })
    const changes: string[] = []
    const view = await remoteRender({
      permissionPreset: 'bypass',
      onChangePermissionPreset: (preset: string) => changes.push(preset),
    })
    await settle()
    await pickMachine(view, 'Air')
    assert.deepEqual(changes, ['auto'], 'Bypass moves to the nearest supported preset, Auto')
    assert.ok(/Switched permissions from Bypass permissions to Auto/.test(view.text()), 'and says so under the box')
    view.unmount()

    const local = await remoteRender({ permissionPreset: 'auto' })
    await settle()
    await pickMachine(local, 'Air')
    await click(buttonWithText(local.container, 'Auto'))
    const menu = dom.window.document.querySelector('[role="menu"][aria-label="Permissions: Auto"]')
    assert.ok(menu, 'the access menu opens on the surface')
    assert.equal(menu!.querySelectorAll('[role="menu"]').length, 0, 'one menu role')
    const rows = [...menu!.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')]
    assert.deepEqual(rows.map((row) => row.disabled), [true, false, false, true], 'CLI default and Bypass are disabled for a remote')
    assert.equal((menu!.textContent ?? '').match(/Not available on a remote machine/g)?.length, 2, 'each with the one-line reason')
    // Roving skips the disabled rows and wraps.
    const checked = rows.find((row) => row.getAttribute('aria-checked') === 'true')!
    assert.equal(dom.window.document.activeElement, checked, 'focus lands on the checked row on open')
    assert.equal(checked.tabIndex, 0, 'which is the one tab stop')
    const key = (el: Element, k: string) =>
      act(async () => {
        el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
      })
    await key(checked, 'ArrowDown')
    assert.equal(dom.window.document.activeElement, rows[1], 'ArrowDown from Auto wraps past Bypass and CLI default to Manual')
    await key(rows[1]!, 'End')
    assert.equal(dom.window.document.activeElement, rows[2], 'End lands on the last enabled row')
    await key(rows[2]!, 'Home')
    assert.equal(dom.window.document.activeElement, rows[1], 'Home on the first enabled row')
    local.unmount()
  })

  await check('the local access menu walks with the arrows and selects on Enter', async () => {
    seedStore()
    resetRememberedMachineForTests()
    fleetConnections = []
    const changes: string[] = []
    const view = await render({ permissionPreset: 'manual', onChangePermissionPreset: (p: string) => changes.push(p) })
    await click(buttonWithText(view.container, 'Manual'))
    const menu = dom.window.document.querySelector('[role="menu"][aria-label="Permissions: Manual"]')!
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]')]
    assert.equal(rows.length, 4)
    assert.ok(menu.textContent?.includes('Default'), 'the CLI-default row wears the Default chip')
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
    assert.deepEqual(changes, ['bypass'], 'Enter selects the focused row')
    view.unmount()
  })

  // ── The parked draft (new-chat-survives-back-and-forward) ─────────────────
  // The door's surface seeds from the draft parked under its key and writes
  // every change back, so an unmount from any direction loses nothing; the
  // host, not the surface, decides when the draft is forgotten.
  await check('with a draft key the surface resumes the parked prompt and images, and writes changes through', async () => {
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
    assert.equal(readNewChatDraft('win-1')?.prompt, 'review the auth flow, then the session store', 'typing is parked as it happens')
    assert.equal(readNewChatDraft('win-1')?.folderPath, '/w/app', 'the surface never touches the scope the host owns')
    view.unmount()
    assert.equal(readNewChatDraft('win-1')?.prompt, 'review the auth flow, then the session store', 'unmounting forgets nothing — forgetting is the host\'s call')
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

void main()
