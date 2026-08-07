import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The step's team band (MC-2066) — the surface that answers "who does this
// work?" beside the step rather than in the top bar. What it must get right:
//
// 1. The split is the New sprint dialog's, because it is the same choice. No
//    roles reads as WHICH AGENT and how many at once, with no role list; a
//    roster reads as its roles and their runtimes, with no second agent picker
//    to contradict the roster.
// 2. Picking is ONE hop from the step, and clearing an override is offered
//    first, naming what the step falls back to.
// 3. Inheriting is the ABSENCE of an override: choosing "Use the horizon's
//    roster" clears it, and must never write the resolved name onto the step.
// 4. A roster the user no longer has stays loud — the step cannot start, and the
//    band never softens that into the default.

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

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { HorizonStepTeam } = await import('./HorizonStepTeam')
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

  const MOBILE_UI = {
    id: 'roster-mobile',
    name: 'Mobile UI',
    roleCounts: { frontend: 1, developer: 1 },
    roleCliDefaults: { frontend: 'claude-code' as const },
    createdAt: 0,
    updatedAt: 0,
  }

  type Mount = {
    host: HTMLElement
    unmount: () => Promise<void>
    picks: Array<string | undefined>
    agentPicks: Array<string | undefined>
    inherits: number
  }

  const mount = async (
    props: Partial<Parameters<typeof HorizonStepTeam>[0]> & {
      roster: Parameters<typeof HorizonStepTeam>[0]['roster']
    },
  ): Promise<Mount> => {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const picks: Array<string | undefined> = []
    const state: Mount = { host, picks, agentPicks: [], inherits: 0, unmount: async () => undefined }
    const root = createRoot(host)
    await act(async () => {
      root.render(
        React.createElement(HorizonStepTeam, {
          stepTitle: 'Terminal links open a chooser',
          rosters: [MOBILE_UI],
          inheritedLabel: 'No roles',
          onSelect: (name: string | undefined) => picks.push(name),
          onInherit: () => {
            state.inherits += 1
          },
          onManageRosters: () => undefined,
          onSelectAgent: (token: string | undefined) => state.agentPicks.push(token),
          ...props,
        }),
      )
    })
    state.unmount = async () => {
      await act(async () => root.unmount())
      host.remove()
    }
    return state
  }

  const click = async (element: Element | null | undefined): Promise<void> => {
    assert.ok(element, 'expected the element to exist before clicking it')
    await act(async () => {
      ;(element as HTMLElement).dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    })
  }

  const menuItems = (host: HTMLElement): HTMLElement[] =>
    Array.from(host.ownerDocument.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))

  await check('no roles reads as WHICH agent and how many, with no role list', async () => {
    const view = await mount({
      roster: { label: 'No roles', overridden: false, missing: false },
    })
    const text = view.host.textContent ?? ''
    assert.match(text, /[Oo]ne agent per task/, 'a plain-agent step is agents, not roles')
    assert.match(text, /up to 3 at once/, 'the concurrency the launch actually uses')
    assert.match(text, /claude-code|Claude Code/, 'and the runtime it actually spawns')
    assert.doesNotMatch(text, /Frontend|Developer/, 'there are no roles to list')
    await view.unmount()
  })

  await check('the agent is a PICKER bound to the resolved @agent token (MC-2145)', async () => {
    const view = await mount({
      roster: { label: 'No roles', overridden: false, missing: false },
      agent: 'codex/gpt-5.2',
    })
    const trigger = view.host.querySelector('button[aria-label^="Agent for"]')
    assert.ok(trigger, 'the plain-agents body carries the CliModelPicker trigger, not a sentence readout')
    assert.match(
      trigger?.getAttribute('aria-label') ?? '',
      /gpt-5\.2|codex/i,
      'and it is bound to the step’s own resolved runtime, not the stock default',
    )
    await view.unmount()
  })

  await check('a roster carries the agents — its roles, and no agent picker', async () => {
    const view = await mount({
      roster: { label: 'Mobile UI', overridden: true, missing: false },
    })
    const text = view.host.textContent ?? ''
    assert.match(text, /Mobile UI/, 'the team is named')
    assert.match(text, /Frontend/, 'and the roster’s own roles are the answer')
    assert.doesNotMatch(
      text,
      /[Oo]ne agent per task/,
      'the plain-agent line would contradict the roster that carries the agents',
    )
    await view.unmount()
  })

  await check('the tier is a fact about the value, not the label', async () => {
    const inherited = await mount({
      roster: { label: 'Mobile UI', overridden: false, missing: false },
    })
    assert.match(inherited.host.textContent ?? '', /from this horizon/)
    await inherited.unmount()
    const overridden = await mount({
      roster: { label: 'Mobile UI', overridden: true, missing: false },
    })
    assert.match(overridden.host.textContent ?? '', /set for this step/)
    await overridden.unmount()
  })

  await check('picking a team is one hop, and inheriting CLEARS rather than writes', async () => {
    const view = await mount({
      roster: { label: 'Mobile UI', overridden: true, missing: false },
      inheritedLabel: 'No roles',
    })
    await click(view.host.querySelector('button[aria-haspopup="menu"]'))
    const items = menuItems(view.host)
    const inheritRow = items.find((item) => /Use the horizon/.test(item.textContent ?? ''))
    assert.ok(inheritRow, 'clearing the override is offered first')
    assert.match(
      inheritRow.textContent ?? '',
      /Just an agent/,
      'and names what the step falls back to — the built-in reads "Just an agent", never "No roles" (MC-2145)',
    )
    await click(inheritRow)
    assert.equal(view.inherits, 1, 'inheriting goes through the CLEAR path')
    assert.deepEqual(view.picks, [], 'never through a write of the resolved name')

    await click(view.host.querySelector('button[aria-haspopup="menu"]'))
    const rosterRow = menuItems(view.host).find(
      (item) => (item.textContent ?? '').trim().startsWith('Mobile UI'),
    )
    await click(rosterRow)
    assert.deepEqual(view.picks, ['Mobile UI'], 'and picking a roster is one click from the step')
    await view.unmount()
  })

  await check('a roster the user no longer has says the step cannot start', async () => {
    const view = await mount({
      roster: { label: 'Opus', overridden: true, missing: true },
    })
    const text = view.host.textContent ?? ''
    assert.match(text, /Opus/, 'the step keeps the name it was given')
    assert.match(text, /cannot start/, 'and the consequence is stated, not softened')
    assert.doesNotMatch(text, /[Oo]ne agent per task/, 'it never falls through to the default')
    await view.unmount()
  })

  // The store is only read here — no test should have written to it.
  assert.ok(useWorkspaceStore.getState, 'the store module loaded')

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('horizon step team: all checks passed')
}

void main()
