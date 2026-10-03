import { expect, test, vi } from 'vitest'

import type { OfferedToolset, ToolsetInput } from '../../../../../packages/agent-sdk/src/tools'
import { startWebCanvasToolset, type CanvasToolsetClient } from './webCanvasToolset'

// When a web tab offers `canvas` (phase 9 spec, 3.8; R79).

function fakeClient(capabilities: string[]) {
  const offers: ToolsetInput[] = []
  const withdrawn: string[] = []
  const focus: boolean[] = []
  let closed = false
  const client: CanvasToolsetClient = {
    supports: (capability) => capabilities.includes(capability),
    tools: {
      offer: async (toolset) => {
        offers.push(toolset)
        const offered: OfferedToolset = {
          name: toolset.name,
          wireNames: [],
          state: 'offered',
          withdraw: async () => void withdrawn.push(toolset.name),
        }
        return offered
      },
      focus: (hint) => void focus.push(hint.focused),
    },
    close: () => {
      closed = true
    },
  }
  return { client, offers, withdrawn, focus, closed: () => closed }
}

function page() {
  const listeners = new Map<string, (event: Event) => void>()
  let visibility: ((visible: boolean) => void) | null = null
  return {
    view: {
      addEventListener: (type: string, listener: (event: Event) => void) => void listeners.set(type, listener),
      removeEventListener: (type: string) => void listeners.delete(type),
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    fire: (type: string, persisted = false) => listeners.get(type)?.({ persisted } as unknown as Event),
    onVisibilityChange: (listener: (visible: boolean) => void) => {
      visibility = listener
      return () => {
        visibility = null
      }
    },
    setVisible: (visible: boolean) => visibility?.(visible),
  }
}

const tools = () => ({ definitions: [], dispose: vi.fn(async () => undefined) })

test('an owner tab offers canvas to a server with client tools and board files, focused when visible', async () => {
  const fake = fakeClient(['client-tools', 'files-write'])
  const view = page()
  const toolset = await startWebCanvasToolset({
    isOwnerSession: async () => true,
    connect: async () => fake.client,
    tools,
    visible: () => true,
    ...view,
  })
  expect(toolset.state()).toBe('offered')
  expect(fake.offers.map((offer) => offer.name)).toEqual(['canvas'])
  expect(fake.focus).toEqual([true])
  view.setVisible(false)
  expect(fake.focus).toEqual([true, false])
})

test('a session that is not the owner’s never connects, and a server without the capabilities is let go', async () => {
  const connect = vi.fn()
  const notOwner = await startWebCanvasToolset({
    isOwnerSession: async () => false,
    connect,
    tools,
    visible: () => true,
    ...page(),
  })
  expect(notOwner.state()).toBe('not-offered')
  expect(connect).not.toHaveBeenCalled()

  const fake = fakeClient(['client-tools'])
  const noFiles = await startWebCanvasToolset({
    isOwnerSession: async () => true,
    connect: async () => fake.client,
    tools,
    visible: () => true,
    ...page(),
  })
  expect(noFiles.state()).toBe('not-offered')
  expect(fake.offers).toHaveLength(0)
  expect(fake.closed()).toBe(true)
})

test('pagehide withdraws, and a page restored from the back/forward cache offers again', async () => {
  const fake = fakeClient(['client-tools', 'files-write'])
  const view = page()
  const toolset = await startWebCanvasToolset({
    isOwnerSession: async () => true,
    connect: async () => fake.client,
    tools,
    visible: () => true,
    ...view,
  })
  view.fire('pagehide')
  expect(toolset.state()).toBe('withdrawn')
  expect(fake.withdrawn).toEqual(['canvas'])
  view.fire('pageshow', false)
  expect(fake.offers).toHaveLength(1)
  view.fire('pageshow', true)
  await vi.waitFor(() => expect(toolset.state()).toBe('offered'))
  expect(fake.offers).toHaveLength(2)
  await toolset.stop()
  expect(fake.withdrawn).toEqual(['canvas', 'canvas'])
  expect(fake.closed()).toBe(true)
})
