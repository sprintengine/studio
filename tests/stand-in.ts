import Module from 'node:module'
import { vi } from 'vitest'

type ModuleLoader = typeof Module & {
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown
}

// Stands `stubs` in for the named modules in every import that follows, until
// the returned function is called. The suites that use it drive main-process
// code that imports `electron` (or `node-pty`) at module scope, so the stand-in
// has to be in place before that code is first imported — the dynamic
// `await import(...)` after this call, not a static import at the top.
//
// Both ways in are covered. `vi.doMock` answers `import`; a handful of main
// modules load electron lazily with `require('electron')` so they stay
// importable in plain Node, and a native `require` never reaches Vitest's
// module graph, so Node's loader answers those from the same stubs.
//
// Each stub is exposed through live getters rather than copied, so a suite
// that reassigns a member of its fake after the import still reaches the code
// under test.
export function standIn(stubs: Record<string, object>): () => void {
  for (const [name, stub] of Object.entries(stubs)) {
    vi.doMock(name, () => {
      const namespace: Record<string, unknown> = {}
      for (const key of Object.keys(stub)) {
        Object.defineProperty(namespace, key, { enumerable: true, get: () => (stub as Record<string, unknown>)[key] })
      }
      Object.defineProperty(namespace, 'default', { enumerable: true, get: () => stub })
      return namespace
    })
  }

  const loader = Module as ModuleLoader
  const originalLoad = loader._load
  loader._load = function loadWithStandIns(request: string, parent: NodeModule | null, isMain: boolean): unknown {
    if (Object.hasOwn(stubs, request)) return stubs[request]
    return originalLoad.call(this, request, parent, isMain)
  }

  return () => {
    loader._load = originalLoad
    for (const name of Object.keys(stubs)) vi.doUnmock(name)
  }
}
