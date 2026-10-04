import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BranchPullRequest } from '../../../../../shared/git/pull-request'

// The open chat's "Open PR" button on the composer's strip (owner ruling
// 2026-10-04): what it says for each state, that it is drawn only for a
// conversation that opened a pull request, and that it opens the pull request
// in the browser.

const NOW = Date.parse('2026-10-04T12:00:00.000Z')

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const previous = Object.getOwnPropertyDescriptors(globalThis)
const opened: string[] = []
const GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
]

beforeAll(() => {
  ;(dom.window as unknown as { api: unknown }).api = {
    openExternal: async (url: string) => {
      opened.push(url)
    },
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
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

function pr(overrides: Partial<BranchPullRequest> & { number: number }): BranchPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${overrides.number}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    title: `Change ${overrides.number}`,
    state: 'open',
    isDraft: false,
    openedAt: NOW - 3_600_000 + overrides.number,
    stateAt: NOW,
    ...overrides,
  }
}

async function mount(node: React.ReactNode) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(node))
  return {
    container,
    act,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

test('the words carry the state, and a pull request closed unmerged is left off as the sidebar leaves it off', async () => {
  const { stripPullRequestCopy } = await import('../../workspace/PullRequestMark')
  const text = (list: BranchPullRequest[]) => stripPullRequestCopy(list, NOW)?.text ?? null
  expect(text([])).toBe(null)
  expect(text([pr({ number: 12 })])).toBe('Open PR #12')
  expect(text([pr({ number: 12, isDraft: true })])).toBe('Open draft PR #12')
  expect(text([pr({ number: 12, state: 'merged' })])).toBe('Merged PR #12')
  expect(text([pr({ number: 12, state: 'closed' })])).toBe(null)
  expect(
    text([
      pr({
        number: 5,
        url: 'https://gitlab.com/acme/app/-/merge_requests/5',
        repoKey: 'gitlab.com/acme/app',
        forge: 'gitlab',
      }),
    ]),
  ).toBe('Opened PR #5')
  // The mark's own pull request: the newest still open beats a newer merged one.
  expect(text([pr({ number: 9, state: 'merged', openedAt: NOW }), pr({ number: 8, openedAt: NOW - 1 })])).toBe(
    'Open PR #8',
  )
  // Several repositories: the button says which.
  expect(
    text([
      pr({ number: 3, openedAt: NOW }),
      pr({ number: 4, url: 'https://github.com/acme/site/pull/4', repoKey: 'github.com/acme/site', repoName: 'site' }),
    ]),
  ).toBe('Open PR app #3')
})

test('the strip draws the button only for a conversation that opened a pull request, and it opens it', async () => {
  const { ConversationComposerStrip } = await import('./conversationStrip')
  const none = await mount(
    <ConversationComposerStrip machine={null} branch={null} changes={null} context={null} now={NOW} />,
  )
  expect(none.container.innerHTML).toBe('')
  await none.unmount()

  const closedOnly = await mount(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={null}
      pullRequests={[pr({ number: 2, state: 'closed' })]}
      now={NOW}
    />,
  )
  expect(closedOnly.container.querySelector('[data-strip-pull-request]')).toBe(null)
  await closedOnly.unmount()

  const one = await mount(
    <ConversationComposerStrip
      machine={null}
      branch={{ name: 'feature/marks', worktree: false, onOpen: null }}
      changes={null}
      context={{ used: 40_000, total: 200_000 }}
      pullRequests={[pr({ number: 12 })]}
      now={NOW}
    />,
  )
  const button = one.container.querySelector<HTMLButtonElement>('[data-strip-pull-request]')
  expect(button?.textContent).toContain('Open PR #12')
  expect(button?.getAttribute('aria-label')).toMatch(
    /^Open PR #12\. Pull request 12, open: Change 12\. Open it on GitHub$/,
  )
  // The button sits before the ring, at the strip's right end.
  const slots = [...one.container.querySelectorAll('[data-strip-pull-request-slot], [data-strip-context]')]
  expect(slots.map((slot) => slot.hasAttribute('data-strip-context'))).toEqual([false, true])
  await one.act(async () => button?.click())
  expect(opened).toEqual(['https://github.com/acme/app/pull/12'])
  await one.unmount()
})
