import { app } from 'electron'

import { createCheckpointIndex } from './checkpoint-index'
import { createCheckpointReactor, type CheckpointReactor } from './checkpoint-reactor'
import { captureCheckpoint, deleteCheckpointRefs } from './checkpoint-store'

/**
 * The one checkpoint reactor, resolved lazily
 * (the-diff-an-agent-made / checkpoint-turn-reactor).
 *
 * Same shape as the other shared main-process singletons: the reactor itself
 * takes every dependency by injection and knows nothing about Electron, so its
 * tests run without an app. This file is the only place the two are joined, and
 * the only place `app.getPath` is read.
 *
 * Lazy because `app.getPath('userData')` is not answerable until the app is
 * ready, and the module graph is loaded well before that.
 */
let shared: CheckpointReactor | null = null

export function getCheckpointReactor(): CheckpointReactor {
  return (shared ??= createCheckpointReactor({
    index: createCheckpointIndex({ resolveUserDataDir: () => app.getPath('userData') }),
    captureCheckpoint,
    deleteCheckpointRefs,
    now: () => Date.now(),
  }))
}
