import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// MC-2147 — the launch surface behind the tab strip's "+". Rendered for real,
// because the acceptance is about what a person sees and presses:
//
//   1. every launch argument is on the surface, and the receipt line under them
//      is the invocation main says a spawn would make;
//   2. Start hands the host a confirm plus the typed prompt — and creates
//      nothing itself;
//   3. a suggestion card spawns on click, carrying its own full prompt;
//   4. the skill trigger is the CLI's declared one, and a CLI that declares
//      none keeps the "+ Skill" chip instead of borrowing a "/";
//   5. with no agent CLI installed the surface offers the install route rather
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

;(dom.window as unknown as { api: Record<string, unknown> }).api = {
  platform: 'darwin',
  getGitRepoRoot: async () => '/proj',
  agentLaunchPreview: async (input: Record<string, unknown>) => {
    previewCalls.push(input)
    return {
      ok: true,
      preview: { binary: 'claude', args: PREVIEW_DISPLAY.split(' ').slice(1), display: PREVIEW_DISPLAY },
    }
  },
  // The skill type-ahead reads the picker's inventory; an empty one is enough
  // to prove the trigger opens (and keeps this test off the capability service).
  agentCapabilities: async () => ({ ok: true, support: 'native', harnessId: 'claude', skills: [], diagnostics: [] }),
  builtinSkillsList: async () => [],
  workspaceSkillsList: async () => ({ ok: true, skills: [] }),
}

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const NewAgentPanel = (await import('./NewAgentPanel')).default
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')

  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
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
    closes: number
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
          permissionPreset: 'auto_workspace',
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
    return {
      container,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
      launches,
      closes,
      text: () => container.textContent ?? '',
      find: (predicate) =>
        [...container.querySelectorAll('button, span, p')].find((el) =>
          predicate(el as HTMLElement),
        ) as HTMLElement | undefined,
    }
  }

  // 1. Every argument, and a receipt line that is main's answer verbatim.
  await check('the surface shows the arguments and the command a launch would run', async () => {
    seedStore()
    previewCalls.length = 0
    const view = await render()
    const text = view.text()

    assert.ok(text.includes('What needs doing?'), 'the headline asks for the task')
    assert.ok(text.includes('multicode'), 'the scope line names the project the agent will run in')
    assert.ok(text.includes('Default') && text.includes('Auto') && text.includes('Bypass'), 'approval is on the row')
    assert.ok(text.includes('+ Worktree'), 'worktree is offered inside a git repo')
    assert.ok(text.includes('+ Connector'), 'the connector attachment is offered')
    assert.ok(/debug/i.test(text), 'debug is on the row')

    assert.ok(
      text.includes(PREVIEW_DISPLAY),
      `the receipt shows main's own line; got: ${text.slice(0, 400)}`,
    )
    assert.equal(previewCalls.length >= 1, true, 'the surface asked main rather than composing the line itself')
    assert.equal(previewCalls[0]?.cli, 'claude-code', 'it asked about the selected agent’s CLI')
    assert.equal(
      previewCalls[0]?.cliPermissionPreset,
      'auto_workspace',
      'and forwarded the approval preset, so the line moves when the chip does',
    )
    assert.ok(!('debugMode' in (previewCalls[0] ?? {})), 'debug is a prompt concern and stays out of the receipt')

    view.unmount()
  })

  // 2. Start hands the host a confirm plus the prompt, and creates nothing.
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

    const start = [...view.container.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').startsWith('Start'),
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

  // 3. A card is a launch button, and it carries the bank's real prompt.
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

  // 4. The trigger is the CLI's own, and its absence is not papered over.
  await check('the skill trigger comes from the manifest', async () => {
    seedStore()
    const withPrefix = await render()
    assert.ok(
      (withPrefix.container.querySelector('textarea')?.getAttribute('placeholder') ?? '').includes('type / for skills'),
      'a claude runtime advertises its own slash trigger',
    )
    assert.ok(!withPrefix.text().includes('+ Skill'), 'and needs no chip, because the prompt takes it')
    withPrefix.unmount()

    // opencode declares no mention prefix: no type-ahead, and the chip returns.
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
    const placeholder = noPrefix.container.querySelector('textarea')?.getAttribute('placeholder') ?? ''
    assert.ok(!placeholder.includes('type'), `a CLI with no typed form advertises none; got "${placeholder}"`)
    assert.ok(noPrefix.text().includes('+ Skill'), 'and keeps the picker, because the route cannot be typed')
    noPrefix.unmount()
  })

  // 5. Nothing installed: the install route, not live-looking controls.
  await check('with no agent CLI the surface offers the install route', async () => {
    seedStore({ plugins: [] })
    const view = await render()
    const text = view.text()
    assert.ok(text.includes('No agent CLI is installed'), 'it says so plainly')
    assert.equal(view.container.querySelector('textarea'), null, 'and offers no prompt that could not run')
    view.unmount()
  })

  if (failures > 0) {
    console.error(`NewAgentPanel.test.tsx: ${failures} failing check(s)`)
    process.exit(1)
  }
  console.log('NewAgentPanel.test.tsx: ok')
}

void main()
