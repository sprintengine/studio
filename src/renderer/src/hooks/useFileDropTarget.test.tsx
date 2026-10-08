// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import { useFileDropTarget } from './useFileDropTarget'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FILES = { types: ['Files'], dropEffect: 'none' } as unknown as DataTransfer
const TEXT = { types: ['text/plain'], dropEffect: 'none' } as unknown as DataTransfer

let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function mount(enabled = true) {
  const dropped: DataTransfer[] = []
  function Region({ on }: { on: boolean }) {
    const { active, handlers } = useFileDropTarget({
      enabled: on,
      accepts: (data) => data.types.includes('Files'),
      onDrop: (data) => dropped.push(data),
    })
    return (
      <div data-region="" data-active={active ? 'yes' : 'no'} {...handlers}>
        <span data-child="">a row</span>
      </div>
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<Region on={enabled} />))
  const region = host.querySelector<HTMLElement>('[data-region]')!
  const child = host.querySelector<HTMLElement>('[data-child]')!
  return { region, child, dropped, active: () => region.getAttribute('data-active') === 'yes' }
}

function drag(target: EventTarget, type: string, dataTransfer: DataTransfer, relatedTarget: EventTarget | null = null) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return act(async () => {
    target.dispatchEvent(event)
  })
}

test('a drag of files lights the region, and crossing its children does not put it out', async () => {
  const view = await mount()
  await drag(view.region, 'dragenter', FILES)
  expect(view.active()).toBe(true)
  await drag(view.child, 'dragenter', FILES)
  await drag(view.region, 'dragleave', FILES, view.child)
  expect(view.active()).toBe(true)
  await drag(view.child, 'dragleave', FILES, document.body)
  expect(view.active()).toBe(false)
})

test('a drag that ends anywhere else takes the light with it', async () => {
  const view = await mount()
  await drag(view.child, 'dragenter', FILES)
  // The row the pointer was over went away mid-drag and never said it left.
  view.child.remove()
  expect(view.active()).toBe(true)
  await act(async () => {
    window.dispatchEvent(new Event('dragend'))
  })
  expect(view.active()).toBe(false)
  await drag(view.region, 'dragenter', FILES)
  await act(async () => {
    window.dispatchEvent(new Event('drop'))
  })
  expect(view.active()).toBe(false)
})

test('a drop is claimed and handed over; one carrying no files, or onto a region taking none, is not', async () => {
  const view = await mount()
  await drag(view.region, 'dragenter', TEXT)
  expect(view.active()).toBe(false)
  await drag(view.region, 'dragenter', FILES)
  await drag(view.region, 'drop', FILES)
  expect(view.dropped).toEqual([FILES])
  expect(view.active()).toBe(false)
  await act(async () => root?.unmount())

  const off = await mount(false)
  await drag(off.region, 'dragenter', FILES)
  await drag(off.region, 'drop', FILES)
  expect(off.active()).toBe(false)
  expect(off.dropped).toEqual([])
})
