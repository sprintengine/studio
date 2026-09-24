import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('ProviderRow', async () => {
  // ProviderRow (item 1994) is an anatomy contract, so this suite drives the real
  // component in a real DOM: the two axes staying independent, the disclosure
  // keeping its position, and the state never resting on colour are all behaviour
  // a markup snapshot cannot check. The source-contract assertions at the end
  // cover the two host wirings a single mounted row cannot observe.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  // `await import` inside main(), and a CJS bundle: assigning globalThis.navigator
  // above only works in sloppy mode, and ESM is always strict.
  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { ProviderRow } = await import('./ProviderRow')
    const { resolveCliProviderState, cliProviderStateWords } = await import('./cliProviderState')
    const { CliProviderStateLine } = await import('./CliProviderStateLine')

    type Root = ReturnType<typeof createRoot>

    function mount(node: React.ReactNode): { host: HTMLElement; root: Root; render: (next: React.ReactNode) => void } {
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      act(() => root.render(node))
      return {
        host,
        root,
        render: (next) => act(() => root.render(next)),
      }
    }

    function unmount(root: Root, host: HTMLElement): void {
      act(() => root.unmount())
      host.remove()
    }

    const BASE = {
      icon: <span data-testid="mark">CL</span>,
      name: 'Claude',
      stateLine: 'Ready',
    } as const

    // ---------------------------------------------------------------------------
    // Two lines, a dot, and a version that is present or absent — never a placeholder
    // ---------------------------------------------------------------------------
    {
      const { host, root } = mount(
        <ProviderRow {...BASE} health="good" version="2.1.220" stateLine="Authenticated as octocat" />,
      )
      const text = host.textContent ?? ''
      assert.match(text, /Claude/, 'the name renders')
      assert.match(text, /2\.1\.220/, 'a known version renders')
      assert.match(text, /Authenticated as octocat/, 'the state line renders')

      const dot = host.querySelector('span[aria-hidden="true"][style*="background-color"]')
      assert.ok(dot, 'the health dot renders')
      assert.equal(
        dot?.getAttribute('aria-hidden'),
        'true',
        'the dot is decorative — the state line, not the colour, carries the state',
      )
      const dotStyle = (dot as HTMLElement).getAttribute('style') ?? ''
      assert.match(dotStyle, /var\(--tone-good\)/, 'the dot reads its colour from the tone token')

      // The 2px keyline is what keeps the dot legible against the mark it sits on.
      assert.match(dot?.className ?? '', /shadow-\[0_0_0_2px_var\(--bg-surface\)\]/)

      // No box per row: rows separate by spacing, and by the hover fill where the
      // face is actionable (asserted on the disclosable row below).
      const rowBox = host.firstElementChild?.firstElementChild as HTMLElement
      assert.doesNotMatch(rowBox.className, /\bborder\b/, 'the row draws no border box')
      assert.match(rowBox.className, /py-3/, '12px vertical padding')

      // One status idiom: the dot. No tinted pill anywhere on the row.
      assert.doesNotMatch(host.innerHTML, /rounded-full bg-\[color:var\(--tone/, 'no tinted status pill')
      assert.doesNotMatch(host.innerHTML, /--tone-good-soft|--tone-warn-soft|--tone-error-soft/)
      unmount(root, host)
    }

    {
      const { host, root } = mount(<ProviderRow {...BASE} health="warn" stateLine="Not installed" />)
      assert.match(host.textContent ?? '', /Not installed/)
      assert.doesNotMatch(
        host.textContent ?? '',
        /unknown version|—\s*$|n\/a/i,
        'an absent version renders nothing at all, not a placeholder',
      )
      assert.equal(
        host.querySelectorAll('.font-mono').length,
        0,
        'the mono version slot is not rendered when there is no version',
      )
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // Selection: the face drives a pane beside the row, and it is a real tab stop
    // ---------------------------------------------------------------------------
    {
      let selected = 0
      let acted = 0
      const { host, root, render } = mount(
        <ProviderRow
          {...BASE}
          health="neutral"
          onSelect={() => {
            selected += 1
          }}
          actions={
            <button
              type="button"
              onClick={() => {
                acted += 1
              }}
            >
              Get
            </button>
          }
        />,
      )
      const face = host.querySelector('button[aria-label="Show details for Claude"]') as HTMLButtonElement
      assert.ok(face, 'the mark and text become one button, so the pane opens by keyboard as well as by mouse')
      assert.equal(
        face.getAttribute('aria-pressed'),
        'false',
        'the face states whether it is the selected row — pressed, not "expanded", which belongs to the chevron',
      )

      act(() => face.click())
      assert.equal(selected, 1, 'clicking the face selects the row')
      assert.equal(acted, 0, 'and does not fire the row action')

      const action = [...host.querySelectorAll('button')].find(
        (node) => node.textContent === 'Get',
      ) as HTMLButtonElement
      assert.notEqual(action, face, 'the action keeps its own tab stop rather than nesting inside the face')
      act(() => action.click())
      assert.equal(acted, 1, 'the action fires on its own')
      assert.equal(selected, 1, 'and does not also re-select the row')

      // A selectable face is actionable, so it earns the hover fill and its dot
      // tracks that fill instead of haloing on it.
      const rowBox = host.firstElementChild?.firstElementChild as HTMLElement
      assert.match(rowBox.className, /hover:bg-\[color:var\(--bg-hover\)\]/)
      const dot = host.querySelector('span[aria-hidden="true"][style*="background-color"]') as HTMLElement
      assert.match(dot.className, /group-hover:shadow-\[0_0_0_2px_var\(--bg-hover\)\]/)

      render(<ProviderRow {...BASE} health="good" selected onSelect={() => {}} stateLine="Added — Daily at 02:00" />)
      const selectedFace = host.querySelector('button[aria-label="Show details for Claude"]') as HTMLButtonElement
      assert.equal(selectedFace.getAttribute('aria-pressed'), 'true', 'selection is announced, not only painted')
      assert.match(
        (host.firstElementChild?.firstElementChild as HTMLElement).className,
        /bg-\[color:var\(--bg-selected\)\]/,
        'tier 1 selection is a neutral fill — no accent, no border',
      )
      unmount(root, host)
    }

    // A disclosable row keeps its single chevron tab stop: it cannot also be a
    // selection face, because a row cannot both expand in place and drive a pane.
    {
      const { host, root } = mount(
        <ProviderRow {...BASE} health="neutral" expanded={false} onExpandedChange={() => {}} onSelect={() => {}}>
          <div>detail</div>
        </ProviderRow>,
      )
      assert.equal(
        host.querySelector('button[aria-label="Show details for Claude"]'),
        null,
        'disclosure wins: no second face button appears',
      )
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // Disclosure: expands in place, flips the chevron, collapse restores
    // ---------------------------------------------------------------------------
    {
      let expanded = false
      const render = (next: boolean): React.ReactElement => (
        <ProviderRow
          {...BASE}
          health="good"
          expanded={next}
          onExpandedChange={(value) => {
            expanded = value
          }}
        >
          <p data-testid="detail">Binary path</p>
        </ProviderRow>
      )
      const { host, root, render: rerender } = mount(render(false))

      const chevron = host.querySelector('button[aria-expanded]') as HTMLButtonElement
      assert.ok(chevron, 'a disclosable row renders a chevron button')
      assert.equal(chevron.getAttribute('aria-expanded'), 'false')
      assert.equal(chevron.getAttribute('aria-label'), 'Claude details')
      assert.equal(
        chevron.getAttribute('aria-controls'),
        null,
        'a closed row points at no panel — the panel is unmounted, and aria-controls must not dangle',
      )
      assert.equal(host.querySelector('[data-testid="detail"]'), null, 'the detail is closed')
      assert.doesNotMatch(
        chevron.querySelector('svg')?.getAttribute('class') ?? '',
        /rotate-180/,
        'the chevron rests unrotated',
      )

      act(() => {
        chevron.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(expanded, true, 'the chevron opens the row')
      rerender(render(true))

      const open = host.querySelector('button[aria-expanded]') as HTMLButtonElement
      assert.equal(open.getAttribute('aria-expanded'), 'true')
      assert.match(open.querySelector('svg')?.getAttribute('class') ?? '', /rotate-180/, 'the chevron flips when open')
      const detail = host.querySelector('[data-testid="detail"]')
      assert.ok(detail, 'the detail opens in place')
      assert.equal(
        open.getAttribute('aria-controls'),
        detail?.parentElement?.getAttribute('id'),
        'aria-controls points at the panel the chevron opened',
      )
      // In place, not navigation: the row itself is still rendered above the detail.
      assert.match(host.textContent ?? '', /Claude/)
      assert.ok(
        host.firstElementChild?.firstElementChild?.contains(open),
        'the row keeps its position above the expansion',
      )

      act(() => {
        open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(expanded, false, 'clicking again collapses')
      rerender(render(false))
      assert.equal(host.querySelector('[data-testid="detail"]'), null, 'collapse restores the prior state')
      unmount(root, host)
    }

    // A row with no disclosure handler renders no chevron and no dead panel.
    {
      const { host, root } = mount(<ProviderRow {...BASE} health="neutral" />)
      assert.equal(host.querySelector('button[aria-expanded]'), null)
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // The hover fill is a promise the face has to be able to keep
    // ---------------------------------------------------------------------------
    // A fill on hover is this system's signal that the thing under the cursor is
    // actionable. The marketplace canvas and onboarding both render rows whose only
    // live control is a trailing button — those must not light up, or the whole row
    // reads as a click target that does nothing. The dot's keyline tracks the same
    // condition: ringing it in the hover colour on a face that never takes the
    // hover fill would halo it.
    {
      const disclosable = mount(
        <ProviderRow {...BASE} health="good" expanded={false} onExpandedChange={() => {}}>
          <p>Detail</p>
        </ProviderRow>,
      )
      const liveFace = disclosable.host.firstElementChild?.firstElementChild as HTMLElement
      assert.match(liveFace.className, /hover:bg-\[color:var\(--bg-hover\)\]/, 'an actionable face lights up')
      assert.match(liveFace.className, /cursor-pointer/)
      assert.match(
        disclosable.host.querySelector('span[aria-hidden="true"][style*="background-color"]')?.className ?? '',
        /group-hover:shadow-\[0_0_0_2px_var\(--bg-hover\)\]/,
        'the keyline follows the fill the face will take',
      )
      unmount(disclosable.root, disclosable.host)

      const inert = mount(<ProviderRow {...BASE} health="good" actions={<button type="button">Get</button>} />)
      const inertFace = inert.host.firstElementChild?.firstElementChild as HTMLElement
      assert.doesNotMatch(inertFace.className, /hover:bg-/, 'an inert face makes no hover promise')
      assert.doesNotMatch(inertFace.className, /cursor-pointer/)
      assert.doesNotMatch(
        inert.host.querySelector('span[aria-hidden="true"][style*="background-color"]')?.className ?? '',
        /group-hover:shadow-/,
        'and its keyline stays on the resting fill',
      )
      unmount(inert.root, inert.host)
    }

    // ---------------------------------------------------------------------------
    // Drawn size and target size are different numbers
    // ---------------------------------------------------------------------------
    // foundations/principles.md: nothing interactive is drawn below
    // sem.size.hit-target-min — a small glyph pads out to it with a transparent hit
    // area rather than shrinking its target. The chevron glyph stays icon.size.xs.
    {
      const { host, root } = mount(
        <ProviderRow {...BASE} health="good" expanded={false} onExpandedChange={() => {}}>
          <p>Detail</p>
        </ProviderRow>,
      )
      const chevron = host.querySelector('button[aria-expanded]') as HTMLButtonElement
      assert.match(
        chevron.className,
        /size-\[var\(--hit-target-min\)\]/,
        'the chevron button fills the hit-target floor',
      )
      assert.doesNotMatch(chevron.className, /\bp-0\.5\b/, 'it is not a 13px glyph in a 17px box')
      assert.match(chevron.querySelector('svg')?.getAttribute('class') ?? '', /size-icon-xs/)
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // Reduced motion reaches the row's own crossfade
    // ---------------------------------------------------------------------------
    // The face cannot use `.interactive` (that utility also carries the 0.97 press
    // scale, which belongs to a button, not a full-width row), so the shared guard
    // in assets/index.css does not cover it and the row must name its own.
    {
      const { host, root } = mount(
        <ProviderRow {...BASE} health="good" expanded={false} onExpandedChange={() => {}}>
          <p>Detail</p>
        </ProviderRow>,
      )
      const face = host.firstElementChild?.firstElementChild as HTMLElement
      assert.match(face.className, /transition-colors/)
      assert.match(face.className, /motion-reduce:transition-none/, 'reduce kills the crossfade')
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // Health and enablement are independent axes
    // ---------------------------------------------------------------------------
    {
      let enabled = true
      const { host, root } = mount(
        <ProviderRow
          {...BASE}
          health="error"
          stateLine="Unavailable — startup timed out after 15s"
          enabled={enabled}
          onEnabledChange={(next) => {
            enabled = next
          }}
        />,
      )
      const control = host.querySelector('button[role="switch"]') as HTMLButtonElement
      assert.ok(control, 'the switch renders when both enablement props are supplied')
      assert.equal(control.getAttribute('aria-checked'), 'true', 'enabled and unhealthy render together')
      assert.equal(control.getAttribute('aria-label'), 'Claude enabled')

      const dot = host.querySelector('span[aria-hidden="true"][style*="background-color"]') as HTMLElement
      assert.match(
        dot.getAttribute('style') ?? '',
        /var\(--tone-error\)/,
        'the dot still reports the health tone while the switch reports on',
      )

      act(() => {
        control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(enabled, false, 'the switch writes enablement')
      unmount(root, host)
    }

    // A host with no real enablement state renders no switch — never a dead one.
    {
      const { host, root } = mount(<ProviderRow {...BASE} health="good" />)
      assert.equal(host.querySelector('button[role="switch"]'), null)
      unmount(root, host)
    }

    // A switch flip must not also toggle the row's disclosure.
    {
      let expanded = false
      let enabled = false
      const { host, root } = mount(
        <ProviderRow
          {...BASE}
          health="good"
          enabled={enabled}
          onEnabledChange={(next) => {
            enabled = next
          }}
          expanded={false}
          onExpandedChange={(next) => {
            expanded = next
          }}
        >
          <p>Detail</p>
        </ProviderRow>,
      )
      const control = host.querySelector('button[role="switch"]') as HTMLButtonElement
      act(() => {
        control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(enabled, true)
      assert.equal(expanded, false, 'the trailing cluster stops propagation to the row')
      unmount(root, host)
    }

    // Clicking the row body is a second mouse affordance for the same disclosure.
    {
      let expanded = false
      const { host, root } = mount(
        <ProviderRow
          {...BASE}
          health="good"
          expanded={false}
          onExpandedChange={(next) => {
            expanded = next
          }}
        >
          <p>Detail</p>
        </ProviderRow>,
      )
      const rowBox = host.firstElementChild?.firstElementChild as HTMLElement
      act(() => {
        rowBox.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(expanded, true, 'the row body toggles the disclosure')
      // Exactly one focusable control for the disclosure, so there is one tab stop.
      assert.equal(host.querySelectorAll('button[aria-expanded]').length, 1)
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // Selection is a neutral fill, per the selection tiers
    // ---------------------------------------------------------------------------
    {
      const { host, root } = mount(<ProviderRow {...BASE} health="neutral" selected />)
      const rowBox = host.firstElementChild?.firstElementChild as HTMLElement
      assert.match(rowBox.className, /bg-\[color:var\(--bg-selected\)\]/)
      assert.doesNotMatch(rowBox.className, /accent/, 'selection never spends the accent')
      assert.doesNotMatch(rowBox.className, /border-l|border-\[color/, 'selection carries no left bar or box')
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // The CLI probe → state mapping. A missing map entry is UNKNOWN, not missing.
    // ---------------------------------------------------------------------------
    {
      const installed = resolveCliProviderState(
        { cli: 'claude-code', installed: true, resolvedPath: '/usr/local/bin/claude', version: '2.1.220' },
        'ready',
      )
      assert.equal(installed.health, 'ready')
      assert.equal(installed.tone, 'good')
      assert.equal(installed.version, '2.1.220')
      assert.equal(installed.installed, true)

      const absent = resolveCliProviderState(
        { cli: 'grok', installed: false, resolvedPath: null, version: null },
        'ready',
      )
      assert.equal(absent.health, 'missing')
      assert.equal(absent.tone, 'warn')
      assert.equal(absent.version, null, 'no version is invented for an absent binary')

      // The main-process probe OMITS a CLI whose probe errored, precisely so this
      // cannot be read as "not installed" (src/main/cli-availability.ts).
      const unknown = resolveCliProviderState(undefined, 'ready')
      assert.equal(unknown.health, 'unknown')
      assert.notEqual(unknown.health, 'missing', 'a failed probe is never reported as an absent binary')
      assert.equal(unknown.installed, false)

      assert.equal(resolveCliProviderState(undefined, 'loading').health, 'checking')
      assert.equal(resolveCliProviderState(undefined, 'loading').tone, 'neutral')
      assert.equal(resolveCliProviderState(undefined, 'error').health, 'probe-failed')
      assert.equal(resolveCliProviderState(undefined, 'error').tone, 'error')

      // A decided row stays decided while a background re-probe runs.
      const decidedDuringRefresh = resolveCliProviderState(
        { cli: 'codex', installed: true, resolvedPath: '/opt/codex', version: '0.146.0' },
        'loading',
      )
      assert.equal(decidedDuringRefresh.health, 'ready')

      // Every state has words. The dot is aria-hidden, so this text IS the state.
      for (const state of [
        installed,
        absent,
        unknown,
        resolveCliProviderState(undefined, 'loading'),
        resolveCliProviderState(undefined, 'error'),
      ]) {
        const words = cliProviderStateWords(state, { binary: 'claude', probeError: null })
        assert.ok(words && words.trim().length > 0, `state ${state.health} has words`)
      }
      assert.match(cliProviderStateWords(absent, { binary: 'grok' }), /grok/, 'the missing binary is named')
      assert.match(
        cliProviderStateWords(resolveCliProviderState(undefined, 'error'), {
          binary: 'claude',
          probeError: 'spawn ENOENT',
        }),
        /spawn ENOENT/,
        'a probe failure surfaces its reason rather than a generic line',
      )
    }

    // The rendered state line puts the resolved path in mono and names a WSL launch.
    {
      const state = resolveCliProviderState(
        { cli: 'claude-code', installed: true, resolvedPath: '/usr/local/bin/claude', version: '2.1.220' },
        'ready',
      )
      const { host, root } = mount(
        <ProviderRow
          icon={<span />}
          health={state.tone}
          name="Claude"
          version={state.version}
          stateLine={<CliProviderStateLine state={state} binary="claude" machineLabel="WSL: Ubuntu" />}
        />,
      )
      assert.match(host.textContent ?? '', /Ready — \/usr\/local\/bin\/claude · WSL: Ubuntu/)
      const monos = [...host.querySelectorAll('.font-mono')].map((node) => node.textContent)
      assert.ok(monos.includes('/usr/local/bin/claude'), 'the path renders mono — identifiers are mono, prose is not')
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // One status idiom: a list picks the dot OR the count, and may pick neither
    // ---------------------------------------------------------------------------
    {
      // Health omitted: no dot at all. The owner's Agent CLIs list is nine green
      // dots and one that is not, and the fact they came for is not either of them.
      const { host, root } = mount(<ProviderRow {...BASE} stateLine="Ready — /usr/local/bin/claude" />)
      assert.equal(
        host.querySelector('span[aria-hidden="true"][style*="background-color"]'),
        null,
        'a row with no health draws no dot',
      )
      assert.match(host.textContent ?? '', /Ready/, 'and the state line still carries the state in words')
      unmount(root, host)
    }

    {
      const { host, root, render } = mount(
        <ProviderRow
          {...BASE}
          name="Codex"
          badge={{ count: 1, label: 'Codex — update available: 0.153.4' }}
          stateLine="Ready"
        />,
      )
      const badge = host.querySelector('[role="status"]')
      assert.ok(badge, 'the corner count renders')
      assert.equal(badge?.textContent, '1', 'one update reads as 1 — on a row the count says WHICH, not how many')
      assert.equal(
        badge?.getAttribute('aria-label'),
        'Codex — update available: 0.153.4',
        'and it is named with the row and the version — a bare "1" on a logo is not a sentence',
      )
      assert.match(
        badge?.className ?? '',
        /absolute -right-1 -top-1/,
        "docked on the mark's top-right — the opposite corner from the health dot",
      )
      assert.match(
        badge?.className ?? '',
        /border-\[color:var\(--bg-surface\)\]/,
        'ringed in the ground these lists sit on, not the app ground the primitive assumes',
      )

      // Zero is not news. A counter reading 0 is a counter spent saying nothing.
      render(<ProviderRow {...BASE} name="Codex" badge={{ count: 0, label: 'Codex' }} stateLine="Ready" />)
      assert.equal(host.querySelector('[role="status"]'), null, 'a count of 0 draws nothing')
      render(<ProviderRow {...BASE} name="Codex" badge={null} stateLine="Ready" />)
      assert.equal(host.querySelector('[role="status"]'), null, 'and neither does a null badge')
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // Recessed: absence reads as background, and its controls keep working
    // ---------------------------------------------------------------------------
    {
      const install = <button type="button">Install</button>
      const { host, root, render } = mount(
        <ProviderRow
          {...BASE}
          name="Muse Code"
          recessed
          actions={install}
          stateLine="Not installed — no muse on PATH"
        />,
      )
      // The innermost span, not the baseline pair that wraps it.
      const nameOf = (root: HTMLElement): HTMLElement | undefined =>
        Array.from(root.querySelectorAll<HTMLElement>('span.truncate')).find((span) => span.textContent === 'Muse Code')
      const name = nameOf(host)
      assert.ok(name, 'the name renders')
      assert.match(
        name?.className ?? '',
        /text-\[color:var\(--text-default\)\]/,
        'a recessed name drops one ink step, the way the sidebar recedes an inactive conversation',
      )
      const mark = host.querySelector('span.relative.mt-px') as HTMLElement | null
      assert.match(mark?.className ?? '', /opacity-60/, 'and the mark, being an image, recedes by opacity')

      // Not a disabled state: the row is listed so it can be installed.
      const button = host.querySelector('button')
      assert.ok(button && !button.disabled, 'the Install button on a recessed row still works')
      assert.doesNotMatch(host.innerHTML, /aria-disabled/, 'recessed sets no aria-disabled — it is contrast, not state')

      render(<ProviderRow {...BASE} name="Muse Code" stateLine="Ready" />)
      const present = nameOf(host)
      assert.match(
        present?.className ?? '',
        /text-\[color:var\(--text-strong\)\]/,
        'a present provider keeps the full-contrast name',
      )
      unmount(root, host)
    }

    // ---------------------------------------------------------------------------
    // In a list card the row is full-bleed and a real list item
    // ---------------------------------------------------------------------------
    {
      const { host, root } = mount(
        <ul>
          <ProviderRow
            {...BASE}
            as="li"
            surface="card"
            health="good"
            badge={{ count: 1, label: 'Claude — update available' }}
          />
        </ul>,
      )
      const item = host.querySelector('ul > li')
      assert.ok(item, 'as="li" renders a list item, so a card <ul> holds valid children')
      const face = item?.querySelector('div.group') as HTMLElement | null
      assert.match(face?.className ?? '', /\bpx-4\b/, 'the card inset is the machine row’s 16px')
      assert.doesNotMatch(
        face?.className ?? '',
        /rounded-/,
        'no radius — the card clips, and a rounded fill inside it is a card in a card',
      )
      const dot = host.querySelector('span[aria-hidden="true"][style*="background-color"]') as HTMLElement | null
      assert.match(
        dot?.className ?? '',
        /--bg-surface-raised/,
        'the dot’s keyline tracks the card’s raised ground, or it halos',
      )
      const badge = host.querySelector('[aria-label="Claude — update available"]') as HTMLElement | null
      assert.match(badge?.className ?? '', /--bg-surface-raised/, 'and so does the corner count’s ring')
      unmount(root, host)

      // The default is untouched: a row loose on a page keeps its radius and inset.
      const loose = mount(<ProviderRow {...BASE} />)
      assert.equal(loose.host.firstElementChild?.tagName, 'DIV', 'a loose row is a <div>')
      const looseFace = loose.host.querySelector('div.group') as HTMLElement | null
      assert.match(looseFace?.className ?? '', /rounded-\[var\(--radius-sm\)\] px-2\.5/, 'and draws the page inset')
      unmount(loose.root, loose.host)
    }

    // ---------------------------------------------------------------------------
    // Host wiring a mounted row cannot observe
    // ---------------------------------------------------------------------------
    const repoRoot = process.cwd()
    const settings = readFileSync(join(repoRoot, 'src/renderer/src/components/settings/SettingsPanel.tsx'), 'utf8')
    const onboarding = readFileSync(
      join(repoRoot, 'src/renderer/src/components/onboarding/FirstRunCliCard.tsx'),
      'utf8',
    )
    const canvas = readFileSync(
      join(repoRoot, 'src/renderer/src/components/panels/ConnectorsPanel/AgentCliShelfRows.tsx'),
      'utf8',
    )

    for (const [label, source] of [
      ['Settings → Agents', settings],
      ['first-run CLI card', onboarding],
      ['Agent CLIs canvas', canvas],
    ] as const) {
      assert.match(source, /<ProviderRow/, `${label} renders the shared row`)
    }

    // The two CLI hosts read one mapping, so a CLI cannot read "Ready" on one
    // surface and "Not installed" on the other.
    for (const [label, source] of [
      ['Settings → Agents', settings],
      ['first-run CLI card', onboarding],
    ] as const) {
      assert.match(source, /resolveCliProviderState\(/, `${label} derives state from the shared mapping`)
      assert.match(source, /<CliProviderStateLine/, `${label} renders the shared state line`)
      assert.match(
        source,
        /state\.health === 'missing' \? \(/,
        `${label} offers Install only on a definitive negative probe`,
      )
      assert.match(source, /showStatus=\{false\}/, `${label} does not repeat the row's state inside it`)
    }

    // The old boxed card grid is gone from the settings list.
    assert.doesNotMatch(settings, /function CliCard\(/, 'the boxed CLI card is retired')
    assert.doesNotMatch(
      settings,
      /The agent CLIs that can be launched\./,
      'the explanatory lede is gone — the list explains itself',
    )
    assert.match(settings, /Agent CLIs/, 'the section band is titled Agent CLIs')
    // The freshness fact now composes into the header's meta line alongside the
    // installed count ("3 installed · checked 2m ago"), so match the fact rather
    // than the sentence it used to be.
    assert.match(settings, /checked \$\{freshness\}/i, 'the band carries the freshness meta')
    assert.match(settings, /refreshCliAvailability\(\{ force: true, cliRuntimes \}\)/, 'the band re-checks for real')

    // The registry canvas states registry availability, not a local health probe.
    assert.match(canvas, /pluginTrust/, 'the canvas row reads the registry signing tier')
    assert.doesNotMatch(canvas, /resolveCliProviderState/, 'the canvas runs no local install probe')
    // Matched on the prop, not on any mention: the code comment beside it explains
    // why `plugin.latest` is NOT rendered, so a bare /plugin\.latest/ would trip on
    // its own rationale.
    assert.match(
      canvas,
      /version=\{null\}/,
      "the marketplace row renders no version — `latest` is the registry's bundle revision, not the CLI's own version",
    )
    assert.doesNotMatch(
      canvas,
      /version=\{[^}]*plugin\.latest/,
      'and the bundle revision never reaches the version slot',
    )

    // A failed batch probe is one global fact, stated once, not once per row.
    assert.match(
      settings,
      /cliAvailabilityStatus === 'error' && cliAvailabilityError/,
      'the settings section surfaces a failed availability probe (it was surfaced nowhere before)',
    )
    assert.match(settings, /probeError=\{null\}/, 'and the rows do not repeat it nine times')
    assert.match(
      onboarding,
      /probeError=\{cliAvailabilityError\}/,
      'onboarding has no section band, so its rows keep the reason',
    )
    // The agent-CLI rows are a file of their own since the source-tabs ruling
    // (2026-09-05) made Agent CLIs a catalogue rather than one kind of a shared
    // canvas — and they are still the ONLY marketplace list on this anatomy.
    assert.match(
      canvas,
      /export function AgentCliRuntimeRows\(/,
      'the runtime rows live where the catalogue reads them',
    )
    assert.equal(
      /ConnectorEntryRow/.test(canvas),
      false,
      'and they never fall back to the connector row this anatomy replaced',
    )
    process.stdout.write('ProviderRow tests passed\n')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
