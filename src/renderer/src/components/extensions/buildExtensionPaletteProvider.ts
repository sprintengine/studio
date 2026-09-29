// "Build your own extension" as a palette row, among the Extensions group's
// rows: typing "extension", "module" or "sdk" finds the way to make one next to
// the ones there are.
//
// Choosing it opens the Extensions home with the build flow up. The home owns
// the flow, so the request is latched first and the door opened second
// (buildExtensionHost.ts) — the same order whether the home is already showing
// or not.

import { commandMatchesQuery } from '../commandPaletteSearch'
import type { PaletteCommand, PaletteResultProvider } from '../palette/paletteProvider'
import { requestBuildExtensionFlow } from './buildExtensionHost'

export const BUILD_EXTENSION_PALETTE_ROW_ID = 'build-own-extension'

export function createBuildExtensionPaletteProvider(deps: { openExtensionsHome: () => void }): PaletteResultProvider {
  return {
    id: 'build-extension',
    group: 'extensions',
    load: (query, context) => {
      const command: PaletteCommand = {
        id: BUILD_EXTENSION_PALETTE_ROW_ID,
        label: 'Build your own extension',
        description: 'Start from a template and build it with an agent in a chat.',
        keywords: 'new extension, create extension, make an extension, write a module, plugin, sdk, template, scaffold',
        group: 'extensions',
        run: () => {
          context.close()
          requestBuildExtensionFlow()
          deps.openExtensionsHome()
        },
      }
      return commandMatchesQuery(command, query) ? [command] : []
    },
  }
}
