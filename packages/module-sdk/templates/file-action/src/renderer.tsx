import type { FileActionContext, RegisterRenderer } from '@sprintengine/module-sdk'

/** The entry's path relative to the project root, with forward slashes. */
function relativePath(context: FileActionContext, path: string): string {
  const root = context.workspaceRoot.replace(/[\\/]+$/, '')
  const inside = path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path.slice(root.length + 1) : path
  return inside.split('\\').join('/')
}

// An action in the Files tree's right-click menu, under this module's name.
// It sees the whole selection, so one action can act on many files; its label
// can say how many. Actions of a disabled module are absent, not greyed out.
export const registerRenderer: RegisterRenderer = (host) => {
  host.registerFileAction({
    id: 'copy-relative-paths',
    label: 'Copy relative path',
    getLabel: (context) =>
      context.entries.length > 1 ? `Copy ${context.entries.length} relative paths` : 'Copy relative path',
    isVisible: (context) => context.entries.length > 0,
    async run(context) {
      const paths = context.entries.map((entry) => relativePath(context, entry.path))
      await navigator.clipboard.writeText(paths.join('\n'))
    },
  })
}
