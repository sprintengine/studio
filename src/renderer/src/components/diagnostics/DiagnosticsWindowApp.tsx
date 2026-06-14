import DiagnosticsContent from './DiagnosticsContent'

// Full-window host for the diagnostics panel, mounted when the renderer is
// loaded with `?view=diagnostics` (a dedicated BrowserWindow created by
// `diagnostics:open-window`). It is intentionally not the workspace shell: no
// sidebar, title bar, or workspace sync participation — just the live panel,
// fit for a second monitor. Workspace names / active ids still come through the
// IPC sync snapshot inside DiagnosticsContent.
export default function DiagnosticsWindowApp() {
  return (
    <div className="h-screen w-screen bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <DiagnosticsContent />
    </div>
  )
}
