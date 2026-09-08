import { cp, mkdir, readFile } from 'fs/promises'
import { join } from 'path'

import type { PluginManifestValidationIssue, PluginManifestFamily } from '../shared/plugin-manifest'
import { validateManifestSource } from './plugin-registry'

// Install a CLI/provider plugin folder into the user plugin root, the BYO-CLI
// analogue of installModuleFolder for capability modules. Pure filesystem +
// structural validation — trust classification for executable provider adapters
// still happens at registry load time. A user plugin whose id matches a bundled
// CLI intentionally overrides the bundled one (see mergeBundledAndUser).

type InstallPluginOk = {
  ok: true
  id: string
  kind: 'cli' | 'provider'
  displayName: string
}

type InstallPluginError = {
  ok: false
  message: string
  issues?: PluginManifestValidationIssue[]
}

export type InstallPluginResult = InstallPluginOk | InstallPluginError

/**
 * Validate the plugin.json in a selected folder, then copy the whole folder
 * into the user plugin root under its declared id (overwriting an existing
 * install of the same id). The destination folder name is the manifest's
 * declared id so the registry's folder-name==id check always passes, regardless
 * of the (arbitrary) source folder name.
 */
export async function installPluginFolder(
  srcDir: string,
  root: string
): Promise<InstallPluginResult> {
  const manifestPath = join(srcDir, 'plugin.json')
  let source: string
  try {
    source = await readFile(manifestPath, 'utf8')
  } catch (error) {
    return {
      ok: false,
      message: 'No plugin.json found in the selected folder.',
      issues: [{ path: '', message: formatError(error) }],
    }
  }

  const result = validateManifestSource(source)
  if (!result.ok) {
    return { ok: false, message: 'plugin.json is invalid.', issues: result.issues }
  }

  const destination = join(root, result.manifest.id)
  await mkdir(root, { recursive: true })
  // Copy by content; force overwrites a prior install of this id.
  await cp(srcDir, destination, { recursive: true, force: true })

  return {
    ok: true,
    id: result.manifest.id,
    kind: pluginKind(result.manifest),
    displayName: result.manifest.displayName,
  }
}

function pluginKind(manifest: PluginManifestFamily): 'cli' | 'provider' {
  return manifest.kind === 'provider' ? 'provider' : 'cli'
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
