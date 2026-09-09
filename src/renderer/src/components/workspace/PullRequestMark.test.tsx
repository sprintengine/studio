import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import { pullRequestStateLabel, type BranchPullRequest } from '../../../../shared/git/pull-request'

// The pull request mark, in the one module both surfaces draw it from (epic
// `pull-request-marks`, items `sidebar-line-pull-request-mark` and
// `peek-head-pull-request`).
//
// Two halves here. The WORDS are pure functions and are asserted directly,
// because a tooltip is portalled on hover and never appears in the markup the
// sidebar and card suites render. The MENU is asserted in a real DOM, because
// grouping, order, and "choosing a row does not re-point the primary" are
// behaviour rather than copy.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
// The kit's popover focuses its first row on the next frame (its surface is
// invisible until measured), so the menu needs the jsdom window's own rAF on
// the global the bundle reads.
anyGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
anyGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)

const opened: string[] = []
const refreshed: string[] = []
;(dom.window as unknown as { api: unknown }).api = {
  openExternal: async (url: string) => {
    opened.push(url)
  },
  refreshPullRequestsForSession: async (sessionId: string) => {
    refreshed.push(sessionId)
  },
}

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const pr = (over: Partial<BranchPullRequest> & { number: number }): BranchPullRequest => ({
  url: `https://github.com/acme/multicode/pull/${over.number}`,
  repoKey: 'github.com/acme/multicode',
  repoName: 'multicode',
  title: `Pull request ${over.number}`,
  state: 'open',
  isDraft: false,
  openedAt: NOW - HOUR,
  stateAt: NOW,
  ...over,
})

