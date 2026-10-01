import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliPermissionModeSpec } from '../src/shared/cli-permission-mode'
import type { PluginManifest } from '../src/shared/plugin-manifest'
import { declaredPermissionModes } from '../src/main/plugin-render'

// A bundled CLI's permission modes as the plugin catalog lists them to a
// window, read from the manifest the app ships, so a renderer suite tests the
// menu against the names the CLI really has rather than a copy of them.
export function bundledPermissionModes(cli: string): CliPermissionModeSpec[] {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'resources/plugins', cli, 'plugin.json'), 'utf8'),
  ) as PluginManifest
  return declaredPermissionModes(manifest)
}
