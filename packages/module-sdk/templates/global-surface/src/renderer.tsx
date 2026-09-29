import type { RegisterRenderer, RendererHost, SidebarNavEntryRenderProps } from '@sprintengine/module-sdk'
import { RowButton } from '@sprintengine/module-sdk/ui'

import { createSurface } from './Surface'

function SurfaceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

// A row in the sidebar's top nav that opens the door. `openGlobalSurface` opens
// only a surface this module registered, and answers false while the module is
// off. Collapsed, the sidebar is an icon rail, so the row is the glyph alone and
// its name moves to the label. `icon-sm` is one of the host's own classes; a
// utility class would not be, because the host does not compile Tailwind for a
// module's markup.
function createNavEntry(host: RendererHost) {
  return function NavEntry({ collapsed }: SidebarNavEntryRenderProps) {
    return (
      <RowButton
        density="nav"
        aria-label={collapsed ? '{{displayName}}' : undefined}
        title={collapsed ? '{{displayName}}' : undefined}
        onClick={() => host.openGlobalSurface('{{id}}')}
      >
        <SurfaceIcon className="icon-sm" />
        {collapsed ? null : <span style={{ minWidth: 0 }}>{'{{displayName}}'}</span>}
      </RowButton>
    )
  }
}

// A door: a full-page surface the shell mounts over the workspace area. With a
// `label` and an `Icon` the shell gives it a row in the Extensions drawer and a
// tile on the Extensions home. The id must be unique across every installed
// module; the module id is. The sidebar nav entry is a second way in, for a
// door people open often; drop it if the drawer row is enough.
export const registerRenderer: RegisterRenderer = (host) => {
  host.registerGlobalSurface({
    id: '{{id}}',
    label: '{{displayName}}',
    Icon: SurfaceIcon,
    railPlacement: 'inline',
    Component: createSurface(host),
  })
  host.registerSidebarNavEntry({ id: '{{id}}-nav', order: 100, Component: createNavEntry(host) })
}
