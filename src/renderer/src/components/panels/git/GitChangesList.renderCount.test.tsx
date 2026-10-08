import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test, vi } from 'vitest'

import type { GitChangesListProps } from './GitChangesList'
import type { GitChangeGroup, GitChangeRow } from './gitChangesModel'

const rendered = vi.hoisted(() => ({ rows: 0 }))

// Every row is a CheckRow; counting its renders counts the rows'.
vi.mock('../../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui')>()
  const React = await import('react')
  const CheckRow = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof actual.CheckRow>>((props, ref) => {
    rendered.rows += 1
    return React.createElement(actual.CheckRow, { ...props, ref })
  })
  return { ...actual, CheckRow }
})

const ROWS = 300

test('a panel re-render leaves the change rows alone, and a cursor move renders only the rows it touches', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { GitChangesList } = await import('./GitChangesList')
  const { changeRowKey } = await import('./gitChangesModel')

  const rows: GitChangeRow[] = Array.from({ length: ROWS }, (_, index) => {
    const relativePath = `src/file-${index}.ts`
    const draft = {
      path: `/repo/${relativePath}`,
      relativePath,
      filename: `file-${index}.ts`,
      directory: 'src',
      status: 'modified' as const,
      staged: false,
      unstaged: true,
      checked: false as const,
      diffScope: 'unstaged' as const,
    }
    return { ...draft, key: changeRowKey(draft) }
  })
  const groups: GitChangeGroup[] = [
    {
      id: 'default',
      title: 'Changes',
      kind: 'changelist',
      totalCount: rows.length,
      rows,
      allRows: rows,
      omittedCount: 0,
      checked: false,
    },
  ]
  const expandedGroupIds = new Set(['default'])
  const selectedRowKeys = new Set<string>()
  let registered = 0

  // Fresh closures on every call, the way the panel hands them over.
  const props = (cursorRowKey: string | null): GitChangesListProps => ({
    listId: 'changes',
    groups,
    visibleRows: rows,
    expandedGroupIds,
    onExpandedChange: () => {},
    selectedRowKeys,
    cursorRowKey,
    onToggleRow: () => {},
    onToggleGroup: () => {},
    onRowClick: () => false,
    onActivateRow: () => {},
    onMoveCursor: () => {},
    onSelectAll: () => {},
    onContextSelect: () => {},
    buildMenu: () => [],
    buildGroupMenu: () => [],
    onOpenInEditor: () => {},
    onDeleteFiles: () => {},
    onAddToGit: () => {},
    onEditChangelist: () => {},
    registerRowNode: () => {
      registered += 1
    },
  })

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(React.createElement(GitChangesList, props(null))))
  assert.equal(rendered.rows, ROWS)
  assert.equal(registered, ROWS)

  rendered.rows = 0
  registered = 0
  act(() => root.render(React.createElement(GitChangesList, props(null))))
  assert.equal(rendered.rows, 0, 'new closures for the same rows render none of them')
  assert.equal(registered, 0, 'and no row node is detached and attached again')

  act(() => root.render(React.createElement(GitChangesList, props(rows[5]!.key))))
  assert.equal(rendered.rows, 1, 'the cursor arriving renders its row')
  rendered.rows = 0
  act(() => root.render(React.createElement(GitChangesList, props(rows[6]!.key))))
  assert.equal(rendered.rows, 2, 'moving it renders the row it left and the row it reached')

  act(() => root.unmount())
})
