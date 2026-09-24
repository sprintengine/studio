import { app, ipcMain, protocol } from 'electron'
import { MODULE_ASSET_SCHEME } from '../shared/modules/assets'
import { claimAppInstance, configureDevUserData } from './app-instance'
import { attachStartupTimeline } from './startup-timeline'

// The entry, kept deliberately small. Everything it imports is evaluated before
// its first line runs, so the only things here are what must happen before the
// single-instance lock and the lock itself; the app proper (services, modules,
// IPC, lifecycle) lives in `app-main.ts` and is loaded only by the process that
// holds the lock. A second launch — a person reopening the app, a deep link, a
// hook or bridge script that reached the binary without ELECTRON_RUN_AS_NODE —
// used to build the whole service graph (and copy the plugin home, and write
// into every known workspace) before discovering it was not wanted. Now it
// exits here, and the first instance hears it through `second-instance`
// (registered in app-lifecycle.ts), which still sorts script launches from
// people.

// Boot measurement, off unless SPRINTENGINE_STARTUP_TIMELINE=1 or the
// diagnostics flag is set. Attached before anything else registers so the
// renderer's marks have somewhere to land the moment it starts sending them.
attachStartupTimeline(ipcMain)

// Before the lock: Electron keys it on the userData directory, so a dev build
// pinned to its own profile must have moved there first.
configureDevUserData(app)

if (!claimAppInstance(app)) {
  // `exit`, not `quit`: nothing has been built, so there is nothing for the
  // quit path to shut down, and no window may flash up on the way out.
  app.exit(0)
} else {
  // Must be registered before the app is ready.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MODULE_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
  // A dynamic import, so the bundler emits the app as its own chunk and a
  // second launch never evaluates it. It still runs before `ready`: the chunk
  // is required in the microtask that follows this script, ahead of any event.
  import('./app-main').catch((error: unknown) => {
    // Thrown back out of the promise so a broken build fails the way an entry
    // that throws does — Electron's uncaught-exception dialog and a nonzero
    // exit — rather than as an unhandled rejection nobody sees.
    process.nextTick(() => {
      throw error
    })
  })
}
