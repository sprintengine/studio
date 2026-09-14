// The marks of the external editors the open-in-editor control can hand a
// folder to, each in the colour its vendor publishes. Brand SVG assets, like
// the CLI badges in CliIcon.tsx and the product mark beside them in this
// folder: the hex here is the vendor's identity, not our chrome, and the
// token guard exempts the file on that basis (lint-design-tokens.mjs,
// PATH_EXEMPTIONS, category (c)).
//
// Ruled 2026-09-06 (principles.md → "Identity colour"): a mark that names
// another product wears that product's colour, because a monochrome vendor
// mark is a drawing of a logo rather than the logo — every
// other app shows the real one, and the neutral version read as a placeholder.
// The file manager's folder is ours and stays in `currentColor`; the vendor
// marks ignore the surrounding ink on purpose.
//
// Both are single glyphs sized by the icon ramp: the caller passes the size
// utility (`size-icon-sm` in the menu rows and on the split button).

import React from 'react'

// vscode target: the vendor's single-path mark in its blue.
export function VsCodeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="#0078D4">
      <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  )
}

// intellij target: the vendor's square, in its three-stop brand sweep, carrying
// the white "IJ" and the white bar. The gradient id is scoped per mount so two
// marks on one page (the split button and its open menu) do not share a def.
export function IntelliJMark({ className }: { className?: string }) {
  const gradientId = React.useId()
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
      <defs>
        <linearGradient id={gradientId} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FE2857" />
          <stop offset="0.5" stopColor="#FC801D" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="3" fill={`url(#${gradientId})`} />
      <path
        d="M3.723 3.111h5v1.834h-1.39v6.277h1.39v1.834h-5v-1.834h1.444V4.945H3.723zm11.055 0H17v6.5c0 .612-.055 1.111-.222 1.556-.167.444-.39.777-.723 1.11-.277.279-.666.557-1.11.668a3.933 3.933 0 0 1-1.445.278c-.778 0-1.444-.167-1.944-.445a4.81 4.81 0 0 1-1.279-1.056l1.39-1.555c.277.334.555.555.833.722.277.167.611.278.945.278.389 0 .721-.111 1-.389.221-.278.333-.667.333-1.278zM2.222 19.5h9V21h-9z"
        fill="#FFFFFF"
      />
    </svg>
  )
}
