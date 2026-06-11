import { existsSync } from 'fs'
import { readFile } from 'fs/promises'

import {
  THIRD_PARTY_RENDERER_ENTRIES_CHANNEL,
  type ThirdPartyRendererEntriesResult,
  type ThirdPartyRendererEntryView,
} from '../../shared/modules/manifest'
import type { MainHost } from '../module-host/main-host'
import { resolveContainedEntry, sanitizeEntryMessage } from './entry-containment'
import { isLoadEligible } from './module-signature'
import type { InstalledModule, UserModuleListResult } from './user-module-registry'

// Serves trusted third-party modules' `entry.renderer` bundles to the renderer
// loader. Same trust gate as entry.main: only isLoadEligible (i.e. 'trusted')
// modules whose entry resolves inside the module root are servable; unsigned,
// signed-pending, and invalid modules stay blocked with their existing
// statuses. Bundle content travels over IPC (the renderer dynamic-imports it
// as a blob URL) — no file:// or custom-protocol exposure of the module root.
//
// `entry.preload` is intentionally not served here (v1 deferral; see
// ModuleEntry in src/shared/modules/manifest.ts).

const READ_FAILURE_MESSAGE = 'entry.renderer bundle could not be read.'

type RendererEntryResolution =
  | { servable: true; entryPath: string }
  | { servable: false; view: ThirdPartyRendererEntryView }

// Pure availability check used both by the launch view (Settings → Modules)
// and by the serving path below, so what the UI reports and what actually
// loads can never disagree.
function resolveRendererEntry(installed: InstalledModule): RendererEntryResolution {
  const entryRenderer = installed.manifest.entry?.renderer
  if (!entryRenderer) {
    return { servable: false, view: { availability: 'none' } }
  }
  if (!isLoadEligible(installed.trust.status)) {
    return {
      servable: false,
      view: {
        availability: 'blocked',
        message: 'Renderer entry is blocked until the module is trusted.',
      },
    }
  }
  let entryPath: string
  try {
    entryPath = resolveContainedEntry(installed.moduleRoot, entryRenderer, 'entry.renderer')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      servable: false,
      view: { availability: 'error', message: sanitizeEntryMessage(message, READ_FAILURE_MESSAGE) },
    }
  }
  if (!existsSync(entryPath)) {
    return {
      servable: false,
      view: { availability: 'error', message: 'entry.renderer bundle file is missing.' },
    }
  }
  return { servable: true, entryPath }
}

export function rendererEntryView(installed: InstalledModule): ThirdPartyRendererEntryView {
  const resolution = resolveRendererEntry(installed)
  return resolution.servable ? { availability: 'available' } : resolution.view
}

export async function collectThirdPartyRendererEntries(
  modules: readonly InstalledModule[]
): Promise<ThirdPartyRendererEntriesResult> {
  const result: ThirdPartyRendererEntriesResult = { entries: [], failures: {} }
  for (const installed of modules) {
    const resolution = resolveRendererEntry(installed)
    if (!resolution.servable) {
      // Trust-blocked and undeclared modules are reported through their launch
      // statuses; only a declared-but-broken entry is a serving failure.
      if (resolution.view.availability === 'error' && resolution.view.message) {
        result.failures[installed.manifest.id] = resolution.view.message
      }
      continue
    }
    try {
      const code = await readFile(resolution.entryPath, 'utf8')
      result.entries.push({ id: installed.manifest.id, manifest: installed.manifest, code })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failures[installed.manifest.id] = sanitizeEntryMessage(message, READ_FAILURE_MESSAGE)
    }
  }
  return result
}

// Registers the serving channel through the module-host kernel so channel
// ownership/collisions are tracked like every other module surface. Discovery
// is injected because the module root and trust store live with the caller
// (and tests provide fixtures without electron).
export function registerThirdPartyRendererEntryIpc(
  host: MainHost,
  options: { discoverModules: () => Promise<UserModuleListResult> }
): void {
  host.registerIpc(THIRD_PARTY_RENDERER_ENTRIES_CHANNEL, async (): Promise<ThirdPartyRendererEntriesResult> => {
    const { modules } = await options.discoverModules()
    return collectThirdPartyRendererEntries(modules)
  })
}
