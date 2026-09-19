import { CANVAS_MODULE_DEFAULT_ENABLED } from '../../../shared/modules/manifest'
import type { RendererModule } from './renderer-host'

// The Canvas pane tab as a renderer-only capability module. Like git and
// memory-graph, the BACKEND is foundational: main owns the `.excalidraw` file,
// the merge and the `canvas.*` tools whether or not this module is on, and the
// tools answer for themselves when it is off. What gates here is the surface —
// the tab kind in the pane's launcher and "+" menu, the panel the pane mounts,
// and the palette row that toggles it.
//
// It registers NOTHING with the host, and that is the point rather than an
// omission. A host panel is handed `{ workspaceId }` and nothing else, and the
// Canvas tab needs the tab record (which board it is on) and whether it is the
// tab someone is looking at. Widening the host contract for one consumer would
// make every module's panel carry props only the pane can supply, so the panel
// stays a local `React.lazy` in WorkspacePaneBody — the same split dev-tools
// makes for `explorer` and git for its conflict resolver — and this manifest is
// what that lazy import gates on. The editor is the heaviest dependency in the
// tree, so keeping it behind that boundary is also what keeps it out of the
// boot chunk (scripts/check-bundle-budget.mjs fails the build otherwise).
export const canvasRendererModule: RendererModule = {
  manifest: {
    id: 'canvas',
    displayName: 'Canvas',
    version: 1,
    publisher: 'sprintengine',
    category: 'insight',
    summary:
      'A whiteboard tab in the workspace pane, backed by a board file in the project. Disabling hides the tab; the board files and the canvas tools stay.',
    // Shared with main, which has no manifest of this module to resolve.
    defaultEnabled: CANVAS_MODULE_DEFAULT_ENABLED,
  },
}
