import { discoverSprintEngineRunStatePaths } from './sprintengine-run-index'

// Sprint Engine run discovery for the in-tree engine module. The phone was its
// original consumer — hence the file's name — and its snapshot's "recently
// finished" keep-window lived here too; both left with the phone's sprint
// surface (MC-2575). The remaining caller is `sprint-engine-module.ts`, and the
// whole file goes when the engine does.
//
// It is a consumer of the shared run-index scan (D1): same dedupe-by-statePath
// and newest-first sort, one implementation. The empty-roots → cwd fallback is a
// quirk kept here so the module's behavior is unchanged; the shared scan itself
// takes exactly the roots given.
export async function discoverMobileSprintEngineStatePaths(workspaceRoots: string[]): Promise<string[]> {
  const roots = workspaceRoots.length > 0 ? workspaceRoots : [process.cwd()]
  const discovered = await discoverSprintEngineRunStatePaths(roots)
  return discovered.map((item) => item.statePath)
}
