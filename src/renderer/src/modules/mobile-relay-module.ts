import type { RendererModule } from './renderer-host'

// Mobile relay renderer module. It has no workspace panel — its only renderer
// surface is the Mobile settings tab — so it registers nothing with the host.
// The manifest exists so the module appears in Settings → Modules and so
// `selectModuleEnabled(overrides, 'mobile-relay')` resolves; the Mobile settings
// tab is hidden when this is disabled. Its id matches the main-side
// `mobile-relay` module so the single override gates both processes: disabling
// it skips the main bridge construction + IPC on next launch and hides the tab
// immediately.
export const mobileRelayRendererModule: RendererModule = {
  manifest: {
    id: 'mobile-relay',
    displayName: 'Mobile Relay',
    version: 1,
    publisher: 'multicode',
    category: 'connectivity',
    summary: 'Pair a phone with the desktop app over an encrypted relay to drive agents remotely.',
    defaultEnabled: true,
  },
}