const failures: string[] = []
function run(name: string, body: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(body)
    .then(() => {
      console.log(`ok - ${name}`)
    })
    .catch((error: unknown) => {
      failures.push(name)
      console.log(`not ok - ${name}`)
      console.log(`  ${(error as Error).stack ?? (error as Error).message}`)
    })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A pull request number as the app writes it. Built rather than typed, because
// the design-token guard reads a literal `#418` as an inline hex colour — which
// in a file that is nothing but pull request numbers it never is.
const num = (n: number): string => `#${n}`

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const mark = await import('./PullRequestMark')
  const {
    PullRequestPeekMark,
    peekMarkCopy,
    pullRequestMenuGroups,
    pullRequestsSpanRepositories,
    refreshPullRequestsForLine,
    resetPullRequestRefreshes,
    shouldLookUpPullRequests,
    sidebarMarkCopy,
  } = mark

  const document = dom.window.document

  // ── the words ─────────────────────────────────────────────────────────────

  await run('an empty list has no copy at all — there is no “unknown” mark', () => {
    assert.equal(sidebarMarkCopy([]), null)
    assert.equal(peekMarkCopy([], NOW), null)
    assert.deepEqual(pullRequestMenuGroups([], NOW), [])
  })

  await run('the sidebar tooltip is the number, the state, and what a click does', () => {
    const copy = sidebarMarkCopy([pr({ number: 418 })])
    assert.deepEqual(copy, {
      title: `Pull request ${num(418)} open`,
      lines: ['Open it on GitHub'],
      ariaLabel: 'Pull request 418, open. Open it on GitHub',
    })
  })

  await run('a draft is an OPEN pull request whose tooltip says draft — never a fourth state', () => {
    const copy = sidebarMarkCopy([pr({ number: 415, isDraft: true })])
    assert.equal(copy?.title, `Pull request ${num(415)} open, a draft`)
    assert.match(copy?.ariaLabel ?? '', /415, open, a draft\./)
  })

  await run('every earlier pull request gets its own line, newest first, and is spoken too', () => {
    const copy = sidebarMarkCopy([
      pr({ number: 421, openedAt: NOW - HOUR }),
      pr({ number: 411, state: 'merged', openedAt: NOW - 2 * DAY }),
      pr({ number: 402, state: 'closed', openedAt: NOW - 4 * DAY }),
    ])
    assert.equal(copy?.title, `Pull request ${num(421)} open`)
    assert.deepEqual(copy?.lines, [
      'Open it on GitHub',
      `Earlier: ${num(411)} merged`,
      `Earlier: ${num(402)} closed without merging`,
    ])
    assert.equal(
      copy?.ariaLabel,
      'Pull request 421, open. Earlier: pull request 411, merged. Earlier: pull request 402, closed without merging. Open it on GitHub',
    )
  })

  await run('the mark is the most recent OPEN one, not simply the newest', () => {
    // The trap this rule exists for: a newer pull request that has already
    // landed must not take the mark from the open one behind it.
    const copy = sidebarMarkCopy([
      pr({ number: 420, state: 'merged', openedAt: NOW - HOUR }),
      pr({ number: 411, openedAt: NOW - 2 * DAY }),
    ])
    assert.equal(copy?.title, `Pull request ${num(411)} open`, 'the open one wears the mark')
    assert.deepEqual(copy?.lines.slice(1), [`Earlier: ${num(420)} merged`])
  })

  await run('once every one has landed the newest of them wears the mark', () => {
    const copy = sidebarMarkCopy([
      pr({ number: 420, state: 'merged', openedAt: NOW - HOUR }),
      pr({ number: 411, state: 'closed', openedAt: NOW - 2 * DAY }),
    ])
    assert.equal(copy?.title, `Pull request ${num(420)} merged`)
  })

  await run('a list spanning repositories names the repo on every line — and only then', () => {
    const list = [
      pr({ number: 12, repoKey: 'github.com/acme/multicode-website', repoName: 'multicode-website' }),
      pr({ number: 411, state: 'merged', openedAt: NOW - 2 * DAY }),
    ]
    assert.equal(pullRequestsSpanRepositories(list), true)
    assert.equal(pullRequestsSpanRepositories([list[1]!]), false)
    const copy = sidebarMarkCopy(list)
    assert.equal(copy?.title, `multicode-website ${num(12)} · open`)
    assert.deepEqual(copy?.lines, ['Open it on GitHub', `Earlier: multicode ${num(411)} · merged`])
    assert.equal(
      copy?.ariaLabel,
      'Pull request 12 in multicode-website, open. Earlier: pull request 411 in multicode, merged. Open it on GitHub',
    )
  })

  await run('the peek tooltip leads with the pull request’s own title and says how old it is', () => {
    const copy = peekMarkCopy(
      [pr({ number: 418, title: 'Extensions icon carries its unread count', openedAt: NOW - 12 * MINUTE })],
      NOW,
    )
    assert.deepEqual(copy, {
      title: 'Extensions icon carries its unread count',
      lines: [`Pull request ${num(418)} · open · 12 minutes ago`, 'Open it on GitHub'],
      ariaLabel:
        'Pull request 418, open: Extensions icon carries its unread count. Open it on GitHub',
    })
  })

  await run('a pull request the hooks just captured says its number, not a blank line', () => {
    // The exact record `noteCaptured` writes: a URL, the number parsed out of
    // it, no title, and the moment of capture standing in for the moment it was
    // opened. It stays that way until GitHub answers — and for ever if `gh`
    // never can. Rendered naively that was a bold empty line over the identity
    // line, and "Pull request 418, open: . Open it on GitHub" out loud.
    const captured: BranchPullRequest = {
      url: 'https://github.com/acme/multicode/pull/418',
      repoKey: 'github.com/acme/multicode',
      repoName: 'multicode',
      number: 418,
      title: '',
      state: 'open',
      isDraft: false,
      openedAt: NOW,
      stateAt: NOW,
      openedBySessionId: 'session-a',
    }
    const copy = peekMarkCopy([captured], NOW)
    const state = pullRequestStateLabel(captured)
    assert.equal(copy?.title, `Pull request ${num(418)}`, 'the identity leads, since nothing else can')
    assert.deepEqual(
      copy?.lines,
      [`${state} · now`, 'Open it on GitHub'],
      'and it is not repeated underneath: the line under it says only what is left to say',
    )
    assert.equal(
      copy?.ariaLabel,
      `Pull request 418, ${state}. Open it on GitHub`,
      'spoken, the colon clause goes with the title it introduced',
    )
    const [group] = pullRequestMenuGroups([captured, pr({ number: 411, state: 'merged' })], NOW)
    assert.equal(group?.rows[0]?.title, '', 'the menu row is the number alone')
    assert.equal(
      group?.rows[0]?.ariaLabel,
      `Pull request 418, ${state}. Open it on GitHub`,
    )
    // An hour later, still untitled, the age has something to say and joins the
    // state on the line under the identity.
    const older = peekMarkCopy([{ ...captured, openedAt: NOW - HOUR }], NOW)
    assert.equal(older?.title, `Pull request ${num(418)}`)
    assert.deepEqual(older?.lines, [`${state} · 1 hour ago`, 'Open it on GitHub'])
  })

  await run('the moment GitHub answers with a title, the title leads again', () => {
    const copy = peekMarkCopy(
      [pr({ number: 418, title: 'Gate OSC 52 writes', openedAt: NOW - 12 * MINUTE })],
      NOW,
    )
    assert.equal(copy?.title, 'Gate OSC 52 writes')
    assert.ok(
      copy?.lines[0]?.startsWith(`Pull request ${num(418)} · `),
      'the identity moves back down',
    )
    assert.match(copy?.ariaLabel ?? '', /: Gate OSC 52 writes\. Open it on GitHub$/)
  })

  await run('the menu groups by state, newest first inside each, and omits the empty groups', () => {
    const groups = pullRequestMenuGroups(
      [
        pr({ number: 409, openedAt: NOW - DAY, title: 'Gate OSC 52 writes' }),
        pr({ number: 406, openedAt: NOW - DAY - HOUR }),
        pr({ number: 402, state: 'closed', openedAt: NOW - 2 * DAY }),
        pr({ number: 401, state: 'merged', openedAt: NOW - 2 * DAY - HOUR }),
        pr({ number: 398, state: 'merged', openedAt: NOW - 3 * DAY }),
      ],
      NOW,
    )
    assert.deepEqual(
      groups.map((group) => group.label),
      ['Open · 2', 'Merged · 2', 'Closed · 1'],
    )
    assert.deepEqual(groups[0]?.rows.map((row) => row.number), [num(409), num(406)])
    assert.deepEqual(groups[1]?.rows.map((row) => row.number), [num(401), num(398)])
    assert.equal(groups[0]?.rows[0]?.age, '1d', 'the age rides the hint slot, terse')
    assert.equal(
      groups[0]?.rows[0]?.ariaLabel,
      'Pull request 409, open: Gate OSC 52 writes. Open it on GitHub',
    )
    const noneClosed = pullRequestMenuGroups([pr({ number: 1 })], NOW)
    assert.deepEqual(noneClosed.map((group) => group.id), ['open'], 'no heading over nothing')
  })

  await run('an agent line with a branch is worth a lookup — mark or no mark', () => {
    const line = { kind: 'agent' as const, branch: 'agent/osc52-gate' }
    assert.equal(shouldLookUpPullRequests(line), true)
    assert.equal(shouldLookUpPullRequests({ ...line, branch: null }), false, 'nothing to ask about')
    assert.equal(shouldLookUpPullRequests({ ...line, kind: 'shell' }), false, 'no conversation')
    assert.equal(shouldLookUpPullRequests({ ...line, kind: 'remote' }), false, 'another machine’s disk')
  })

  await run('a mousemove storm is one ask, and the minute after it is none', () => {
    resetPullRequestRefreshes()
    refreshed.length = 0
    const t0 = NOW
    for (let i = 0; i < 50; i += 1) refreshPullRequestsForLine('session-1', 'agent/x', t0 + i)
    assert.deepEqual(refreshed, ['session-1'], 'fifty pointer events, one call')
    refreshPullRequestsForLine('session-1', 'agent/x', t0 + 59_999)
    assert.deepEqual(refreshed, ['session-1'], 'still inside the window')
  })

  await run('a hover a minute later asks again — the reading may have gone stale', () => {
    resetPullRequestRefreshes()
    refreshed.length = 0
    refreshPullRequestsForLine('session-1', 'agent/x', NOW)
    refreshPullRequestsForLine('session-1', 'agent/x', NOW + 60_000)
    assert.deepEqual(refreshed, ['session-1', 'session-1'])
  })

  await run('the branch changing asks again at once, without waiting out the window', () => {
    // The bug this is the fix for: a line's branch is filled from the launch
    // intent, and main only acts once the OBSERVED checkout resolves. Keyed on
    // the session alone, the first hover of a chat's life spent the app's only
    // ask on a question main could not answer yet.
    resetPullRequestRefreshes()
    refreshed.length = 0
    refreshPullRequestsForLine('session-1', null, NOW)
    refreshPullRequestsForLine('session-1', 'agent/osc52-gate', NOW + 1)
    refreshPullRequestsForLine('session-1', 'agent/osc52-gate', NOW + 2)
    assert.deepEqual(refreshed, ['session-1', 'session-1'], 'the new branch asks; the repeat does not')
  })

  await run('two conversations are two asks', () => {
    resetPullRequestRefreshes()
    refreshed.length = 0
    refreshPullRequestsForLine('session-1', 'agent/x', NOW)
    refreshPullRequestsForLine('session-2', 'agent/x', NOW)
    assert.deepEqual(refreshed, ['session-1', 'session-2'])
  })

  await run('an ask main did not take does not spend the minute', async () => {
    // Forward-compatible with main answering whether it acted on the ask (it
    // holds one back while the observed checkout is unresolved). A refusal, and
    // a call that reached nobody at all, are both re-asked on the next hover.
    resetPullRequestRefreshes()
    refreshed.length = 0
    const api = (dom.window as unknown as { api: Record<string, unknown> }).api
    const settled = api.refreshPullRequestsForSession
    api.refreshPullRequestsForSession = async (sessionId: string) => {
      refreshed.push(sessionId)
      return false
    }
    refreshPullRequestsForLine('session-1', 'agent/x', NOW)
    await sleep(0)
    refreshPullRequestsForLine('session-1', 'agent/x', NOW + 1)
    await sleep(0)
    assert.deepEqual(refreshed, ['session-1', 'session-1'], 'a refusal is not an ask')
    api.refreshPullRequestsForSession = async (sessionId: string) => {
      refreshed.push(sessionId)
      throw new Error('main is restarting')
    }
    refreshed.length = 0
    resetPullRequestRefreshes()
    refreshPullRequestsForLine('session-2', 'agent/x', NOW)
    await sleep(0)
    refreshPullRequestsForLine('session-2', 'agent/x', NOW + 1)
    await sleep(0)
    assert.deepEqual(refreshed, ['session-2', 'session-2'], 'a call that reached nobody is re-asked')
    api.refreshPullRequestsForSession = settled
  })

  // ── the menu ──────────────────────────────────────────────────────────────

  function mount(node: React.ReactNode): { host: Element; unmount: () => void } {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(node)
    })
    return {
      host,
      unmount: () => {
        act(() => root.unmount())
        host.remove()
      },
    }
  }

  const MANY = [
    pr({ number: 409, title: 'Gate OSC 52 writes behind the setting', openedAt: NOW - DAY }),
    pr({ number: 402, state: 'closed', title: 'Drop OSC 52 entirely', openedAt: NOW - 2 * DAY }),
    pr({ number: 401, state: 'merged', title: 'Read OSC 52 through the stream', openedAt: NOW - 3 * DAY }),
  ]

  const menuSurface = (): Element | null => document.querySelector('[role="menu"]')
  const rows = (): HTMLElement[] =>
    Array.from(menuSurface()?.querySelectorAll<HTMLElement>('[data-menu-item="true"]') ?? [])

  await run('one pull request is a link with no chevron; two grow the split control', () => {
    const single = mount(
      React.createElement(PullRequestPeekMark, { pullRequests: [pr({ number: 418 })], now: NOW }),
    )
    assert.equal(
      single.host.querySelector('[aria-haspopup="menu"]'),
      null,
      'a chevron whose menu holds one row is a control that opens to say nothing',
    )
    assert.ok((single.host.textContent ?? '').includes(num(418)), 'the number is the mark’s label')
    single.unmount()

    const many = mount(React.createElement(PullRequestPeekMark, { pullRequests: MANY, now: NOW }))
    const chevron = many.host.querySelector('[aria-haspopup="menu"]')
    assert.ok(chevron, 'two or more grow the chevron')
    assert.equal(chevron?.getAttribute('aria-expanded'), 'false')
    assert.equal(
      chevron?.getAttribute('aria-label'),
      'All pull requests from this conversation, 3',
    )
    many.unmount()
  })

  await run('one pull request wears the SAME arm as several — same chrome, same hit floor', () => {
    // The mockup draws `.peek-pr` once and uses it for the lone mark and for
    // the primary half inside the split (frames 3 and 4). Before this the solo
    // arm was a text link of its own: no height, so a ~15px target where the
    // split arm gave 24, and an underline on hover where the split arm gives a
    // ground. The two arms are now the same element from the same component.
    // Whitespace-insensitive: a class string joined from parts can carry a gap
    // where an optional part was empty, and that is not a difference in chrome.
    const chrome = (el: Element | null | undefined): string =>
      (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).sort().join(' ')
    const single = mount(
      React.createElement(PullRequestPeekMark, { pullRequests: [pr({ number: 418 })], now: NOW }),
    )
    const soloArm = single.host.querySelector('[data-pull-request-mark]')
    const soloGroup = soloArm?.parentElement
    assert.equal(soloArm?.tagName, 'BUTTON', 'a control, not an anchor')
    assert.equal(
      single.host.querySelector('[aria-haspopup="menu"]'),
      null,
      'and no chevron over a menu with one row in it',
    )
    single.unmount()

    const many = mount(React.createElement(PullRequestPeekMark, { pullRequests: MANY, now: NOW }))
    const splitArm = many.host.querySelector('[data-pull-request-mark]')
    const splitGroup = splitArm?.parentElement
    assert.ok(splitArm, 'the split arm carries the marker too, so the mark is found the same way')
    assert.equal(chrome(soloArm), chrome(splitArm), 'the two arms are the same half')
    assert.equal(chrome(soloGroup), chrome(splitGroup), 'inside the same group chrome')
    assert.match(
      soloGroup?.getAttribute('class') ?? '',
      /h-\[var\(--hit-target-min\)\]/,
      'which is what pads the 16px drawing out to the 24px hit floor',
    )
    assert.match(soloArm?.getAttribute('class') ?? '', /hover:bg-\[color:var\(--bg-hover\)\]/, 'the hover fill')
    assert.equal(
      soloArm?.getAttribute('class')?.includes('underline'),
      false,
      'and no link underline, which a mark in a state tone must not take',
    )
    // The tooltip's `aria-describedby` lands on the wrapper span it clones, so
    // it is never announced — deliberately: the half's own name below is every
    // word the tooltip shows, and a description repeating it would be said
    // twice.
    assert.equal(
      splitArm?.getAttribute('aria-label'),
      peekMarkCopy(MANY, NOW)?.ariaLabel,
      'the spoken name carries the whole of what the tooltip says',
    )
    many.unmount()
  })

  await run('the menu is grouped, in state order, with the age in the hint slot', async () => {
    const view = mount(React.createElement(PullRequestPeekMark, { pullRequests: MANY, now: NOW }))
    await act(async () => {
      view.host.querySelector<HTMLElement>('[aria-haspopup="menu"]')!.click()
    })
    const surface = menuSurface()
    assert.ok(surface, 'the menu opened')
    assert.deepEqual(
      Array.from(surface!.querySelectorAll('.text-micro.text-\\[color\\:var\\(--text-subtle\\)\\]')).map(
        (node) => node.textContent,
      ),
      ['Open · 1', 'Merged · 1', 'Closed · 1'],
      'the group headings, counted, in the ruled order',
    )
    assert.deepEqual(
      rows().map((row) => row.textContent),
      [
        `${num(409)}Gate OSC 52 writes behind the setting1d`,
        `${num(401)}Read OSC 52 through the stream3d`,
        `${num(402)}Drop OSC 52 entirely2d`,
      ],
      'each row is number · title · age, grouped open then merged then closed',
    )
    assert.equal(
      rows()[0]?.getAttribute('aria-label'),
      'Pull request 409, open: Gate OSC 52 writes behind the setting. Open it on GitHub',
      'the spoken row carries the state the grouping shows',
    )
    assert.equal(rows()[0]?.getAttribute('role'), 'menuitem', 'no check: the primary is a rule')
    view.unmount()
  })

  await run('choosing a row opens THAT pull request and leaves the primary where it was', async () => {
    opened.length = 0
    const view = mount(React.createElement(PullRequestPeekMark, { pullRequests: MANY, now: NOW }))
    const primaryName = () =>
      view.host.querySelector('[aria-haspopup="menu"]')?.previousElementSibling?.getAttribute('aria-label')
    const before = primaryName()
    assert.match(before ?? '', /^Pull request 409, open/, 'the mark is the most recent open one')
    await act(async () => {
      view.host.querySelector<HTMLElement>('[aria-haspopup="menu"]')!.click()
    })
    await act(async () => {
      rows()[2]!.click()
    })
    assert.deepEqual(opened, ['https://github.com/acme/multicode/pull/402'], 'the row it chose')
    assert.equal(menuSurface(), null, 'and the menu closed behind it')
    assert.equal(primaryName(), before, 'the primary is a rule, not a memory of what you picked')
    view.unmount()
  })

  await run('Escape closes the menu without closing anything else', async () => {
    const view = mount(React.createElement(PullRequestPeekMark, { pullRequests: MANY, now: NOW }))
    await act(async () => {
      view.host.querySelector<HTMLElement>('[aria-haspopup="menu"]')!.click()
    })
    assert.ok(menuSurface(), 'precondition: the menu is open')
    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
      await sleep(0)
    })
    assert.equal(menuSurface(), null)
    view.unmount()
  })

  // ── the mark inside the card that hosts it ────────────────────────────────
  //
  // The peek is a `PointerPopover`, and its menu is a `Popover` portaled to
  // <body> from inside it. The two surfaces have to agree about who owns a key
  // and a press, and neither of them can be asserted from either component
  // alone — so the composition is mounted here, where the mark that puts one
  // inside the other lives.

  const { PointerPopover, Popover } = await import('../ui')

  function mountInCard(
    pullRequests: BranchPullRequest[],
  ): { host: Element; closes: () => number; unmount: () => void } {
    let closes = 0
    const view = mount(
      React.createElement(PointerPopover, {
        x: 20,
        y: 20,
        ariaLabel: 'Gate OSC 52 — conversation',
        popupRole: 'dialog' as const,
        onClose: () => {
          closes += 1
        },
        children: React.createElement(PullRequestPeekMark, { pullRequests, now: NOW }),
      }),
    )
    return { host: view.host, closes: () => closes, unmount: view.unmount }
  }

  const card = (): Element | null => document.querySelector('[role="dialog"]')
  const press = (target: Element): void => {
    target.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
  }
  const escape = (): void => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  await run('Escape in the mark’s menu closes the menu; the card only goes on the next one', async () => {
    const view = mountInCard(MANY)
    await act(async () => {
      card()!.querySelector<HTMLElement>('[aria-haspopup="menu"]')!.click()
    })
    assert.ok(menuSurface(), 'precondition: the menu is open inside the card')
    await act(async () => {
      escape()
      await sleep(0)
    })
    assert.equal(menuSurface(), null, 'the menu took the key')
    assert.equal(view.closes(), 0, 'and the card it was opened from stayed up')
    await act(async () => {
      escape()
      await sleep(0)
    })
    assert.equal(view.closes(), 1, 'with nothing of its own open, the card takes the next one')
    view.unmount()
  })

  await run('pressing a row of the mark’s own menu does not dismiss the card under it', async () => {
    const view = mountInCard(MANY)
    await act(async () => {
      card()!.querySelector<HTMLElement>('[aria-haspopup="menu"]')!.click()
    })
    await act(async () => {
      press(rows()[0]!)
      await sleep(0)
    })
    assert.equal(view.closes(), 0, 'the row is inside what the card opened, so it is not outside')
    view.unmount()
  })

  await run('a press inside an UNRELATED open popover still dismisses the card', async () => {
    const view = mountInCard(MANY)
    // Somebody else's menu, open at the same time and nothing to do with this
    // card — a filter menu on the panel behind it. The stack is global, so a
    // stack-wide "is this inside a popover" reads a press here as inside the
    // card and left the card standing for ever.
    const elsewhere = mount(
      React.createElement(Popover, {
        open: true,
        onOpenChange: () => {},
        ariaLabel: 'Filter',
        popupRole: 'listbox' as const,
        renderTrigger: ({ ref }: { ref: React.Ref<HTMLButtonElement> }) =>
          React.createElement('button', { ref, type: 'button' }, 'Filter'),
        children: React.createElement('div', { 'data-unrelated-row': 'true' }, 'Only mine'),
      }),
    )
    const unrelated = document.querySelector('[data-unrelated-row="true"]')
    assert.ok(unrelated, 'precondition: the unrelated popover is open')
    await act(async () => {
      press(unrelated!)
      await sleep(0)
    })
    assert.equal(view.closes(), 1, 'a press in someone else’s surface is an outside press')
    elsewhere.unmount()
    view.unmount()
  })

  await run('opening an agent tab’s card asks about that conversation, through the same helper', async () => {
    // The peek's OTHER anchor (epic decision 8a). A tab whose sidebar line is
    // scrolled out of view is never hovered there, so before this its marks
    // only arrived on the next window focus. It asks through the SAME helper,
    // so the two anchors share one coalescing window rather than each having
    // one of their own.
    const { AgentTabIdentityPopover } = await import('./AgentTabIdentityPopover')
    resetPullRequestRefreshes()
    refreshed.length = 0
    const identity = {
      name: 'planner-agent',
      taskId: null,
      status: { kind: 'working' as const, label: 'Working' },
      agent: {
        sessionId: 'a21ac8e7-548f-6f89',
        cli: 'claude-code',
        model: 'claude-opus-4-8',
        fileChanges: [],
        pullRequests: [],
        activeSubagents: 0,
        contextUsage: null,
      },
    }
    const view = mount(
      React.createElement(AgentTabIdentityPopover, {
        identity,
        lookupBranch: 'agent/osc52-gate',
        children: React.createElement('span', null, 'planner-agent'),
      }),
    )
    assert.deepEqual(refreshed, [], 'a tab nobody has looked at asks nothing')
    await act(async () => {
      view.host.firstElementChild!.dispatchEvent(
        new dom.window.FocusEvent('focusin', { bubbles: true }),
      )
      await sleep(0)
    })
    assert.deepEqual(refreshed, ['a21ac8e7-548f-6f89'], 'the card opening is the ask')
    view.unmount()
  })

  await run('the mark opens its own pull request through the app’s external opener', async () => {
    opened.length = 0
    const view = mount(
      React.createElement(PullRequestPeekMark, { pullRequests: [pr({ number: 418 })], now: NOW }),
    )
    await act(async () => {
      view.host.querySelector<HTMLElement>('[data-pull-request-mark]')!.click()
    })
    assert.deepEqual(opened, ['https://github.com/acme/multicode/pull/418'])
    view.unmount()
  })

  if (failures.length > 0) {
    console.error(`\n${failures.length} failing: ${failures.join(', ')}`)
    process.exitCode = 1
  }
}

void main()
