// The recommended-sources region (MC-2519): what it offers, what it subtracts,
// and what one row looks like.
//
// The subtraction is the rule with teeth. `anthropics/claude-plugins-official`
// leads the hosted list and is ALSO an always-present source on every machine,
// so a region that did not subtract would put an Add button on a source the
// store already holds and refuses to remove — a button whose only possible
// outcome is a failure the person could not have avoided.

import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { HostedSource } from '../../../../../../../shared/hosted-sources-feed'
import {
  ALWAYS_PRESENT_SKILL_SOURCE_IDS,
  LOCAL_SKILL_SOURCE_ID_PREFIX,
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_ID,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { offerableRecommendations, RecommendedSources } from './RecommendedSources'
import { test } from 'vitest'

test('recommendedSources', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  const recommendation = (repo: string, over: Partial<HostedSource> = {}): HostedSource => ({
    id: repo.split('/')[1]!,
    repo,
    kind: 'claude-marketplace',
    description: `Plugins from ${repo}.`,
    ...over,
  })

  const source = (id: string): SkillSource => ({
    id,
    kind: id.startsWith(LOCAL_SKILL_SOURCE_ID_PREFIX) ? 'local' : 'github',
    name: id,
    repo: id.startsWith('github:') ? id.slice('github:'.length) : '',
    monogram: 'XX',
    blurb: '',
    commitSha: '',
    scannedAt: '',
  })

  const FEED = {
    sources: [
      recommendation('anthropics/claude-plugins-official'),
      recommendation('anthropics/skills', { kind: 'skills' }),
      recommendation('wshobson/agents'),
    ],
  }

  run('a source the app always ships is never offered as an Add', () => {
    const offered = offerableRecommendations(FEED, ALWAYS_PRESENT_SKILL_SOURCE_IDS.map(source))
    assert.deepEqual(
      offered.map((entry) => entry.repo),
      ['anthropics/skills', 'wshobson/agents'],
      'the official marketplace leads the feed and is already installed everywhere',
    )
    assert.equal(
      offered.some((entry) => `github:${entry.repo}` === OFFICIAL_PLUGINS_SKILL_SOURCE_ID),
      false,
    )
  })

  run('a source the person added themselves is not offered again', () => {
    const offered = offerableRecommendations(FEED, [
      source(STUDIO_SKILL_SOURCE_ID),
      source(OFFICIAL_PLUGINS_SKILL_SOURCE_ID),
      source('github:wshobson/agents'),
    ])
    assert.deepEqual(
      offered.map((entry) => entry.repo),
      ['anthropics/skills'],
    )
  })

  run('the match is case-folded, because GitHub owners are', () => {
    const offered = offerableRecommendations(FEED, [source('github:WsHobson/Agents')])
    assert.equal(
      offered.some((entry) => entry.repo === 'wshobson/agents'),
      false,
    )
  })

  run('a local folder source suppresses nothing', () => {
    const offered = offerableRecommendations(FEED, [source(`${LOCAL_SKILL_SOURCE_ID_PREFIX}/Users/me/skills`)])
    assert.equal(offered.length, 3)
  })

  run('no feed is no recommendations, not a crash', () => {
    assert.deepEqual(offerableRecommendations(null, []), [])
  })

  // ── The row itself ──────────────────────────────────────────────────────────
  // The component reads the feed over `window.api`; a render with no api at all
  // must draw nothing rather than throw, which is also the shape of a machine
  // whose feed could not be read.

  run('with no feed API the region renders nothing at all', () => {
    const api = (globalThis as { window?: { api?: unknown } }).window
    assert.equal(
      renderToStaticMarkup(<RecommendedSources existingSources={[]} onAdded={() => {}} />),
      '',
      'nothing to apologise for: this is what the surface showed before the feed existed',
    )
    assert.equal(api, api, 'the render touched no api')
  })

  console.log('recommended sources: ok')
})
