// "Build your own extension" as a palette row, among the Extensions group's
// rows: typing "extension", "module" or "sdk" finds the way to make one next to
// the ones there are. Choosing it opens the New chat door in extension mode.

import { commandMatchesQuery } from '../commandPaletteSearch'
import type { PaletteCommand, PaletteResultProvider } from '../palette/paletteProvider'
import { openBuildExtension } from './buildExtensionHost'

export const BUILD_EXTENSION_PALETTE_ROW_ID = 'build-own-extension'

export function createBuildExtensionPaletteProvider(): PaletteResultProvider {
  return {
    id: 'build-extension',
    group: 'extensions',
    load: (query, context) => {
      const command: PaletteCommand = {
        id: BUILD_EXTENSION_PALETTE_ROW_ID,
        label: 'Build your own extension',
        description: 'Describe it, and an agent builds it with you in a chat.',
        keywords: 'new extension, create extension, make an extension, write a module, plugin, sdk, template, scaffold',
        group: 'extensions',
        run: () => {
          context.close()
          openBuildExtension()
        },
      }
      return commandMatchesQuery(command, query) ? [command] : []
    },
  }
}
