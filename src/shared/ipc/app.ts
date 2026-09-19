// Part of the IPC contract: workspace backup, colour scheme and menu accelerators.
// ../electron-api.ts re-exports everything here.

export type WorkspaceBackupWriteResult = { ok: boolean; message?: string }

export type ModuleEnablementOverrides = Record<string, boolean>
export type ModuleEnablementWriteResult = { ok: boolean; message?: string }

// Light/dark surface preference of the active app theme. The renderer resolves
// its chosen theme to one of these and pushes it to main so spawned agent CLIs
// can be launched matching the app's appearance (e.g. Claude Code's --settings
// theme). Main keeps only the latest pushed value; the renderer owns the truth.
export type ColorScheme = 'light' | 'dark'

// Window chrome material: 'glass' renders the window canvas (sidebar, title
// strip, aside column) over OS-native vibrancy; 'solid' is the opaque default.
// macOS-only for now — main ignores 'glass' on other platforms.
export type WindowMaterial = 'solid' | 'glass'
export type AppMenuAcceleratorUpdate = {
  commandId: string
  accelerator: string | null
}
export type AppMenuAcceleratorUpdateResult = { ok: true }

export type BacklogItemStatusPayload = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
export type BacklogTypePayload = 'epic' | 'feature' | 'bug' | 'mockup' | 'spike'
