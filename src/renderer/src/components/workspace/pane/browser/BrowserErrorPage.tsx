import React from 'react'

import type { BrowserLoadError } from '../../../../../../shared/browser'
import { OutlineButton } from '../../../ui'
import { describeBrowserError } from './browserErrors'

// Our own page for a failed load, on the pane's ground, not Chromium's: the
// empty-state anatomy with a warning glyph, one heading, one line, the raw
// error name in mono, and Reload. Nothing else — no certificate override, no
// explainer.

function WarningGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-icon-lg text-[color:var(--tone-warn)]" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7.5v5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="0.9" fill="currentColor" />
    </svg>
  )
}

export function BrowserErrorPage({ error, onReload }: { error: BrowserLoadError; onReload: () => void }) {
  const copy = describeBrowserError(error)
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-2 bg-[color:var(--bg-app)] px-6 text-center"
    >
      <WarningGlyph />
      <p className="text-heading font-semibold text-[color:var(--text-strong)]">{copy.heading}</p>
      <p className="text-body text-[color:var(--text-muted)]">{copy.line}</p>
      <p className="font-mono text-micro tracking-wide text-[color:var(--text-subtle)]">{copy.code}</p>
      <div className="mt-2">
        <OutlineButton onClick={onReload}>Reload</OutlineButton>
      </div>
    </div>
  )
}
