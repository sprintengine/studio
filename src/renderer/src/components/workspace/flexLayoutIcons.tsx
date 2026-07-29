// FlexLayout's tabset controls, re-supplied so their glyphs are `aria-hidden`.
//
// The library renders each tabset control as a button carrying a native tooltip
// wrapped around a bare svg. The tooltip names the control, but the svg inside
// carries no name and no aria-hidden, so a screen reader reaches an unnamed
// graphic inside an already-named control (design-system-conformance-ui.md F7).
// `icons` is the seam FlexLayout gives for replacing those glyph nodes, so this
// is the wrapper: same viewBox, same path data, same 1em box — the only change
// is the aria-hidden attribute.
//
// The path data is FlexLayout's own (flexlayout-react/dist, CloseIcon /
// MaximizeIcon / RestoreIcon / OverflowIcon / AsterickIcon). It is copied rather
// than redrawn so the tab strip keeps the glyph shapes the layout was tuned
// against; `--color-icon` is FlexLayout's own icon variable, which
// index.css already maps into the theme.

import type { IIcons } from 'flexlayout-react'

const GLYPH: React.CSSProperties = {
  width: '1em',
  height: '1em',
  display: 'flex',
  alignItems: 'center',
}

function CloseGlyph(): JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={GLYPH} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        stroke="var(--color-icon)"
        fill="var(--color-icon)"
        d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
      />
    </svg>
  )
}

function MaximizeGlyph(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={GLYPH}
      viewBox="0 0 24 24"
      fill="var(--color-icon)"
      aria-hidden="true"
      focusable="false"
    >
      <path stroke="var(--color-icon)" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
    </svg>
  )
}

function RestoreGlyph(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={GLYPH}
      viewBox="0 0 24 24"
      fill="var(--color-icon)"
      aria-hidden="true"
      focusable="false"
    >
      <path stroke="var(--color-icon)" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
    </svg>
  )
}

function OverflowGlyph(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={GLYPH}
      viewBox="0 0 24 24"
      fill="var(--color-icon)"
      aria-hidden="true"
      focusable="false"
    >
      <path stroke="var(--color-icon)" d="M7 10l5 5 5-5z" />
    </svg>
  )
}

function ActiveTabsetGlyph(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={GLYPH}
      viewBox="0 -960 960 960"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="var(--color-icon)"
        stroke="var(--color-icon)"
        d="M440-120v-264L254-197l-57-57 187-186H120v-80h264L197-706l57-57 186 187v-264h80v264l186-187 57 57-187 186h264v80H576l187 186-57 57-186-187v264h-80Z"
      />
    </svg>
  )
}

function PopoutGlyph(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={GLYPH}
      viewBox="0 0 20 20"
      fill="var(--color-icon)"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
      <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
    </svg>
  )
}

// Every glyph FlexLayout renders inside a *button*. `edgeArrow` is deliberately
// absent: it is a drag-target overlay, not a control, so it never reaches the
// a11y tree as an unnamed graphic inside something focusable.
export const FLEX_LAYOUT_ICONS: IIcons = {
  close: <CloseGlyph />,
  closeTabset: <CloseGlyph />,
  maximize: <MaximizeGlyph />,
  restore: <RestoreGlyph />,
  more: <OverflowGlyph />,
  popout: <PopoutGlyph />,
  activeTabset: <ActiveTabsetGlyph />,
}
