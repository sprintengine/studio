// Small SVG glyphs used by the Watchtower filter + picker + chip components.
// Pure presentational; no state, no app imports. Lives in its own file so the
// orchestration shell stays focused on data flow.

export function FilterGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path
        d="M1.5 2h8L7 6v3l-3-1.5V6L1.5 2z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CrossGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function ChevronGlyph() {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-[color:var(--text-muted)]"
    >
      <path d="M2.5 1.5L5 4 2.5 6.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function BackGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M6 2L3 5l3 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CheckboxGlyph({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border',
        checked
          ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
          : 'border-[color:var(--border-strong)] bg-transparent',
      ].join(' ')}
    >
      {checked ? (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
          <path d="M1.5 4l1.5 1.5L6.5 2" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  )
}

export function RadioGlyph({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full border',
        active ? 'border-[color:var(--accent-primary)]' : 'border-[color:var(--border-strong)]',
      ].join(' ')}
    >
      {/* design-tokens-allow: radio-button inner fill — not a status idiom, must remain inside the radio glyph */}
      {active ? <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--accent-primary)]" /> : null}
    </span>
  )
}
