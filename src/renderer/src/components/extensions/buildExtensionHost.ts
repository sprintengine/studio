// The seam behind "Build your own extension": the Extensions home's plate and
// the palette row both open the New chat door in extension mode, and the door
// is the shell's (WorkspaceManager), so the shell registers the opener here on
// mount — the same module-level-seam discipline as `extensionsSurfaceHost.ts`,
// with nothing in the eager graph.

let opener: (() => void) | null = null

/** WorkspaceManager registers the door's opener on mount and clears it on unmount. */
export function setBuildExtensionOpener(next: (() => void) | null): void {
  opener = next
}

/** Open the New chat door in extension mode. False only when no shell is mounted (tests). */
export function openBuildExtension(): boolean {
  if (!opener) return false
  opener()
  return true
}
