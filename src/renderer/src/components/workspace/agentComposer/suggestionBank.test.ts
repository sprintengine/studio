import assert from 'node:assert/strict'
import { SUGGESTION_BANK, SUGGESTION_DRAW_SIZE, drawSuggestions, type SuggestionEntry } from './suggestionBank'
import { test } from 'vitest'

test('suggestionBank', async () => {
  // A card is a launch button, so two properties matter more than the
  // copy: the draw is STABLE for the life of a tab (a re-render must not move what
  // someone is reading), and it is SPREAD (four cards that are four flavours of
  // "review the code" waste the surface).

  // 1. Deterministic in the seed, and only in the seed.
  {
    const a = drawSuggestions(1234).map((entry) => entry.id)
    const b = drawSuggestions(1234).map((entry) => entry.id)
    assert.deepEqual(a, b, 'same seed, same draw — including order')
    assert.equal(a.length, SUGGESTION_DRAW_SIZE, 'the draw fills the grid')

    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
      drawSuggestions(seed)
        .map((e) => e.id)
        .join(','),
    )
    assert.ok(new Set(seeds).size > 1, 'different seeds draw differently — Shuffle has to do something')
  }

  // 2. No repeats inside one draw.
  {
    for (const seed of [0, 7, 42, 99, 2026]) {
      const ids = drawSuggestions(seed).map((entry) => entry.id)
      assert.equal(new Set(ids).size, ids.length, `seed ${seed} drew a duplicate card`)
    }
  }

  // 3. Category spread: with more categories than slots, every card in a draw
  //    comes from a different category.
  {
    const categories = new Set(SUGGESTION_BANK.map((entry) => entry.category))
    assert.ok(categories.size >= SUGGESTION_DRAW_SIZE, 'the bank has enough categories to spread across')
    for (const seed of [0, 5, 17, 123, 999, 31337]) {
      const drawn = drawSuggestions(seed).map((entry) => entry.category)
      assert.equal(new Set(drawn).size, drawn.length, `seed ${seed} drew two cards from one category`)
    }
  }

  // 4. A bank smaller than the draw still fills what it can, and a thin one tops
  //    up from other categories rather than rendering a short grid.
  {
    const tiny: SuggestionEntry[] = SUGGESTION_BANK.slice(0, 2)
    assert.equal(drawSuggestions(3, 4, tiny).length, 2, 'cannot draw more cards than the bank holds')

    const twoCategories = SUGGESTION_BANK.filter((entry) => entry.category === 'review' || entry.category === 'tests')
    assert.equal(twoCategories.length, 4, 'fixture assumption: two categories, two entries each')
    assert.equal(
      drawSuggestions(11, 4, twoCategories).length,
      4,
      'with fewer categories than slots the draw tops up instead of leaving a hole',
    )
    assert.equal(drawSuggestions(0, 0).length, 0, 'a zero draw is empty, not a crash')
  }

  // 5. Every entry is usable as a launch: a real prompt, not the title again.
  {
    const ids = new Set<string>()
    for (const entry of SUGGESTION_BANK) {
      assert.ok(!ids.has(entry.id), `duplicate suggestion id: ${entry.id}`)
      ids.add(entry.id)
      assert.ok(entry.title.length > 0 && entry.title.length <= 48, `${entry.id}: the title is a button label`)
      assert.ok(entry.description.length > 0, `${entry.id}: needs a description`)
      assert.ok(entry.outcome.length > 0, `${entry.id}: needs to say what it leaves behind`)
      // The prompt is what an agent receives with no other brief — a one-liner
      // that restates the title would produce a different run every time.
      assert.ok(entry.prompt.length > 200, `${entry.id}: the prompt must be the real instruction`)
      assert.notEqual(entry.prompt.trim(), entry.title, `${entry.id}: the prompt is not the title`)
      assert.ok(entry.prompt.includes('\n'), `${entry.id}: the prompt carries scope, not just an ask`)
    }
  }

  // 6. A survey card must not quietly start changing the code — the boundary is
  //    in the prompt, and it is the difference between what the user pressed and
  //    an unrequested refactor.
  {
    for (const entry of SUGGESTION_BANK) {
      if (entry.outcome !== 'Files backlog items') continue
      assert.ok(
        entry.prompt.includes('Do not fix anything you find'),
        `${entry.id}: a card that files findings must say it is not fixing them`,
      )
      assert.ok(entry.prompt.includes('Backlog'), `${entry.id}: must say where findings go`)
    }
  }

  console.log('suggestionBank.test.ts: ok')
})
