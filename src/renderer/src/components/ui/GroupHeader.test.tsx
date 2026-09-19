import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// GroupHeader — the collapsible band (design-system/components/group-header).
//
// The assertions are aimed at what a collapsible group header is easy to get
// wrong, and at the two decisions the spec had to make explicitly:
//
//   1. ONE disclosure control, carrying `aria-expanded` and `aria-controls` —
//      a title that is also a trigger is two places for the state to disagree;
//   2. the box is tri-state, and mixed is the RESTING state of a partly-staged
//      group rather than an edge case;
//   3. a collapsed group keeps its count — folding a group away must not also
//      hide how much was folded;
//   4. the count is not bold: a band with two names has no title;
//   5. the revealed control appears on focus as well as hover.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window as unknown as Record<string, unknown>
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
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
  const { GroupHeader, GroupHeaderAction } = await import('./GroupHeader')

  const document = dom.window.document

  function mount(node: React.ReactNode): { band: HTMLElement; container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    return {
      band: container.firstElementChild as HTMLElement,
      container: container as unknown as HTMLElement,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  run('one disclosure control, and it carries both the state and what it folds', () => {
    const view = mount(
      <GroupHeader title="Changes" count="26 files" expanded controls="changes-body" onExpandedChange={() => {}} />,
    )
    const triggers = Array.from(view.container.querySelectorAll('[aria-expanded]'))
    assert.equal(triggers.length, 1, 'a title that is also a trigger is two places for the state to disagree')
    assert.equal(triggers[0].getAttribute('aria-expanded'), 'true')
    assert.equal(triggers[0].getAttribute('aria-controls'), 'changes-body')
    assert.equal(triggers[0].tagName, 'BUTTON', 'collapsing is an action, so the control is a button')
    assert.match(
      triggers[0].getAttribute('aria-label') ?? '',
      /Collapse Changes/,
      "the name says what collapses — it is read out of the band's context",
    )
    view.unmount()
  })

  run('a collapsed group keeps its count, and says it can be expanded', () => {
    const collapsed: string[] = []
    const view = mount(
      <GroupHeader
        title="Skills catalogue paging"
        count="9 files"
        expanded={false}
        controls="skills-body"
        onExpandedChange={(next) => collapsed.push(String(next))}
      />,
    )
    assert.match(view.band.textContent ?? '', /9 files/, 'folding a group away must not hide how much was folded')
    const trigger = view.container.querySelector('[aria-expanded]') as HTMLElement
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.match(trigger.getAttribute('aria-label') ?? '', /Expand /)
    act(() => {
      trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(collapsed, ['true'])
    view.unmount()
  })

  run('the count is muted and regular weight — the title is the only name on the band', () => {
    const view = mount(
      <GroupHeader title="Changes" count="26 files" expanded controls="b" onExpandedChange={() => {}} />,
    )
    const spans = Array.from(view.band.querySelectorAll('span'))
    const titleSpan = spans.find((span) => span.textContent === 'Changes')
    const countSpan = spans.find((span) => span.textContent === '26 files')
    assert.match(titleSpan?.getAttribute('class') ?? '', /font-semibold/)
    assert.match(countSpan?.getAttribute('class') ?? '', /font-normal/, 'a bolded count reads as a second name')
    assert.match(countSpan?.getAttribute('class') ?? '', /tabular-nums/)
    assert.match(countSpan?.getAttribute('class') ?? '', /text-\[color:var\(--text-muted\)\]/)
    view.unmount()
  })

  run('the box is tri-state, and mixed is a state of its own', () => {
    const mixed = mount(
      <GroupHeader
        title="Changes"
        expanded
        controls="b"
        onExpandedChange={() => {}}
        checked="mixed"
        onCheckedChange={() => {}}
        checkLabel="Stage every file in Changes"
      />,
    )
    const input = mixed.container.querySelector('input[type="checkbox"]') as HTMLInputElement
    assert.ok(input, 'this box IS a control — one per group, not one per file')
    assert.equal(input.indeterminate, true, 'a partly-staged group is the resting case, not an edge case')
    assert.equal(input.checked, false)
    assert.equal(input.getAttribute('aria-label'), 'Stage every file in Changes')

    const all = mount(
      <GroupHeader
        title="Changes"
        expanded
        controls="b"
        onExpandedChange={() => {}}
        checked
        onCheckedChange={() => {}}
      />,
    )
    const allInput = all.container.querySelector('input[type="checkbox"]') as HTMLInputElement
    assert.equal(allInput.checked, true)
    assert.equal(allInput.indeterminate, false)

    mixed.unmount()
    all.unmount()
  })

  run('a band with no box draws no box at all', () => {
    const view = mount(<GroupHeader title="Changes" expanded controls="b" onExpandedChange={() => {}} />)
    assert.equal(view.container.querySelectorAll('input').length, 0)
    view.unmount()
  })

  run('the trailing control reveals on focus as well as hover, and is one control', () => {
    const view = mount(
      <GroupHeader
        title="Changes"
        expanded
        controls="b"
        onExpandedChange={() => {}}
        action={<GroupHeaderAction ariaLabel="Changes options">⋮</GroupHeaderAction>}
      />,
    )
    const slot = Array.from(view.band.children).find((child) =>
      (child.getAttribute('class') ?? '').includes('opacity-0'),
    )
    assert.ok(slot, 'the slot holds its width at rest, so revealing never reflows the band')
    const classes = slot.getAttribute('class') ?? ''
    assert.match(classes, /group-hover:opacity-100/)
    assert.match(
      classes,
      /group-focus-within:opacity-100/,
      'a control that only exists under a pointer is unreachable by keyboard and touch',
    )
    assert.equal(slot.querySelectorAll('button').length, 1, 'one control — three glyphs would be a second toolbar')
    assert.equal(slot.querySelector('button')?.getAttribute('aria-label'), 'Changes options')
    view.unmount()
  })

  run('the overflow control says it opens a menu, and whether it is open', () => {
    const closed = mount(
      <GroupHeader
        title="Changes"
        expanded
        controls="b"
        onExpandedChange={() => {}}
        action={
          <GroupHeaderAction ariaLabel="Actions for Changes" menu expanded={false}>
            ⋮
          </GroupHeaderAction>
        }
      />,
    )
    const trigger = closed.band.querySelector('button[aria-label="Actions for Changes"]')
    assert.equal(trigger?.getAttribute('aria-haspopup'), 'menu', 'the slot is specified as an overflow MENU')
    assert.equal(
      trigger?.getAttribute('aria-expanded'),
      'false',
      'haspopup without expanded announces a menu and never says whether it is showing',
    )
    closed.unmount()

    const open = mount(
      <GroupHeader
        title="Changes"
        expanded
        controls="b"
        onExpandedChange={() => {}}
        action={
          <GroupHeaderAction ariaLabel="Actions for Changes" menu expanded>
            ⋮
          </GroupHeaderAction>
        }
      />,
    )
    assert.equal(
      open.band.querySelector('button[aria-label="Actions for Changes"]')?.getAttribute('aria-expanded'),
      'true',
    )
    open.unmount()

    // A plain action control claims neither — it acts rather than opening
    // anything, and an `aria-haspopup` it never honours is a promise broken.
    const plain = mount(
      <GroupHeader
        title="Changes"
        expanded
        controls="b"
        onExpandedChange={() => {}}
        action={<GroupHeaderAction ariaLabel="Refresh Changes">⟳</GroupHeaderAction>}
      />,
    )
    const bare = plain.band.querySelector('button[aria-label="Refresh Changes"]')
    assert.equal(bare?.getAttribute('aria-haspopup'), null)
    assert.equal(bare?.getAttribute('aria-expanded'), null)
    plain.unmount()
  })

  run('the band takes no role and no tab stop of its own', () => {
    const view = mount(
      <GroupHeader
        title="Changes"
        expanded
        controls="b"
        onExpandedChange={() => {}}
        checked={false}
        onCheckedChange={() => {}}
      />,
    )
    assert.equal(view.band.hasAttribute('role'), false)
    assert.equal(
      view.band.hasAttribute('tabindex'),
      false,
      'three controls sit in it; a fourth wrapper would be a composite widget nobody asked for',
    )
    view.unmount()
  })

  if (failures > 0) {
    console.error(`\nGroupHeader.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('GroupHeader: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
