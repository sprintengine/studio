import assert from 'node:assert/strict'

import {
  LOCAL_SKILL_SOURCE_ID_PREFIX,
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_ID,
} from '../../../../../../../shared/skills'
import { sourceOffersRemove } from './SourceTabActions'

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

console.log('source tab actions: ok')
