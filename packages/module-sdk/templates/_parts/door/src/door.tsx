import type { RendererHost } from '@sprintengine/module-sdk'
import { EmptyState } from '@sprintengine/module-sdk/ui'
import { GlobalSurfaceShell, useSurfaceBackNav } from '@sprintengine/module-sdk/surface'

function DoorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

function Door() {
  const { onBack, canGoBack } = useSurfaceBackNav()
  return (
    <GlobalSurfaceShell
      ariaLabel="{{displayName}}"
      bar={{ title: '{{displayName}}' }}
      onBack={onBack}
      canGoBack={canGoBack}
    >
      <EmptyState title="Nothing here yet" body="This is {{displayName}}’s door. Draw what IDEA.md describes." />
    </GlobalSurfaceShell>
  )
}

// A door: a full-page surface the shell mounts over the workspace area. With a
// `label` and an `Icon` the shell gives it a row in the Extensions drawer and
// a tile on the Extensions home. Its id must be unique across every installed
// module, so it starts with the module id.
export function registerDoor(host: RendererHost): void {
  host.registerGlobalSurface({
    id: '{{id}}-door',
    label: '{{displayName}}',
    Icon: DoorIcon,
    railPlacement: 'inline',
    Component: Door,
  })
}
