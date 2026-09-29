import type { RegisterRenderer } from '@sprintengine/module-sdk'

import { createSurface } from './Surface'

function SurfaceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

// A door: a full-page surface the shell mounts over the workspace area. With a
// `label` and an `Icon` the shell gives it a row in the Extensions drawer and a
// tile on the Extensions home — that row is how people open it. The id must be
// unique across every installed module; the module id is.
export const registerRenderer: RegisterRenderer = (host) => {
  host.registerGlobalSurface({
    id: '{{id}}',
    label: '{{displayName}}',
    Icon: SurfaceIcon,
    railPlacement: 'inline',
    Component: createSurface(host),
  })
}
