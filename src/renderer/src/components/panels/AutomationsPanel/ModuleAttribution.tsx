// Quiet provenance marker for module-created automations ("via weather-deck"),
// shared by the list row and the detail pane so the copy, tooltip, and tokens
// cannot drift — and so a future module-display-name lookup lands in one place.
export function ModuleAttribution({ moduleId, className }: { moduleId: string; className?: string }) {
  return (
    <span
      className={['shrink-0 text-[color:var(--text-subtle)]', className ?? ''].join(' ').trim()}
      title={`Created by the ${moduleId} module`}
    >
      via {moduleId}
    </span>
  )
}
