// Sub-nav tab glyphs for the Sprint Engine board panel. Extracted from
// `SprintEngineBoardPanel.tsx` so the shell stays focused on state composition.
// Kept as plain SVG components so the tab `count` chrome inherits the icon
// stroke from `currentColor` without bringing the broader icon kit along.

export function SprintEngineInboxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M2.5 8.75H5.25L6.25 10.25H9.75L10.75 8.75H13.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SprintEngineRosterNavIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="10.75" cy="7" r="1.6" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M1.75 13.25C1.75 11.5 3.25 10.5 5.5 10.5C7.75 10.5 9.25 11.5 9.25 13.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="M9.5 13.25C9.5 12 10.5 11.25 12 11.25C13.5 11.25 14.25 12 14.25 13.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function SprintEngineActivityNavIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 5.25V8L9.75 9.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SprintEngineTasksNavIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 4.25L4 5.5L6.25 3.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.75 8.5L4 9.75L6.25 7.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.75 12.75L4 14L6.25 11.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8.25" y1="4.5" x2="13.5" y2="4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="8.25" y1="8.75" x2="13.5" y2="8.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="8.25" y1="13" x2="13.5" y2="13" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
