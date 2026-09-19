import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { GitChangesList, type GitChangesListProps } from './GitChangesList'
import { changeRowKey, groupToggleAction, type GitChangeGroup, type GitChangeRow } from './gitChangesModel'
import { test } from 'vitest'

test('GitChangesList', async () => {
  // The Changes list, rendered (epic `git-commit-window`, adversarial review).
  //
  // SSR rather than a mounted tree: this list is composed of kit primitives that
  // each have their own suite, and what has never been checked is the SHAPE it
  // assembles them into — which roles nest inside which, whether every row still
  // carries the handler that keeps a tick from opening a diff, and whether the
  // glyph wears the kind hue. All of that is in the static markup, and reading it
  // there costs no DOM, no act(), and no fake `window.api`.

  const dom = new JSDOM('<!doctype html><html><body></body></html>')

  function row(relativePath: string, over: Partial<GitChangeRow> = {}): GitChangeRow {
    const slash = relativePath.lastIndexOf('/')
    const draft = {
      path: `/repo/${relativePath}`,
      relativePath,
      filename: slash === -1 ? relativePath : relativePath.slice(slash + 1),
      directory: slash === -1 ? '' : relativePath.slice(0, slash),
      status: 'modified' as const,
      staged: false,
      unstaged: true,
      checked: false as const,
      diffScope: 'unstaged' as const,
      ...over,
    }
    return { ...draft, key: over.key ?? changeRowKey(draft) }
  }

  function group(over: Partial<GitChangeGroup> & { id: string; title: string }): GitChangeGroup {
    const rows = over.rows ?? []
    return {
      kind: 'changelist',
      totalCount: rows.length,
      rows,
      allRows: rows,
      omittedCount: 0,
      checked: false,
      ...over,
    }
  }

  const NOOP = (): void => {}

  function render(groups: GitChangeGroup[], over: Partial<GitChangesListProps> = {}): Element {
    const visibleRows = groups.flatMap((entry) => entry.rows)
    const props: GitChangesListProps = {
      listId: 'changes',
      groups,
      visibleRows,
      expandedGroupIds: new Set(groups.map((entry) => entry.id)),
      onExpandedChange: NOOP,
      selectedRowKeys: new Set<string>(),
      cursorRowKey: null,
      onToggleRow: NOOP,
      onToggleGroup: NOOP,
      onRowClick: () => false,
      onActivateRow: NOOP,
      onMoveCursor: NOOP,
      onSelectAll: NOOP,
      onContextSelect: NOOP,
      buildMenu: () => [],
      buildGroupMenu: () => [],
      onOpenInEditor: NOOP,
      onDeleteFiles: NOOP,
      onAddToGit: NOOP,
      onEditChangelist: NOOP,
      registerRowNode: NOOP,
      ...over,
    }
    const host = dom.window.document.createElement('div')
    host.innerHTML = renderToStaticMarkup(React.createElement(GitChangesList, props))
    const root = host.firstElementChild
    assert.ok(root, 'the list rendered nothing')
    return root
  }

  const FIXTURE = [
    group({
      id: 'changelist:default',
      title: 'Changes',
      active: true,
      changelistId: 'default',
      checked: 'mixed',
      rows: [row('src/a.ts', { checked: true, staged: true, unstaged: false }), row('src/deep/b.tsx')],
    }),
    group({
      id: 'changelist:spike',
      title: 'Spike',
      changelistId: 'spike',
      rows: [row('notes.md')],
    }),
    group({ id: 'untracked', kind: 'untracked', title: 'Untracked files', rows: [row('new.txt', { status: 'new' })] }),
  ]

  // ── the roles nest legally ───────────────────────────────────────────────────
  //
  // The rule the first spelling broke: a `listbox` owns `option`s and nothing
  // else, and a group band is three real controls (chevron, checkbox, overflow).
  // So the bands sit outside every listbox and each group's rows are their own —
  // design-system/components/check-row → "Where the group bands sit".
  {
    const root = render(FIXTURE)

    assert.equal(root.getAttribute('role'), 'group', 'the keyboard owner is a group, not a listbox')
    assert.equal(root.getAttribute('tabindex'), '0', 'and it is the one tab stop')

    const listboxes = Array.from(root.querySelectorAll('[role="listbox"]'))
    assert.equal(listboxes.length, FIXTURE.length, 'one listbox per group')

    for (const listbox of listboxes) {
      for (const child of Array.from(listbox.children)) {
        assert.equal(
          child.getAttribute('role'),
          'option',
          `a listbox child that is not an option: <${child.tagName.toLowerCase()}>`,
        )
      }
      assert.equal(listbox.querySelectorAll('button, input').length, 0, 'no control lives inside a listbox')
    }

    // The bands, and their three controls, are outside every one of them.
    const bands = Array.from(root.querySelectorAll('[data-git-group-header="true"]'))
    assert.equal(bands.length, FIXTURE.length, 'one band per group')
    for (const band of bands) {
      assert.equal(band.closest('[role="listbox"]'), null, 'the band stands outside the listbox it governs')
      assert.ok(band.querySelector('button[aria-expanded]'), 'the chevron is a real button with aria-expanded')
      assert.ok(band.querySelector('input[type="checkbox"]'), 'the box is the kit checkbox, whole')
    }

    // The chevron folds a REGION, not the listbox — so the cap notice has a legal
    // home inside the fold.
    for (const chevron of Array.from(root.querySelectorAll('button[aria-controls]'))) {
      // `getElementById`, not a `#id` selector: a group's id holds a `:`, which
      // is a pseudo-class to a CSS parser and a perfectly good id to the DOM.
      const wanted = chevron.getAttribute('aria-controls')
      const region = Array.from(root.querySelectorAll('[id]')).find((node) => node.id === wanted) ?? null
      assert.ok(region, 'aria-controls resolves')
      assert.equal(region!.getAttribute('role'), null, 'the folded region is not itself the listbox')
      assert.ok(region!.querySelector('[role="listbox"]'), 'the listbox is inside the fold')
    }
  }

  // The cap notice is in the fold and out of the listbox.
  {
    const root = render([
      group({
        id: 'changelist:default',
        title: 'Changes',
        rows: [row('src/a.ts')],
        allRows: [row('src/a.ts')],
        totalCount: 3,
        omittedCount: 2,
      }),
    ])
    const notice = Array.from(root.querySelectorAll('div')).find((node) =>
      node.textContent?.includes('more changes are hidden'),
    )
    assert.ok(notice, 'the cap notice renders')
    assert.equal(notice!.closest('[role="listbox"]'), null, 'and it is not a non-option child of the listbox')
  }

  // ── the row says what T5 ruled it says ───────────────────────────────────────
  {
    const root = render(FIXTURE)
    const options = Array.from(root.querySelectorAll('[role="option"]'))
    assert.equal(options.length, 4)

    // KIND colour on the glyph — the epic's ruling, which revised the 2026-09-06
    // identity-colour carve-out for this very list. `data-tone="kind"` is what
    // `FileTypeGlyph` stamps when it is asked for the hue AND the kind has one;
    // `.ts` and `.tsx` do, `.md` and `.txt` are among the kinds that stay in the
    // row's ink, so the assertion is on the rows that can wear a hue.
    for (const filename of ['a.ts', 'b.tsx']) {
      const option = options.find((candidate) => candidate.textContent?.includes(filename))
      assert.ok(option, `no row for ${filename}`)
      assert.ok(option!.querySelector('svg[data-tone="kind"]'), `${filename} wears its language's hue`)
    }
    assert.match(
      readFileSync(join(process.cwd(), 'src/renderer/src/components/panels/git/GitChangesList.tsx'), 'utf8'),
      /<FileTypeGlyph name=\{row\.filename\} tone="kind"/,
      'and every row asks for it, whether or not its kind has one',
    )

    for (const option of options) {
      assert.ok(
        option.querySelector('span[aria-hidden="true"] > svg'),
        'the glyph slot says nothing: the name carries the meaning',
      )

      // NO TRAILING STATUS LETTER. T5 dropped it, which makes the visually-hidden
      // word the only non-colour carrier of the status left — and colour alone is
      // not an accessible signal, so it has to be there.
      assert.equal(
        option.querySelector('.font-mono.text-micro'),
        null,
        "no trailing letter — the mockup's row ends at the directory",
      )
      assert.ok(option.querySelector('.sr-only'), 'so the status word travels with the name instead')
    }

    const statuses = options.map((option) => option.querySelector('.sr-only')?.textContent?.trim())
    assert.deepEqual(statuses, [', modified', ', modified', ', modified', ', added'])

    // Selection and the tick are different questions and are announced as two.
    assert.deepEqual(
      options.map((option) => option.getAttribute('aria-checked')),
      ['true', 'false', 'false', 'false'],
    )
    for (const option of options) {
      assert.equal(option.getAttribute('aria-selected'), 'false', 'an option always declares whether it is chosen')
    }
  }

  // ── every row keeps its checkbox handler ─────────────────────────────────────
  //
  // The failure T5 documented, and the reason this is asserted on the SOURCE:
  // `CheckRow` only swallows the click on its box when it HAS a handler to run.
  // A row that dropped `onCheckedChange` while a git command was in flight would
  // let the click fall through to the row body — so a tick would open the diff.
  // The handler is therefore unconditional, and a `busy &&` creeping in here is
  // exactly what this reads for.
  {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/panels/git/GitChangesList.tsx'),
      'utf8',
    )
    assert.match(
      source,
      /onCheckedChange=\{\(\) => onToggleRow\(row\)\}/,
      'the row box hands over its handler unconditionally',
    )
    assert.ok(
      !/onCheckedChange=\{[^}]*\?[^}]*onToggleRow/.test(source),
      'never behind a condition: a box that drops its handler shows a diff instead of ticking',
    )
  }

  // ── an empty group's box is live, and stages nothing ─────────────────────────
  //
  // A changelist a person has just made is empty, and its band still has to be
  // operable — so the box is not withheld. What must not happen is the panel
  // calling `git stage` with an empty path list, which is a spawn that can only
  // fail.
  {
    const root = render([group({ id: 'changelist:new', title: 'Spike', rows: [] })])
    const listbox = root.querySelector('[role="listbox"]')
    assert.ok(listbox, 'the group still renders its (empty) listbox')
    assert.equal(listbox!.querySelectorAll('[role="option"]').length, 0)
    const box = root.querySelector('input[type="checkbox"]')
    assert.ok(box, 'and its band still carries a box a person can tick')
    assert.equal(box!.hasAttribute('disabled'), false)

    assert.deepEqual(groupToggleAction([], true), { action: 'stage', rows: [], paths: [], partialRows: [] })
    assert.deepEqual(groupToggleAction([], false), { action: 'unstage', rows: [], paths: [], partialRows: [] })
    const panel = readFileSync(join(process.cwd(), 'src/renderer/src/components/panels/GitPanel.tsx'), 'utf8')
    assert.match(
      panel,
      /groupToggleAction\(group\.allRows, next\)[\s\S]{0,120}?if \(rows\.length === 0\) return/,
      'and the panel returns before spawning git with nothing to act on',
    )
  }

  // ── the guest row: a second row about one file ───────────────────────────────
  //
  // Agent changelists let a list own hunks of a file whose home is another list,
  // which draws a `partial` row beside the home one. The two share a path, so
  // everything this list keys on has to be the ROW KEY — and the chip has to be
  // joined by a sentence, because a chip is a drawing and this row's box does
  // something different from every other box in the panel.
  {
    const guest = row('src/a.ts', { partial: true, changelistId: 'agent:nadia' })
    const home = row('src/a.ts')
    assert.notEqual(guest.key, home.key, 'two rows about one file are two keys')

    const root = render(
      [
        group({ id: 'changelist:default', title: 'Changes', changelistId: 'default', rows: [home] }),
        group({ id: 'changelist:agent:nadia', title: 'Nadia', changelistId: 'agent:nadia', rows: [guest] }),
      ],
      { selectedRowKeys: new Set([guest.key]), cursorRowKey: guest.key },
    )

    const options = Array.from(root.querySelectorAll('[role="option"]'))
    assert.equal(options.length, 2, 'the file draws in both lists')
    const ids = options.map((option) => option.id)
    assert.equal(new Set(ids).size, 2, 'and the two carry different DOM ids')

    const partialOption = options[1]
    assert.equal(
      partialOption.getAttribute('aria-selected'),
      'true',
      'the selection reached the guest row and not the home row',
    )
    assert.equal(options[0].getAttribute('aria-selected'), 'false', 'a selection keyed by path would have ticked both')
    assert.ok(partialOption.textContent?.includes('partial'), 'the guest row wears the partial chip')
    assert.ok(!options[0].textContent?.includes('partial'), 'and the home row does not')
    const spoken = Array.from(partialOption.querySelectorAll('.sr-only'))
      .map((node) => node.textContent ?? '')
      .join(' ')
    assert.match(spoken, /partial/, 'the chip is spoken as well as drawn')
    assert.match(spoken, /Nadia/, 'and it names the list whose changes the row is')
    assert.match(spoken, /stages/, 'and says what its box will do, which is not what the others do')
  }

  // ── the band's header is a name and a count, and nothing else ────────────────
  //
  // The owner's ruling, 2026-09-09: an agent's list header draws exactly like any
  // other list's — no liveness dot, no status glyph. The `active` chip is the one
  // mark a band may wear, and only the active list wears it.
  {
    const root = render([
      group({ id: 'changelist:agent:nadia', title: 'Nadia', changelistId: 'agent:nadia', rows: [row('src/a.ts')] }),
    ])
    const band = root.querySelector('[data-git-group-header="true"]')
    assert.ok(band)
    assert.ok(band!.textContent?.includes('Nadia'), 'the agent’s name is the title')
    assert.ok(band!.textContent?.includes('1 file'), 'and the count reads like every other list’s')

    // The load-bearing half: an agent's band and a hand-made list's band are the
    // same drawing with a different word in it. A dot or a glyph added for owned
    // lists is exactly what this difference would show.
    // Same group id, so the only thing that can differ is what the header draws.
    const plain = render([
      group({ id: 'changelist:agent:nadia', title: 'Spike', changelistId: 'spike', rows: [row('src/a.ts')] }),
    ]).querySelector('[data-git-group-header="true"]')
    assert.ok(plain)
    assert.equal(
      band!.innerHTML.split('Nadia').join('LIST'),
      plain!.innerHTML.split('Spike').join('LIST'),
      'an owned list’s header is any other list’s header with the agent’s name in it',
    )
  }

  console.log('ok - the Changes list nests one listbox per group, and each owns options only')
})
