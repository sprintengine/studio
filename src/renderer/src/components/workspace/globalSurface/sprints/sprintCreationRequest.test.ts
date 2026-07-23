import assert from 'node:assert/strict'

import {
  consumeSprintCreatedFromDoor,
  noteSprintCreatedFromDoor,
} from './sprintCreationRequest'

// The return leg of "New sprint" (item 1765): a run created at the door comes
// back to the door selected. The shell notes the run before reopening Sprints;
// the surface reads it once as its initial selection.

// Nothing noted: creation came from somewhere else (a project, a backlog item),
// and the door keeps whatever the operator was last reading.
assert.equal(consumeSprintCreatedFromDoor(), null, 'no claim without a creation from the door')

noteSprintCreatedFromDoor('/work/multicode/.multi-code/sprintengine/july-hardening/run.yaml')
assert.equal(
  consumeSprintCreatedFromDoor(),
  '/work/multicode/.multi-code/sprintengine/july-hardening/run.yaml',
  'the run just created at the door is handed to the surface',
)
assert.equal(
  consumeSprintCreatedFromDoor(),
  null,
  'and only once — reopening the door later restores the last selection instead',
)

// A second creation replaces the first: only the newest run is worth opening on.
noteSprintCreatedFromDoor('/work/a/run.yaml')
noteSprintCreatedFromDoor('/work/b/run.yaml')
assert.equal(consumeSprintCreatedFromDoor(), '/work/b/run.yaml', 'the newest creation wins')

console.log('sprintCreationRequest tests passed')
