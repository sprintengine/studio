import assert from 'node:assert/strict'

import {
  LOCAL_SKILL_SOURCE_ID_PREFIX,
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_ID,
} from '../../../../../../../shared/skills'
import { sourceOffersRemove, sourceUpdateCheckLine } from './SourceTabActions'
import { test } from 'vitest'

test('SourceTabActions', async () => {
  // The head line's overflow builds its items only when a person opens it, so a
  // render assertion can never see whether "Remove source" was offered. The rule
  // lives in `sourceOffersRemove` for exactly that reason, and this is its test:
  // a source the store refuses to remove must not be offered the action, because
  // the only thing that click could produce is a failure the person could not
  // have avoided.

  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  run('the app’s own catalogue is never offered Remove', () => {
    assert.equal(
      sourceOffersRemove({ id: STUDIO_SKILL_SOURCE_ID }),
      false,
      'the app ships this source and the store refuses to remove it',
    )
  })

  run('the official marketplace is never offered Remove', () => {
    assert.equal(
      sourceOffersRemove({ id: OFFICIAL_PLUGINS_SKILL_SOURCE_ID }),
      false,
      'it syncs like any repository, but it is always present — Remove could only fail',
    )
  })

  run('a repository someone added is offered Remove', () => {
    assert.equal(sourceOffersRemove({ id: 'github:acme/skills' }), true)
  })

  run('a folder someone added is offered Remove', () => {
    assert.equal(sourceOffersRemove({ id: `${LOCAL_SKILL_SOURCE_ID_PREFIX}/Users/me/work/skills` }), true)
  })

  // What "Check for updates" says back. The cadence ruling lets the
  // check decline — without a GitHub token each source is asked once a day — and
  // a manual press that declines must say so, or the button reads as broken.

  const CHECK = {
    checkedAt: '2026-09-08T10:00:00.000Z',
    sources: [] as { sourceId: string; name: string; headSha: string; changed: boolean; checked: boolean }[],
    changed: [] as string[],
    newlyChanged: [] as string[],
    failures: [] as { sourceId: string; message: string }[],
    skipped: [] as { sourceId: string; message: string }[],
  }

  run('a source inside its cadence window says when it was last checked, and why', () => {
    assert.equal(
      sourceUpdateCheckLine(
        {
          ...CHECK,
          skipped: [
            {
              sourceId: 'github:acme/skills',
              message: 'Checked 3 hours ago; without a GitHub token the studio checks each source once a day.',
            },
          ],
        },
        'github:acme/skills',
      ),
      'Checked 3 hours ago; without a GitHub token the studio checks each source once a day.',
    )
  })

  run('a source that was checked and had moved points at Sync', () => {
    assert.match(
      sourceUpdateCheckLine(
        {
          ...CHECK,
          sources: [
            { sourceId: 'github:acme/skills', name: 'acme/skills', headSha: 'abc', changed: true, checked: true },
          ],
          changed: ['github:acme/skills'],
        },
        'github:acme/skills',
      ),
      /press Sync/,
    )
  })

  run('a source that was checked and had not moved says so', () => {
    assert.match(
      sourceUpdateCheckLine(
        {
          ...CHECK,
          sources: [
            { sourceId: 'github:acme/skills', name: 'acme/skills', headSha: 'abc', changed: false, checked: true },
          ],
        },
        'github:acme/skills',
      ),
      /up to date/,
    )
  })

  run('a source the check could not reach reports the failure, not silence', () => {
    assert.equal(
      sourceUpdateCheckLine(
        { ...CHECK, failures: [{ sourceId: 'github:acme/skills', message: 'GitHub replied with HTTP 404.' }] },
        'github:acme/skills',
      ),
      'GitHub replied with HTTP 404.',
    )
  })

  run('a local folder is not a source the studio checks', () => {
    assert.match(
      sourceUpdateCheckLine(CHECK, `${LOCAL_SKILL_SOURCE_ID_PREFIX}/Users/me/work/skills`),
      /not one the studio checks/,
    )
  })

  console.log('source tab actions: ok')
})
