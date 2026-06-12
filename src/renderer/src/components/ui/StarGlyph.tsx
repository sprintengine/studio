// The one star path for starred/favorite marks across the app shell —
// workspace sidebar rows and menus, the workspace top bar, Backlog rows and
// the Backlog row context menu. `filled` renders the solid earned mark;
// `stroked` adds the outline treatment menu items use for their unstarred
// state. A `label` makes the glyph announceable (aria-label + <title>);
// without one it is decorative (`aria-hidden`) and the adjacent text carries
// the meaning. Sizing and color stay with the caller's className — the glyph
// owns only the geometry.
export function StarGlyph({
  filled,
  stroked = false,
  className,
  label,
}: {
  filled: boolean
  stroked?: boolean
  className?: string
  label?: string
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={stroked ? 'currentColor' : undefined}
      strokeWidth={stroked ? '1.4' : undefined}
      className={className}
      {...(label ? { 'aria-label': label } : { 'aria-hidden': true })}
    >
      {label ? <title>{label}</title> : null}
      <path
        d="M8 1.5L9.95 5.7L14.5 6.3L11.2 9.55L12 14.1L8 11.95L4 14.1L4.8 9.55L1.5 6.3L6.05 5.7L8 1.5Z"
        strokeLinejoin={stroked ? 'round' : undefined}
      />
    </svg>
  )
}
