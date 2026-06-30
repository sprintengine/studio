// CreationBackdrop — the per-theme editorial backplate behind a creation / empty
// / first-run surface (NewWorkspacePanel, AgentChatView empty state). It is the
// single place the fit + scrim + fade contract lives:
//
//   • fit    — `background-size: cover` + center: always fills the panel at the
//              plate's native 16:9, cropping symmetrically. The plates are
//              authored center-quiet, so a crop only ever eats edge art.
//   • scrim  — a panel-sized radial pool of the theme's own --bg-app, so the
//              foreground keeps WCAG AA contrast regardless of how the image
//              crops (contrast is decoupled from image fit).
//   • fade   — `visible=false` cross-fades the plate out (e.g. the chat plate
//              the moment the first message arrives) via opacity, no unmount.
//
// Purely decorative: aria-hidden, pointer-events-none, z-index:-10. The parent
// must establish a stacking context (`relative isolate`) so the negative z sits
// above the panel's --bg-app fill but behind all in-flow content.

import { useResolvedTheme } from '../../hooks/useAppTheme'
import { backdropFor, type BackdropSurface } from '../../assets/backdrops/backdropRegistry'

interface CreationBackdropProps {
  surface: BackdropSurface
  // Whether the plate is shown. Defaults to true; pass the empty-state predicate
  // (e.g. `timelineRows.length === 0`) to fade the plate out as content arrives.
  visible?: boolean
}

export function CreationBackdrop({ surface, visible = true }: CreationBackdropProps) {
  const resolved = useResolvedTheme()
  const src = backdropFor(resolved, surface)
  if (!src) return null
  return (
    <div
      aria-hidden="true"
      className={`creation-backdrop${visible ? '' : ' creation-backdrop--hidden'}`}
      style={{ backgroundImage: `url("${src}")` }}
    >
      <div className="creation-backdrop-scrim" />
    </div>
  )
}
