import { app } from 'electron'

import { createCheckpointIndex, type CheckpointIndex } from './checkpoint-index'
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
let sharedIndex: CheckpointIndex | null = null
let sharedReactor: CheckpointReactor | null = null

/**
 * The index is shared with the read side (`workspace-change-summary`), which
 * needs the same timeline the reactor writes. One instance, so a capture and
 * the row that renders it can never disagree about which turns exist.
 */
export function getCheckpointIndex(): CheckpointIndex {
  return (sharedIndex ??= createCheckpointIndex({
    resolveUserDataDir: () => app.getPath('userData'),
  }))
}

export function getCheckpointReactor(): CheckpointReactor {
  return (sharedReactor ??= createCheckpointReactor({
    index: getCheckpointIndex(),
    captureCheckpoint,
    deleteCheckpointRefs,
    now: () => Date.now(),
  }))
}
