import { JSDOM } from 'jsdom'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

import { QUESTION_TAKEOVER_IDLE_MS, questionShouldWait, useQuestionTakeover } from './questionTakeover'

// A question from the agent waits for the typing in the composer to stop
// before it takes the box, and takes it at once when nobody is typing.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
const previous = Object.getOwnPropertyDescriptors(globalThis)
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
})

afterAll(() => {
  dom.window.close()
  for (const key of GLOBALS) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
    else Reflect.deleteProperty(globalThis, key)
  }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

type Takeover = ReturnType<typeof useQuestionTakeover>
type Props = { questionKey: string | null; draftEmpty: boolean; focused: boolean }

async function harness(initial: Props) {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  let latest: Takeover | null = null
  let renders = 0
  function Probe(props: Props) {
    renders += 1
    latest = useQuestionTakeover({
      questionKey: props.questionKey,
      draftEmpty: props.draftEmpty,
      composerFocused: () => props.focused,
      now: () => Date.now(),
    })
    return null
  }
  const host = dom.window.document.createElement('div')
  const root = createRoot(host)
  let props = initial
  await act(async () => root.render(<Probe {...props} />))
  return {
    get state(): Takeover {
      return latest!
    },
    get renders() {
      return renders
    },
    async set(next: Partial<Props>) {
      props = { ...props, ...next }
      await act(async () => root.render(<Probe {...props} />))
    },
    async type() {
      latest!.noteDraftEdit()
    },
    async advance(ms: number) {
      await act(async () => {
        vi.advanceTimersByTime(ms)
      })
    },
    act,
    async unmount() {
      await act(async () => root.unmount())
    },
  }
}

test('typing means focus in the box, words in it and an edit inside the idle window', () => {
  expect(questionShouldWait({ focused: true, draftEmpty: false, sinceLastEdit: 200 })).toBe(true)
  expect(questionShouldWait({ focused: true, draftEmpty: false, sinceLastEdit: QUESTION_TAKEOVER_IDLE_MS })).toBe(false)
  expect(questionShouldWait({ focused: false, draftEmpty: false, sinceLastEdit: 200 })).toBe(false)
  expect(questionShouldWait({ focused: true, draftEmpty: true, sinceLastEdit: 200 })).toBe(false)
})

test('a question arriving while nobody types takes the box at once', async () => {
  const view = await harness({ questionKey: null, draftEmpty: false, focused: true })
  await view.type()
  await view.advance(QUESTION_TAKEOVER_IDLE_MS)
  await view.set({ questionKey: 'q-1' })
  expect(view.state.covers).toBe(true)
  expect(view.state.waiting).toBe(false)
  await view.unmount()
})

test('a question arriving mid-sentence waits until the draft has been still for the idle window', async () => {
  const view = await harness({ questionKey: null, draftEmpty: false, focused: true })
  await view.type()
  await view.advance(300)
  await view.set({ questionKey: 'q-1' })
  expect(view.state.waiting).toBe(true)
  expect(view.state.covers).toBe(false)
  // Typing on moves the deadline without re-rendering.
  const renders = view.renders
  await view.advance(1000)
  await view.type()
  expect(view.renders).toBe(renders)
  await view.advance(QUESTION_TAKEOVER_IDLE_MS - 1)
  expect(view.state.covers).toBe(false)
  await view.advance(1)
  expect(view.state.covers).toBe(true)
  expect(view.state.waiting).toBe(false)
  await view.unmount()
})

test('a waiting question takes the box when the draft empties, as a send leaves it', async () => {
  const view = await harness({ questionKey: null, draftEmpty: false, focused: true })
  await view.type()
  await view.set({ questionKey: 'q-1' })
  expect(view.state.waiting).toBe(true)
  await view.set({ draftEmpty: true })
  expect(view.state.covers).toBe(true)
  await view.unmount()
})

test('taking it over (Answer now, or focus leaving the box) ends the wait at once', async () => {
  const view = await harness({ questionKey: null, draftEmpty: false, focused: true })
  await view.type()
  await view.set({ questionKey: 'q-1' })
  expect(view.state.waiting).toBe(true)
  await view.act(async () => view.state.takeOver())
  expect(view.state.covers).toBe(true)
  await view.unmount()
})

test('a question arriving while the composer is not focused or is empty takes the box at once', async () => {
  const unfocused = await harness({ questionKey: null, draftEmpty: false, focused: false })
  await unfocused.type()
  await unfocused.set({ questionKey: 'q-1' })
  expect(unfocused.state.covers).toBe(true)
  await unfocused.unmount()
  const empty = await harness({ questionKey: null, draftEmpty: true, focused: true })
  await empty.type()
  await empty.set({ questionKey: 'q-1' })
  expect(empty.state.covers).toBe(true)
  await empty.unmount()
})

test('a question that already covered the box is not held back when it comes again', async () => {
  const view = await harness({ questionKey: 'q-1', draftEmpty: false, focused: true })
  expect(view.state.covers).toBe(true)
  await view.set({ questionKey: null })
  await view.type()
  await view.set({ questionKey: 'q-1' })
  expect(view.state.covers).toBe(true)
  // A new question is a new arrival, and waits like any other.
  await view.set({ questionKey: 'q-2' })
  expect(view.state.waiting).toBe(true)
  await view.unmount()
})
