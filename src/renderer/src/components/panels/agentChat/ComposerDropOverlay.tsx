/**
 * "Drop to attach" over a composer box while a drag holding files is over it:
 * the open conversation's composer and the New chat composer show the same one.
 * Opaque, not a scrim: the field's own text ghosting through the drop state
 * reads as a rendering artifact rather than a state. It floats on the layer for
 * a tray over its pane, and takes the corner of the box it covers, so it is
 * placed as a direct child of that box.
 *
 * `ground` is the colour it is opaque in. The two composers have each kept
 * their own: the conversation's the surface, New chat's the app's ground.
 */
export function ComposerDropOverlay({ ground }: { ground: 'surface' | 'app' }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[var(--z-float)] flex items-center justify-center rounded-[inherit] ${
        ground === 'surface' ? 'bg-[color:var(--bg-surface)]' : 'bg-[color:var(--bg-app)]'
      } text-meta font-medium text-[color:var(--accent-primary)]`}
    >
      Drop to attach
    </div>
  )
}
