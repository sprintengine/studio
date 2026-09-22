// Put the release channel's app icon in place before packaging.
//
// A nightly wears its own icon — the same mark on a night sky — so it can be
// told apart from a stable install in the Dock, the taskbar and the tray.
// electron-builder reads `resources/icon.{icns,ico,png}` (package.json `build`,
// per platform) and the tray reads the `icon.png` that extraResources copies,
// so the cheapest wiring that reaches all of them is to copy the channel's set
// over those three files in the release checkout, which is thrown away after
// the run. Nothing else in the build config has to know a nightly exists.
//
// Every other channel is left alone: stable ships the files as committed.
// Both sets come from scripts/generate-icons.js.
//
//   node scripts/release/use-channel-icons.mjs <channel>

import { copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ICON_EXTENSIONS = ['icns', 'ico', 'png']

// The set a channel packages with, or null for "as committed". The workflow's
// CHANNEL is the updater's manifest name, so stable arrives as `latest`.
export function iconSetForChannel(channel) {
  return channel === 'nightly' ? 'icon-nightly' : null
}

// Copies the channel's set over resources/icon.*. Returns the files it wrote,
// empty when the channel packages the committed icon. A missing source is an
// error rather than a skip: packaging a nightly with the stable icon would
// ship green and look exactly like the thing it is meant to differ from.
export function useChannelIcons(channel, resourcesDir) {
  const set = iconSetForChannel(channel)
  if (!set) return []
  const written = []
  for (const extension of ICON_EXTENSIONS) {
    const source = join(resourcesDir, `${set}.${extension}`)
    if (!existsSync(source)) {
      throw new Error(`The ${channel} icon set is missing ${set}.${extension}; run node scripts/generate-icons.js.`)
    }
    const target = join(resourcesDir, `icon.${extension}`)
    copyFileSync(source, target)
    written.push(target)
  }
  return written
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const channel = process.argv[2]
  if (!channel) {
    process.stderr.write('usage: node scripts/release/use-channel-icons.mjs <channel>\n')
    process.exit(2)
  }
  const resourcesDir = fileURLToPath(new URL('../../resources/', import.meta.url))
  const written = useChannelIcons(channel, resourcesDir)
  process.stdout.write(
    written.length
      ? `Packaging with the ${channel} icon set (${iconSetForChannel(channel)}.*).\n`
      : `Packaging with the committed icon set for ${channel}.\n`,
  )
}
