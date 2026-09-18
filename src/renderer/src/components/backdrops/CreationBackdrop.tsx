// CreationBackdrop — the per-theme editorial backplate behind a creation / empty
// / first-run surface (AgentChatView empty state; the retired New workspace hub
// was the other host). It is the
// single place the fit + scrim + fade contract lives:
//
//   • fit    — `object-fit: cover` + center: always fills the panel at the
//              plate's native 16:9, cropping symmetrically. Responsive image
//              candidates select the 1600px or 4K plate for the display.
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
  const sources = backdropFor(resolved, surface)
  if (!sources) return null
  return (
    <div aria-hidden="true" className={`creation-backdrop${visible ? '' : ' creation-backdrop--hidden'}`}>
      <img
        alt=""
        className="creation-backdrop-image"
        src={sources.standard}
        srcSet={`${sources.standard} 1600w, ${sources.fourK} 3840w`}
        sizes="100vw"
      />
      <div className="creation-backdrop-scrim" />
    </div>
  )
}
