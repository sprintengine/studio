import { app } from 'electron'
import { join } from 'path'

// Resolves resources/design-system/templates for the running app. Packaged
// builds carry the folder as an extraResource (`design-system/templates`
// under process.resourcesPath — see package.json `build.extraResources`);
// dev builds read it straight from the repo. Kept separate from
// bundle-scaffold.ts so the scaffold service stays electron-free and testable
// under plain node.
export function resolveDesignSystemTemplatesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'design-system', 'templates')
  }
  return join(app.getAppPath(), 'resources', 'design-system', 'templates')
}
