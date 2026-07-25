// The canonical refresh glyph: two arced arrows, one clockwise above and one
// counter-clockwise below. Lifted out of GitPanel so every panel that offers a
// manual re-read of its source (Git status, the Backlog scan) shows the SAME
// mark rather than a lookalike. Sized `icon-sm` to sit correctly inside an
// IconButton; pair it with a Tooltip and a real aria-label on the button.
export function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M13.25 7.25A5.25 5.25 0 0 0 4.05 4.1L2.75 5.5m0 0H6m-3.25 0V2.25M2.75 8.75a5.25 5.25 0 0 0 9.2 3.15l1.3-1.4m0 0H10m3.25 0v3.25"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
