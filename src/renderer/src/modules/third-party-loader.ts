import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'

import {
  BUNDLED_MODULE_IDS,
  type CapabilityManifest,
  type ThirdPartyRendererEntriesResult,
} from '../../../shared/modules/manifest'
import { sanitizeEntryMessage } from '../../../shared/modules/entry-messages'
import type { RendererKernel } from './renderer-host'

// Renderer-side loader for trusted third-party modules' `entry.renderer`
// bundles — the consuming half of the main-side server in
// src/main/modules/third-party-renderer-entries.ts. Trust gating already
// happened in the main process (only isLoadEligible modules with contained
// entries are ever served); this loader's jobs are evaluation, registration
// through the identical `hostFor(manifest.id)` contract bundled modules use,
// and per-module failure isolation: a broken bundle records an error surfaced
// in Settings → Modules and never takes down the renderer or its neighbors.
//
// Like bundled modules, third-party entries register their contributions
// regardless of the enablement toggle — enablement gating happens in the
// consumers (panel factory, workspace-type picker, command pipeline, settings
// rail), which is exactly what makes toggling a module off and on work without
// a reload.

export type ThirdPartyRendererLoadState =
  | { status: 'loaded' }
  | { status: 'error'; message: string }

const LOAD_FAILURE_FALLBACK = 'entry.renderer bundle failed to load.'

// Static after boot: loading runs to completion before the React root renders
// (see main.tsx), so readers never observe a half-populated map and need no
// subscription. A module trusted later in the session simply has no state here
// — Settings → Modules reads that as "loads on the next app launch".
const loadStates = new Map<string, ThirdPartyRendererLoadState>()

export function getThirdPartyRendererLoadState(
  moduleId: string
): ThirdPartyRendererLoadState | undefined {
  return loadStates.get(moduleId)
}

// ── Shared React runtime ─────────────────────────────────────────────────────
//
// The SDK contract (packages/module-sdk README) has authors bundle
// `entry.renderer` as a single-file ESM bundle with React marked external, so
// the bundle still contains bare `import … from 'react'` statements. Module
// contributions render inside the app's React tree, so they MUST resolve to
// the app's own React instance (a second copy breaks hooks/context). We bridge
// the bare specifiers with an import map whose targets are generated blob
// modules re-exporting the app's instances. Electron 41's Chromium supports
// appending import maps after module loading has started (multiple import
// maps, Chromium ≥ 133), and a map only affects modules resolved after it is
// inserted — i.e. exactly the blob-URL entry bundles imported below.

const SHARED_MODULE_SPECIFIERS: Record<string, object> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': ReactJsxRuntime,
}

const SHARED_RUNTIME_GLOBAL = '__multicodeSharedModuleRuntime'

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// A blob module can't import from the app bundle, so the shim reaches the live
// namespace through a global the loader installs, then re-exports every named
// export so `import { useState } from 'react'` works as written.
function sharedModuleShimSource(specifier: string, namespace: object): string {
  const exports = Object.keys(namespace)
    .filter((name) => name !== 'default' && IDENTIFIER_PATTERN.test(name))
    .map((name) => `export const ${name} = m[${JSON.stringify(name)}];`)
  return [
    `const m = globalThis[${JSON.stringify(SHARED_RUNTIME_GLOBAL)}][${JSON.stringify(specifier)}];`,
    ...exports,
    'export default m.default ?? m;',
  ].join('\n')
}

let sharedRuntimeInstalled = false

function installSharedRuntimeImportMap(): void {
  if (sharedRuntimeInstalled) return
  sharedRuntimeInstalled = true
  ;(globalThis as Record<string, unknown>)[SHARED_RUNTIME_GLOBAL] = SHARED_MODULE_SPECIFIERS
  const imports: Record<string, string> = {}
  for (const [specifier, namespace] of Object.entries(SHARED_MODULE_SPECIFIERS)) {
    imports[specifier] = URL.createObjectURL(
      new Blob([sharedModuleShimSource(specifier, namespace)], { type: 'text/javascript' })
    )
  }
  const script = document.createElement('script')
  script.type = 'importmap'
  script.textContent = JSON.stringify({ imports })
  document.head.appendChild(script)
}

// ── Bundle evaluation ────────────────────────────────────────────────────────

export type ThirdPartyEntryImporter = (code: string) => Promise<unknown>

// Bundle content arrives over IPC and is evaluated via dynamic import of a
// blob URL — no file:// or custom-protocol exposure of the module root.
const importEntryBundle: ThirdPartyEntryImporter = async (code) => {
  installSharedRuntimeImportMap()
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function recordError(id: string, message: string): void {
  loadStates.set(id, {
    status: 'error',
    message: sanitizeEntryMessage(message, LOAD_FAILURE_FALLBACK),
  })
}

const RESERVED_IDS: ReadonlySet<string> = new Set(BUNDLED_MODULE_IDS)

// Evaluates every served entry and registers its contributions. Returns the
// manifests of the modules that loaded *cleanly* — only those join the
// enablement-resolution universe, so a module that failed mid-registration is
// gated off everywhere instead of surfacing half its contributions.
export async function loadThirdPartyRendererEntries(
  kernel: RendererKernel,
  served: ThirdPartyRendererEntriesResult,
  importEntry: ThirdPartyEntryImporter = importEntryBundle
): Promise<CapabilityManifest[]> {
  for (const [id, message] of Object.entries(served.failures)) {
    recordError(id, message)
  }

  const loadedManifests: CapabilityManifest[] = []
  for (const entry of served.entries) {
    // Re-check the reserved-id rule at the execution boundary. Manifest
    // validation already rejects these at install/discovery; the loader is the
    // last line, so a bypass upstream still never shadows a bundled module.
    if (RESERVED_IDS.has(entry.id)) {
      recordError(entry.id, `"${entry.id}" is a reserved built-in module id and cannot be loaded.`)
      continue
    }
    if (entry.manifest.id !== entry.id) {
      recordError(entry.id, 'entry.renderer manifest id does not match the served module id.')
      continue
    }
    // Main-side discovery keys modules by folder name, so duplicate ids should
    // never arrive; defensively keep the first definition (matching the
    // resolver's duplicate_id rule) without clobbering its recorded state.
    if (loadStates.has(entry.id)) {
      console.warn(`[ThirdPartyModules] duplicate module id "${entry.id}"; ignoring the later entry.`)
      continue
    }
    try {
      const exports = await importEntry(entry.code)
      const registerRenderer = (exports as { registerRenderer?: unknown } | null)?.registerRenderer
      if (typeof registerRenderer !== 'function') {
        recordError(entry.id, 'entry.renderer must export a registerRenderer(host) function.')
        continue
      }
      registerRenderer(kernel.hostFor(entry.id))
      loadStates.set(entry.id, { status: 'loaded' })
      loadedManifests.push(entry.manifest)
    } catch (error) {
      recordError(entry.id, error instanceof Error ? error.message : String(error))
    }
  }
  return loadedManifests
}
