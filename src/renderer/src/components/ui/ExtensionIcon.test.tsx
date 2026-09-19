import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('ExtensionIcon', async () => {
  // ExtensionIcon — the mark every extension wears.
  //
  // The rungs are what this covers, because the slot is one component precisely
  // so that they cannot drift apart per surface:
  //
  //   1. a shipped `mark` outranks everything — it needs no network;
  //   2. the publisher's own `glyph` outranks every picture, and is drawn INSIDE
  //      the neutral chip, larger than the monogram it replaces;
  //   3. a picture the caller says is plated fills the slot bare, because a white
  //      plate behind a framed thing is a second frame;
  //   4. a picture that fails to load falls to the monogram — the one thing the
  //      slot must never do is show an empty square.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLImageElement = dom.window.HTMLImageElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.Event = dom.window.Event
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { ExtensionIcon } = await import('./ExtensionIcon')

    const document = dom.window.document

    function mount(node: React.ReactNode): {
      root: HTMLElement
      container: HTMLElement
      rerender: (next: React.ReactNode) => void
      unmount: () => void
    } {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const reactRoot = createRoot(container)
      act(() => {
        reactRoot.render(node)
      })
      return {
        root: container.firstElementChild as HTMLElement,
        container: container as unknown as HTMLElement,
        // The same instance with new props — not a fresh mount — which is what a
        // row whose plugin changed under it does.
        rerender: (next) => {
          act(() => {
            reactRoot.render(next)
          })
        },
        unmount: () => {
          act(() => reactRoot.unmount())
          container.remove()
        },
      }
    }

    run('a glyph is drawn in the chip, and replaces the monogram rather than joining it', () => {
      const view = mount(<ExtensionIcon name="access" glyph="🦀" size={36} />)
      assert.equal(view.container.querySelectorAll('img').length, 0, 'a glyph is drawn, not fetched')
      assert.equal(view.root.textContent, '🦀')
      assert.equal(view.root.textContent?.includes('AC'), false, 'the monogram is the rung below, not a companion')
      view.unmount()
    })

    run('the glyph is larger than the monogram it stands in for', () => {
      const glyph = mount(<ExtensionIcon name="access" glyph="🦀" size={36} />)
      const monogram = mount(<ExtensionIcon name="access" size={36} />)
      const sizeOf = (view: { root: HTMLElement }): number =>
        parseFloat((view.root.querySelector('span') as HTMLElement).style.fontSize)
      assert.ok(
        sizeOf(glyph) > sizeOf(monogram),
        'an emoji at the monogram’s size reads as a stain in a large chip rather than as the plugin’s mark',
      )
      assert.ok(sizeOf(glyph) < 36, 'and it still sits inside its chip')
      glyph.unmount()
      monogram.unmount()
    })

    run('the glyph outranks a picture, and a shipped mark outranks the glyph', () => {
      const overPicture = mount(
        <ExtensionIcon name="access" glyph="🦀" icon="https://cdn.example.com/a.png" iconPlated size={36} />,
      )
      assert.equal(overPicture.container.querySelectorAll('img').length, 0)
      assert.equal(overPicture.root.textContent, '🦀')
      overPicture.unmount()

      const underMark = mount(<ExtensionIcon name="access" glyph="🦀" mark={<svg data-testid="frond" />} size={36} />)
      assert.equal(underMark.container.querySelectorAll('svg').length, 1)
      assert.equal(underMark.root.textContent, '', 'an id we recognise is a stronger answer than a publisher’s string')
      underMark.unmount()
    })

    run('a plated picture fills the slot; an unplated one sits inset in the chip', () => {
      const plated = mount(
        <ExtensionIcon name="anthropics" icon="https://github.com/anthropics.png?size=72" iconPlated size={36} />,
      )
      const platedImg = plated.container.querySelector('img') as HTMLImageElement
      assert.equal(platedImg.getAttribute('width'), '36', 'an avatar brings its own ground: no chip, no inset')
      assert.equal(plated.root.tagName, 'IMG')
      plated.unmount()

      const inset = mount(<ExtensionIcon name="anthropics" icon="https://cdn.example.com/flat.svg" size={36} />)
      const insetImg = inset.container.querySelector('img') as HTMLImageElement
      assert.equal(inset.root.tagName, 'SPAN', 'artwork we cannot inspect keeps the chip — the safe wrong answer')
      assert.ok(Number(insetImg.getAttribute('width')) < 36)
      inset.unmount()
    })

    run('a picture that fails to load falls to the monogram, plated or not', () => {
      for (const plated of [true, false]) {
        const view = mount(
          <ExtensionIcon name="access" icon="https://cdn.example.com/gone.png" iconPlated={plated} size={36} />,
        )
        const img = view.container.querySelector('img') as HTMLImageElement
        act(() => {
          img.dispatchEvent(new dom.window.Event('error'))
        })
        assert.equal(view.container.querySelectorAll('img').length, 0)
        assert.equal(
          (view.container.firstElementChild as HTMLElement).textContent,
          'AC',
          'the one thing the slot must never do is show an empty square',
        )
        view.unmount()
      }
    })

    run('a failure is forgotten when the picture changes, so the monogram does not stick to the next plugin', () => {
      const gone = 'https://cdn.example.com/gone.png'
      const here = 'https://cdn.example.com/here.png'
      const view = mount(<ExtensionIcon name="access" icon={gone} iconPlated size={36} />)
      act(() => {
        ;(view.container.querySelector('img') as HTMLImageElement).dispatchEvent(new dom.window.Event('error'))
      })
      assert.equal(view.container.querySelectorAll('img').length, 0, 'the failed picture gave way to the monogram')

      view.rerender(<ExtensionIcon name="access" icon={here} iconPlated size={36} />)
      const retried = view.container.querySelector('img')
      assert.ok(retried, 'the same instance, handed a different picture, tries it')
      assert.equal(retried?.getAttribute('src'), here)

      view.rerender(<ExtensionIcon name="access" icon={gone} iconPlated size={36} />)
      assert.equal(
        view.container.querySelectorAll('img').length,
        0,
        'the one that failed is still remembered, not fetched again',
      )
      view.unmount()
    })

    run('two glyphs take the monogram’s size, one takes more, and a family is one', () => {
      const one = mount(<ExtensionIcon name="access" glyph="🦀" size={36} />)
      const two = mount(<ExtensionIcon name="access" glyph="🚀✨" size={36} />)
      const letters = mount(<ExtensionIcon name="access" glyph="AI" size={36} />)
      const family = mount(<ExtensionIcon name="access" glyph="👨‍👩‍👧‍👦" size={36} />)
      const monogram = mount(<ExtensionIcon name="access" size={36} />)
      const sizeOf = (view: { root: HTMLElement }): number =>
        parseFloat((view.root.querySelector('span') as HTMLElement).style.fontSize)
      assert.equal(
        sizeOf(two),
        sizeOf(monogram),
        'two emoji are as wide as two letters, and take their size or spill the chip',
      )
      assert.equal(sizeOf(letters), sizeOf(monogram))
      assert.ok(sizeOf(one) > sizeOf(two))
      assert.equal(sizeOf(family), sizeOf(one), 'a family is seven code points and one thing to see')
      for (const view of [one, two, letters, family, monogram]) view.unmount()
    })

    if (failures > 0) {
      console.error(`\nExtensionIcon.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('ExtensionIcon: all checks passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
