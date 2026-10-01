import type { App } from 'electron'
import { readStudioEnv } from '../shared/studio-env'

/**
 * Which profile this process runs against, and whether it may share the
 * machine with another instance. Both are settled by the entry before the
 * single-instance lock is requested, because Electron keys that lock on the
 * userData directory: a dev build pinned to its own profile has to have moved
 * there first, or it would contend for the default profile's lock.
 */

type AppIdentity = Pick<App, 'isPackaged' | 'setPath'>

/**
 * A from-source build can be pinned to its own userData directory
 * (`SPRINTENGINE_USER_DATA_DIR`), which is how several dev builds run side by
 * side. A packaged build always uses its own.
 */
export function configureDevUserData(app: AppIdentity): void {
  const userDataDir = readStudioEnv('SPRINTENGINE_USER_DATA_DIR')?.trim()
  if (!userDataDir || app.isPackaged) return
  app.setPath('userData', userDataDir)
}

/**
 * True only for a dev build that asked to run beside another instance AND was
 * given a profile of its own — two instances on one profile would write the
 * same registry and sockets.
 */
export function allowsMultipleInstances(app: Pick<App, 'isPackaged'>): boolean {
  return (
    !app.isPackaged &&
    readStudioEnv('SPRINTENGINE_ALLOW_MULTI_INSTANCE') === '1' &&
    Boolean(readStudioEnv('SPRINTENGINE_USER_DATA_DIR')?.trim())
  )
}

/**
 * Whether this launch should go on to build the app. Takes the lock unless
 * multiple instances are allowed; false means another instance holds it, and
 * Electron has already handed that instance this launch's argv (its
 * `second-instance` event), so the only thing left to do is exit.
 */
export function claimAppInstance(app: Pick<App, 'isPackaged' | 'requestSingleInstanceLock'>): boolean {
  if (allowsMultipleInstances(app)) return true
  return app.requestSingleInstanceLock()
}
