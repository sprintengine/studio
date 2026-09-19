import assert from 'node:assert/strict'

import { pagerSteps } from '../../../../ui/Pager'
import {
  CATALOGUE_PAGE_SIZE,
  catalogueRangeLabel,
  clampCataloguePage,
  deriveCataloguePage,
  stepCataloguePage,
  type CatalogueGroup,
} from './cataloguePaging'
import { test } from 'vitest'

test('cataloguePaging', async () => {
  // The pager replaced "Show N more" (source-tabs ruling, 2026-09-05), so what it
  // owes is everything that toggle never said: where you are, how much there is,
  // and a page that means the same thing next time you ask for it.

  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  const groups = (...counts: number[]): CatalogueGroup[] =>
    counts.map((count, index) => ({ key: `g${index}`, label: `Group ${index}`, count }))

  run('a page is a window over the groups in order, and one page holds pageSize rows', () => {
    const view = deriveCataloguePage({ groups: groups(160, 2, 73), page: 1, pageSize: 12 })
    assert.equal(view.total, 235)
    assert.equal(view.pageCount, 20)
    assert.equal(view.rangeStart, 1)
    assert.equal(view.rangeEnd, 12)
    assert.deepEqual(
      view.groups.map((group) => [group.key, group.start, group.end]),
      [['g0', 0, 12]],
      'a page that fits inside one group shows only that group',
    )
  })

  run('a group that does not fit continues onto the next page, under a heading that says so', () => {
    const spec = { groups: groups(5, 9), pageSize: 6 }
    const first = deriveCataloguePage({ ...spec, page: 1 })
    assert.deepEqual(
      first.groups.map((group) => [group.key, group.start, group.end, group.continued]),
      [
        ['g0', 0, 5, false],
        ['g1', 0, 1, false],
      ],
      'a page can end inside a group rather than truncating it',
    )
    const second = deriveCataloguePage({ ...spec, page: 2 })
    assert.deepEqual(
      second.groups.map((group) => [group.key, group.start, group.end, group.continued]),
      [['g1', 1, 7, true]],
      'and the next page picks that group up where it left off, marked as continued',
    )
    assert.equal(second.groups[0].total, 9, 'the heading still states the whole group, not the slice')
  })

  run('an empty group takes no space and draws no heading', () => {
    const view = deriveCataloguePage({ groups: groups(0, 3, 0), page: 1, pageSize: 12 })
    assert.deepEqual(
      view.groups.map((group) => group.key),
      ['g1'],
    )
    assert.equal(view.total, 3)
  })

  run('a page number beyond the end clamps to the last page that exists', () => {
    // A source removed while standing on page 9 of it: the honest answer is the
    // last page there is, never an empty canvas with working previous/next.
    const view = deriveCataloguePage({ groups: groups(14), page: 9, pageSize: 12 })
    assert.equal(view.pageCount, 2)
    assert.equal(view.page, 2)
    assert.equal(view.rangeStart, 13)
    assert.equal(view.rangeEnd, 14)
    assert.equal(clampCataloguePage(0, 3), 1, 'and page 0 is page 1')
    assert.equal(clampCataloguePage(Number.NaN, 3), 1)
  })

  run('an empty tab still has one page, and its sentence says what is missing', () => {
    const empty = deriveCataloguePage({ groups: [], page: 1, noun: 'plugin' })
    assert.equal(empty.pageCount, 1)
    assert.equal(empty.rangeStart, 0)
    assert.equal(empty.rangeLabel, 'No plugins here')
    const noHits = deriveCataloguePage({ groups: [], page: 1, noun: 'plugin', query: '  stripe ' })
    assert.equal(noHits.rangeLabel, 'Nothing matches “stripe”', 'a search with no hits says which search')
  })

  run('the range sentence says where you are, in words', () => {
    assert.equal(catalogueRangeLabel({ rangeStart: 13, rangeEnd: 24, total: 318 }), 'Showing 13–24 of 318')
  })

  run('a search or a tab change lands on page 1; the same list keeps its page', () => {
    const onPage9 = { key: 'builtin ', page: 9 }
    assert.deepEqual(
      stepCataloguePage(onPage9, 'builtin stripe'),
      { key: 'builtin stripe', page: 1 },
      'typing in the search box resets — page 9 of a two-page result is a number that stops meaning what it says',
    )
    assert.deepEqual(
      stepCataloguePage(onPage9, 'github:acme/skills '),
      { key: 'github:acme/skills ', page: 1 },
      'and so does switching tab — page 4 of one source is not page 4 of another',
    )
    assert.deepEqual(
      stepCataloguePage(onPage9, 'builtin '),
      { key: 'builtin ', page: 9 },
      'an unrelated re-render keeps the page the person is standing on',
    )
    assert.deepEqual(stepCataloguePage(onPage9, 'builtin ', 3), { key: 'builtin ', page: 3 })
  })

  run('the number strip keeps its width: the ends are always reachable, the middle elides', () => {
    assert.deepEqual(pagerSteps(1, 1), [1])
    assert.deepEqual(pagerSteps(1, 4), [1, 2, 3, 4], 'a short strip draws every page')
    assert.deepEqual(pagerSteps(1, 27), [1, 2, 3, 'gap', 27])
    assert.deepEqual(pagerSteps(14, 27), [1, 'gap', 12, 13, 14, 15, 16, 'gap', 27])
    assert.deepEqual(pagerSteps(27, 27), [1, 'gap', 25, 26, 27])
    assert.deepEqual(
      pagerSteps(4, 6),
      [1, 2, 3, 4, 5, 6],
      'a single skipped page is drawn rather than elided — "1 … 3" is wider than "1 2 3" and hides more',
    )
    assert.deepEqual(pagerSteps(1, 0), [], 'nothing to page is no strip at all')
  })

  run('the page size is the two full columns the ruling asks for', () => {
    assert.ok(CATALOGUE_PAGE_SIZE >= 12 && CATALOGUE_PAGE_SIZE <= 24)
    assert.equal(CATALOGUE_PAGE_SIZE % 2, 0, 'so the last row of a full page is never a lone column')
  })

  run('300+ rows are never all in one page', () => {
    const view = deriveCataloguePage({ groups: groups(318), page: 1 })
    const mounted = view.groups.reduce((sum, group) => sum + (group.end - group.start), 0)
    assert.equal(mounted, CATALOGUE_PAGE_SIZE, 'the caller is handed one page of rows to render, not 318')
  })

  console.log('catalogue paging: ok')
})
