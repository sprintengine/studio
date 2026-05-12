type MulticodeSpinnerProps = {
  className?: string
  label?: string
}

export default function MulticodeSpinner({
  className = 'h-8 w-8',
  label = 'Loading',
}: MulticodeSpinnerProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      role="img"
      aria-label={label}
      xmlns="http://www.w3.org/2000/svg"
    >
      <style>
        {`
          @keyframes multicode-spinner-rotate {
            to { transform: rotate(360deg); }
          }
          @keyframes multicode-spinner-pulse {
            0%, 100% { opacity: 0.55; }
            50% { opacity: 1; }
          }
          .multicode-spinner-ring {
            transform-origin: 32px 32px;
            animation: multicode-spinner-rotate 1.4s linear infinite;
          }
          .multicode-spinner-mark {
            animation: multicode-spinner-pulse 1.6s ease-in-out infinite;
            transform-origin: 32px 32px;
          }
          @media (prefers-reduced-motion: reduce) {
            .multicode-spinner-ring,
            .multicode-spinner-mark {
              animation: none;
            }
          }
        `}
      </style>
      <defs>
        <linearGradient id="mc-spin-left" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4f4f5" />
          <stop offset="100%" stopColor="#7a7a82" />
        </linearGradient>
        <linearGradient id="mc-spin-right" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9a9aa2" />
          <stop offset="100%" stopColor="#3a3a44" />
        </linearGradient>
      </defs>
      <circle
        className="multicode-spinner-ring"
        cx="32"
        cy="32"
        r="27"
        fill="none"
        stroke="#24252b"
        strokeWidth="2"
        strokeDasharray="22 140"
        strokeLinecap="round"
      />
      <g className="multicode-spinner-mark" transform="translate(16 12)">
        <path d="M2 4 L16 17 L16 36 L2 36 Z" fill="url(#mc-spin-left)" />
        <path d="M30 4 L16 17 L16 36 L30 36 Z" fill="url(#mc-spin-right)" />
        <path d="M16 17 L16 36" stroke="#08090b" strokeWidth="0.55" strokeOpacity="0.6" />
      </g>
    </svg>
  )
}
