// Where a project's Canvas boards live: the app's data folder, never the
// project's working tree.
//
// A board used to be a file in the repository, so every sketch an agent drew
// showed up in the person's status and was one careless commit away from being
// shared. The app's other per-project state that must not be committed moved
// out the same way (docs/agent-launch-isolation.md): nothing of the app's lives
// in the checkout unless the person puts it there, and for a board that is the
// Canvas tab's Export action.
//
// Keyed by the project folder, through the same one-way hash the app already
// uses as a stable, path-free project key (`deriveWorkspaceId`), so the boards
// follow the folder rather than a registry entry: removing a workspace and
// adding the same folder back finds its boards again, and two workspaces over
// one folder share them. `<userData>/canvas/ws_<hash>/<name>.excalidraw`.
//
// Only main ever resolves this. An agent names a board by its bare name through
// the canvas tools, which run here, so an agent in another filesystem view (a
// WSL shell on a Windows host) never needs to translate this path.

import { join } from 'node:path'

import { deriveWorkspaceId } from '../mobile/control/workspace-id'

/** The folder under the app's data folder that holds every project's boards. */
export const CANVAS_BOARD_STORE_DIR = 'canvas'

export function canvasBoardStoreDir(userDataDir: string, workspaceRoot: string): string {
  return join(userDataDir, CANVAS_BOARD_STORE_DIR, deriveWorkspaceId(workspaceRoot))
}
