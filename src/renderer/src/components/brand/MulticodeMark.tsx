type MulticodeMarkProps = {
  className?: string
  variant?: 'mono' | 'gradient'
  title?: string
}

export default function MulticodeMark({
  className = 'h-4 w-4',
  variant = 'gradient',
  title = 'Multicode',
}: MulticodeMarkProps) {
  if (variant === 'mono') {
    return (
      <svg
        className={className}
        viewBox="0 0 32 32"
        fill="none"
        role="img"
        aria-label={title}
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M4 3.5 L16 13.5 L16 28.5 L4 28.5 Z" fill="currentColor" />
        <path d="M28 3.5 L16 13.5 L16 28.5 L28 28.5 Z" fill="currentColor" fillOpacity="0.7" />
      </svg>
    )
  }

  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="mc-mark-rt-l" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4f4f5" />
          <stop offset="100%" stopColor="#7a7a82" />
        </linearGradient>
        <linearGradient id="mc-mark-rt-r" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9a9aa2" />
          <stop offset="100%" stopColor="#3a3a44" />
        </linearGradient>
      </defs>
      <path d="M4 3.5 L16 13.5 L16 28.5 L4 28.5 Z" fill="url(#mc-mark-rt-l)" />
      <path d="M28 3.5 L16 13.5 L16 28.5 L28 28.5 Z" fill="url(#mc-mark-rt-r)" />
      <path d="M16 13.5 L16 28.5" stroke="#08090b" strokeWidth="0.4" strokeOpacity="0.55" />
    </svg>
  )
}
