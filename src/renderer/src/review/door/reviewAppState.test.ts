import assert from 'node:assert/strict'

// Review's own app-level state (MC-2090). These two values used to live in
// core's settings slice; what is pinned here is that the module still owns
// their normalization — a persisted value the module cannot use falls back
// rather than riding through — now that core stores them verbatim.

async function main(): Promise<void> {
  const { getRendererHost } = await import('../../modules')
  const {
    LAST_SELECTED_REVIEW_KEY,
    REVIEW_GUIDE_DEFAULTS_KEY,
    normalizeLastSelectedReview,
    normalizeReviewGuideDefaults,
    readReviewGuideDefaults,
    writeLastSelectedReview,
    writeReviewGuideDefaults,
  } = await import('./reviewAppState')

  // A store the module writes through, standing in for the app-settings
  // namespace the shell wires at boot.
  const values = new Map<string, unknown>()
  getRendererHost().setModuleAppStateStore({
    get: () => Object.fromEntries(values),
    set: (_moduleId, key, value) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
      return true
    },
    subscribe: () => () => undefined,
  })

  // ── Guide defaults ────────────────────────────────────────────────────────
  assert.deepEqual(
    readReviewGuideDefaults(),
    { depth: 'standard', cli: null, model: null },
    'a fresh profile prepares at standard depth with no agent picked yet',
  )
  console.log('ok - a fresh profile falls back to the standard defaults')

  writeReviewGuideDefaults({ depth: 'thorough' })
  assert.deepEqual(
    readReviewGuideDefaults(),
    { depth: 'thorough', cli: null, model: null },
    'choosing a depth leaves the agent choice alone',
  )
  writeReviewGuideDefaults({ cli: 'codex', model: 'gpt-5-codex' })
  assert.deepEqual(
    readReviewGuideDefaults(),
    { depth: 'thorough', cli: 'codex', model: 'gpt-5-codex' },
    'and choosing an agent leaves the depth alone — the two choices are independent',
  )
  writeReviewGuideDefaults({ cli: 'claude-code', model: null })
  assert.deepEqual(
    readReviewGuideDefaults(),
    { depth: 'thorough', cli: 'claude-code', model: null },
    'a new agent drops the model picked for the previous one',
  )
  console.log('ok - the two preparation choices patch independently')

  assert.equal(
    values.has(REVIEW_GUIDE_DEFAULTS_KEY),
    true,
    'the choices are stored under this module’s own key, not core’s settings',
  )

  // ── Normalization of untrusted persisted values ───────────────────────────
  assert.deepEqual(
    normalizeReviewGuideDefaults({ depth: 'thorough', cli: ' codex ', model: ' gpt-5-codex ' }),
    { depth: 'thorough', cli: 'codex', model: 'gpt-5-codex' },
    'a restart restores the last-used pair, trimmed',
  )
  assert.deepEqual(
    normalizeReviewGuideDefaults({ depth: 'exhaustive' }),
    { depth: 'standard', cli: null, model: null },
    'a depth the guide cannot render falls back to standard instead of riding to the prompt',
  )
  assert.deepEqual(
    normalizeReviewGuideDefaults({ model: 'gpt-5-codex' }),
    { depth: 'standard', cli: null, model: null },
    'a stored model with no engine to run it is dropped',
  )
  for (const junk of [undefined, null, 'nonsense', 42, []]) {
    assert.deepEqual(
      normalizeReviewGuideDefaults(junk),
      { depth: 'standard', cli: null, model: null },
      'anything that is not a defaults object hydrates to the defaults',
    )
  }
  console.log('ok - an unusable persisted value falls back rather than riding through')

  // ── Last-selected review ──────────────────────────────────────────────────
  writeLastSelectedReview({ reviewId: ' rv_b ', workspaceRoot: ' /proj/multicode ' })
  assert.deepEqual(
    values.get(LAST_SELECTED_REVIEW_KEY),
    { reviewId: 'rv_b', workspaceRoot: '/proj/multicode' },
    'the opened review is remembered with its owning project root, trimmed',
  )
  // A half-written pair cannot survive: either half missing means there is
  // nothing to restore, so the door falls back to attention-first.
  writeLastSelectedReview({ reviewId: 'rv_b', workspaceRoot: '  ' })
  assert.equal(values.get(LAST_SELECTED_REVIEW_KEY), null, 'a pair missing its project root normalizes away')
  writeLastSelectedReview(null)
  assert.equal(values.get(LAST_SELECTED_REVIEW_KEY), null, 'clearing a dead preference stores null')
  for (const junk of [undefined, 'rv_b', { reviewId: 'rv_b' }, { workspaceRoot: '/p' }]) {
    assert.equal(normalizeLastSelectedReview(junk), null, 'a partial or wrong-shaped pair is not restorable')
  }
  console.log('ok - a half-written selection never survives to auto-select')

  console.log('reviewAppState tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
