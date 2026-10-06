import { useEffect } from 'react'

import { useAppTheme } from '../../hooks/useAppTheme'
import { followStoredSettings } from '../auxWindows/auxSettingsWrite'
import DiagnosticsContent from './DiagnosticsContent'

// Full-window host for the diagnostics panel, mounted when the renderer is
// loaded with `?view=diagnostics` (a dedicated BrowserWindow created by
// `diagnostics:open-window`). It is intentionally not the workspace shell: no
// sidebar, title bar, or workspace sync participation — just the live panel,
// fit for a second monitor. Workspace names / active ids still come through the
// IPC sync snapshot inside DiagnosticsContent.
export default function DiagnosticsWindowApp() {
  // Keep <html data-theme="…"> in step with the persisted preference rather than
  // relying on the boot script alone, so the panel never settles on the default
  // dark scale when a light theme is active. Like an aux window it follows the
  // workspace window's saved changes and tells main nothing of its copy.
  useAppTheme({ mirrorToMain: false })
  useEffect(() => followStoredSettings(), [])
  return (
    <div className="h-screen w-screen bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <DiagnosticsContent />
    </div>
  )
}
