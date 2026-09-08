import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The project selector's sources (remote-sessions-ux /
// project-selector-sources). The Git step's repo machinery is the shipped
// MC-2207 code, pinned by test:renderer:github-clone; what this file pins is
// the selector's own anatomy, and the stepped Git view's behaviour: step swap,
// back with state preserved, inline clone error, a failed clone leaving the
// selection untouched, and Escape from the Git step.

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
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0)
anyGlobal.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

let repoAnswer: () => Promise<Record<string, unknown>> = async () => ({ ok: false, reason: 'no_token' })
;(dom.window as unknown as { api: Record<string, unknown> }).api = {
  platform: 'darwin',
  listGitHubRepos: () => repoAnswer(),
}

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ProjectSourceMenu } = await import('./ProjectSourceMenu')
  const { Popover } = await import('../../ui/Popover')

  let failures = 0
  const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  const noClone = async () => ({ ok: false as const, message: 'unused' })
  const markup = renderToStaticMarkup(
    <ProjectSourceMenu
      options={[
        { path: '/w/multicode', label: 'multicode' },
        { path: '/w/toolbox', label: 'toolbox' },
      ]}
      recentOptions={[{ path: '/w/old-repo', label: 'old-repo' }]}
      selectedPath="/w/multicode"
      defaultParent="/w"
      onSelect={() => {}}
      onBrowse={() => {}}
      onClone={noClone}
      onClose={() => {}}
    />
  )

  await check('the selector opens on a search field over the project rows', () => {
    assert.match(markup, /aria-label="Search projects"/)
    const search = markup.indexOf('Search projects')
    const firstRow = markup.indexOf('multicode')
    assert.ok(search !== -1 && firstRow !== -1 && search < firstRow, 'search leads the list')
  })

  await check('project rows are stacked menu items: name over mono path, selection by bg.selected', () => {
    assert.match(markup, /role="menuitemradio" aria-checked="true"/)
    assert.match(markup, /font-mono/, 'the path reads in the mono voice')
    assert.match(markup, /--bg-selected/, 'the choice wears the neutral selection wash')
  })

  await check('the body is the list layer, not a second menu: the hosting popover surface carries the role', () => {
    assert.doesNotMatch(markup, /role="menu"/, 'no nested role="menu"')
  })

  await check('known-but-closed projects sit under a Recent group label and are searched too', () => {
    assert.match(markup, /aria-label="Recent"/)
    assert.match(markup, /old-repo/)
  })

  await check('the sources lead: Browse… and Import from Git sit between the search field and the projects', () => {
    assert.match(markup, /role="separator"/)
    assert.match(markup, /Browse…/)
    assert.match(markup, /Import from Git/)
    const search = markup.indexOf('Search projects')
    const browse = markup.indexOf('Browse…')
    const importGit = markup.indexOf('Import from Git')
    const separator = markup.indexOf('role="separator"')
    const firstProject = markup.indexOf('multicode')
    assert.ok(search < browse && browse < importGit, 'Browse… then Import, directly under the search field')
    assert.ok(importGit < separator && separator < firstProject, 'the separator parts the sources from the projects, which grow below it')
  })

  await check('a host without a folder dialog gets no Browse… row, and Import stays', () => {
    const noBrowse = renderToStaticMarkup(
      <ProjectSourceMenu
        options={[]}
        selectedPath={null}
        defaultParent={null}
        onSelect={() => {}}
        onClone={noClone}
        onClose={() => {}}
      />
    )
    assert.doesNotMatch(noBrowse, /Browse…/)
    assert.match(noBrowse, /Import from Git/)
    assert.match(noBrowse, /No matching projects\./)
  })

  // ── The stepped Git view, rendered for real inside the hosting Popover ──

  type Mounted = {
    unmount: () => void
    selections: string[]
    closes: () => number
    clones: Array<Record<string, unknown>>
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
    })
  const click = (el: Element | null | undefined) => {
    assert.ok(el, 'element to click exists')
    return act(async () => {
      el!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }
  const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  const buttonWithText = (root: ParentNode, text: string) =>
    [...root.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim().startsWith(text))
  const surface = () => dom.window.document.querySelector('[role="menu"][aria-label="Project this agent runs in"]')

  const mount = async (
    cloneResult: () => Promise<{ ok: true; path: string } | { ok: false; message: string }>,
  ): Promise<Mounted> => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const selections: string[] = []
    const clones: Array<Record<string, unknown>> = []
    let closes = 0
    function Host() {
      const [open, setOpen] = React.useState(true)
      return (
        <Popover
          open={open}
          onOpenChange={setOpen}
          ariaLabel="Project this agent runs in"
          popupRole="menu"
          renderTrigger={({ ref, triggerProps, togglePopover }) => (
            <button ref={ref} type="button" onClick={togglePopover} {...triggerProps}>
              proj
            </button>
          )}
        >
          <ProjectSourceMenu
            options={[{ path: '/w/multicode', label: 'multicode' }]}
            selectedPath="/w/multicode"
            defaultParent="/w"
            onSelect={(path) => selections.push(path)}
            onBrowse={() => {}}
            onClone={(request) => {
              clones.push(request)
              return cloneResult()
            }}
            onClose={() => {
              closes += 1
              setOpen(false)
            }}
          />
        </Popover>
      )
    }
    await act(async () => {
      root.render(<Host />)
    })
    await settle()
    return {
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
      selections,
      closes: () => closes,
      clones,
    }
  }

  await check('Import from Git swaps the same surface to the repo step, and back preserves the search', async () => {
    repoAnswer = async () => ({ ok: false, reason: 'no_token' })
    const view = await mount(async () => ({ ok: false, message: 'unused' }))
    try {
      const search = surface()!.querySelector<HTMLInputElement>('[aria-label="Search projects"]')!
      await type(search, 'multi')
      await click(buttonWithText(surface()!, 'Import from Git'))
      await settle()
      assert.ok(surface(), 'still the one popover surface — no second dialog')
      assert.ok(surface()!.querySelector('[aria-label="Repository URL"]'), 'the Git step shows the URL lane')
      assert.equal(surface()!.querySelector('[aria-label="Search projects"]'), null, 'the project step is gone')
      assert.ok(/Settings → Version control/.test(surface()!.textContent ?? ''), 'no token → the inline pointer, not an error')
      const url = surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!
      await type(url, 'https://github.com/acme/repo')
      await click(buttonWithText(surface()!, '←'))
      await settle()
      const searchAgain = surface()!.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
      assert.ok(searchAgain, 'back returns to the projects step')
      assert.equal(searchAgain!.value, 'multi', 'with the search preserved')
      await click(buttonWithText(surface()!, 'Import from Git'))
      await settle()
      assert.equal(
        surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!.value,
        'https://github.com/acme/repo',
        'and the Git step keeps its URL draft too',
      )
      assert.equal(view.closes(), 0, 'stepping never closes the selector')
    } finally {
      view.unmount()
    }
  })

  await check('a failed clone surfaces git’s error inline and leaves the selection untouched', async () => {
    repoAnswer = async () => ({ ok: false, reason: 'no_token' })
    const view = await mount(async () => ({ ok: false, message: 'fatal: repository not found' }))
    try {
      await click(buttonWithText(surface()!, 'Import from Git'))
      await settle()
      const url = surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!
      await type(url, 'https://github.com/acme/missing')
      assert.ok(/Clones into w\//.test(surface()!.textContent ?? ''), 'the target parent is named')
      await click(buttonWithText(surface()!, 'Clone'))
      await settle()
      assert.equal(view.clones.length, 1, 'the host was asked to clone')
      assert.equal(view.clones[0]?.parentDir, '/w')
      assert.equal(view.clones[0]?.folderName, 'missing')
      const alert = surface()!.querySelector('[role="alert"]')
      assert.equal(alert?.textContent, 'fatal: repository not found', 'git’s message, inline')
      assert.deepEqual(view.selections, [], 'nothing was selected')
      assert.equal(view.closes(), 0, 'and the selector stays open on the Git step')
    } finally {
      view.unmount()
    }
  })

  await check('a clone that succeeds closes the selector; adoption is the host’s, so a closed selector loses nothing', async () => {
    repoAnswer = async () => ({ ok: false, reason: 'no_token' })
    let resolveClone: (value: { ok: true; path: string }) => void = () => {}
    const view = await mount(() => new Promise((resolve) => { resolveClone = resolve }))
    try {
      await click(buttonWithText(surface()!, 'Import from Git'))
      await settle()
      await type(surface()!.querySelector<HTMLInputElement>('[aria-label="Repository URL"]')!, 'https://github.com/acme/repo')
      await click(buttonWithText(surface()!, 'Clone'))
      assert.ok(buttonWithText(surface()!, 'Cloning…'), 'progress reads on the button')
      // The selector closes before the clone lands (Escape).
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      await settle()
      assert.equal(surface(), null, 'Escape closes the selector from the Git step')
      await act(async () => {
        resolveClone({ ok: true, path: '/w/repo' })
      })
      await settle()
      assert.deepEqual(view.selections, [], 'the menu does not select into a closed panel — the host adopted it')
      assert.equal(view.clones.length, 1)
    } finally {
      view.unmount()
    }
  })

  await check('a cold start with no parent to clone beside says what to do rather than "open a project first"', async () => {
    const cold = renderToStaticMarkup(
      <ProjectSourceMenu
        options={[]}
        selectedPath={null}
        defaultParent={null}
        onSelect={() => {}}
        onClone={noClone}
        onClose={() => {}}
      />
    )
    assert.doesNotMatch(cold, /Open a project first/)
  })

  if (failures > 0) {
    console.error(`ProjectSourceMenu.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('ProjectSourceMenu.test.tsx: ok')
}

void main()
