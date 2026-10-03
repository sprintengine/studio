import { realpathSync } from 'node:fs'
import Module from 'node:module'
import { sep } from 'node:path'

import { ElectronUnavailableError } from '../../main/modules/third-party-main-loader'

// A third-party module's main half that requires `electron` in the Studio
// server (phase 6 spec, 12.4). Inside a utility process `require('electron')`
// does not throw: it answers with `{ net, systemPreferences }`, so a module
// would fail on first use, late and silently. The server therefore answers
// such a require itself, from a module's own folder, with
// ElectronUnavailableError, which the loader reports as "skipped: needs
// electron-main" rather than as a crash. The app's own code never requires
// Electron here (the import-graph guard holds it to that), so only module code
// is ever refused.

type ModuleLoad = (request: string, parent: { filename?: string } | null | undefined, isMain: boolean) => unknown

/** Refuse `electron` and `electron/*` to code under these folders; returns the undo. */
export function installElectronRequireGuard(moduleRoots: () => readonly string[]): () => void {
  const loader = Module as unknown as { _load: ModuleLoad }
  // A module's filename is its real path (a home folder behind a symlink, a
  // temp folder on macOS), so each root is compared both as given and as resolved.
  const prefixes = (): string[] =>
    moduleRoots().flatMap((root) => {
      const forms = [root]
      try {
        forms.push(realpathSync(root))
      } catch {
        // A root that is not there has no module to guard.
      }
      return forms.map((form) => (form.endsWith(sep) ? form : `${form}${sep}`))
    })
  const original = loader._load
  const guarded: ModuleLoad = function (this: unknown, request, parent, isMain) {
    if (
      (request === 'electron' || request.startsWith('electron/')) &&
      typeof parent?.filename === 'string' &&
      prefixes().some((prefix) => parent.filename!.startsWith(prefix))
    ) {
      throw new ElectronUnavailableError(request)
    }
    return original.call(this, request, parent, isMain)
  }
  loader._load = guarded
  return () => {
    if (loader._load === guarded) loader._load = original
  }
}
