import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

import { defaultUserModuleRoot } from './modules/user-module-registry'
import { defaultUserPluginRoot } from './plugin-registry'

// Drop-in extension folders. On a packaged install nothing tells a user where
// capability modules and CLI plugins are picked up from, and the folders only
// exist once something has been installed. This ensures both roots exist on
// startup and seeds each with a README so a user (or an SDK author shipping a
// folder) can discover the contract without reading source. Best-effort: a
// failure here must never block app startup.

const EXTENSION_README_FILENAME = 'README.md'

export const MODULE_FOLDER_README = `# SprintEngine capability modules

Drop a capability module here to have SprintEngine pick it up on next launch.

## Layout

\`\`\`
~/.sprintengine/modules/
  <module-id>/
    manifest.json   # required — id must equal this folder name
    dist/main.cjs   # optional entry.main (CommonJS, main process)
    dist/renderer.mjs # optional entry.renderer (ESM bundle, renderer)
\`\`\`

## Getting started

Author modules against the published SDK:

\`\`\`
npm install --save-dev @sprintengine/module-sdk
\`\`\`

A \`manifest.json\` describes the module; \`entry.main\` / \`entry.renderer\`
register IPC, services, panels, workspace types, commands and settings through
the host APIs (\`MainHost\` / \`RendererHost\`). Validate, pack and sign with the
bundled CLI:

\`\`\`
npx sprintengine-module pack ./my-module
npx sprintengine-module sign ./my-module --key ./signing.pem
\`\`\`

Installed modules are listed under **Settings → Modules**, where you review the
access each one requests and grant trust before its code runs. You can also
install a module folder from there instead of copying it here by hand.
`

export const PLUGIN_FOLDER_README = `# SprintEngine conversation providers

Drop a conversation provider here to add a model provider to SprintEngine's
chat. Providers are picked up on next launch.

## Layout

\`\`\`
~/.sprintengine/plugins/
  <provider-id>/
    plugin.json     # required — id must equal this folder name
\`\`\`

## What a provider describes

A \`plugin.json\` with \`"kind": "provider"\` names the provider, its models and
how it signs in (\`providerType\`, \`models\`, \`auth\`, and an OpenAI-compatible
endpoint or an adapter). An executable adapter must be signed by a publisher
you trust before it runs.

Only providers load from this folder. Agent CLIs ship with the app, and a
provider cannot reuse the id of anything built in; a plugin here that tries
is not loaded.
`

export type EnsureExtensionFoldersOptions = {
  moduleRoot?: string
  pluginRoot?: string
}

export type EnsureExtensionFoldersResult = {
  moduleRoot: string
  pluginRoot: string
  errors: string[]
}

/**
 * Create the user module and plugin drop-in roots if absent and seed each with
 * a README describing the contract. Idempotent: existing folders are left in
 * place and an existing README is never overwritten (a user may have edited or
 * removed it). Returns the resolved roots and any non-fatal errors.
 */
export function ensureExtensionFolders(options: EnsureExtensionFoldersOptions = {}): EnsureExtensionFoldersResult {
  const moduleRoot = options.moduleRoot ?? defaultUserModuleRoot()
  const pluginRoot = options.pluginRoot ?? defaultUserPluginRoot()
  const errors: string[] = []

  seedFolder(moduleRoot, MODULE_FOLDER_README, errors)
  seedFolder(pluginRoot, PLUGIN_FOLDER_README, errors)

  return { moduleRoot, pluginRoot, errors }
}

function seedFolder(root: string, readme: string, errors: string[]): void {
  try {
    mkdirSync(root, { recursive: true })
  } catch (err) {
    errors.push(`Could not create "${root}": ${formatError(err)}`)
    return
  }
  const readmePath = join(root, EXTENSION_README_FILENAME)
  if (existsSync(readmePath)) return
  try {
    writeFileSync(readmePath, readme, 'utf8')
  } catch (err) {
    errors.push(`Could not write "${readmePath}": ${formatError(err)}`)
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
