type MulticodeBlackHoleSpinnerProps = {
  className?: string
  label?: string
}

export default function MulticodeBlackHoleSpinner({
  className = 'h-8 w-8',
  label = 'Loading',
}: MulticodeBlackHoleSpinnerProps) {
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
          @keyframes multicode-black-hole-spin {
            to { transform: rotate(360deg); }
          }
          @keyframes multicode-black-hole-pulse {
            0%, 100% { opacity: 0.42; }
            50% { opacity: 0.9; }
          }
          .multicode-spinner-ring {
            transform-origin: 32px 32px;
            animation: multicode-black-hole-spin 1.2s linear infinite;
          }
          .multicode-spinner-drift {
            transform-origin: 32px 32px;
            animation: multicode-black-hole-spin 2.4s linear infinite reverse;
          }
          .multicode-spinner-pulse {
            animation: multicode-black-hole-pulse 1.1s ease-in-out infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .multicode-spinner-ring,
            .multicode-spinner-drift,
            .multicode-spinner-pulse {
              animation: none;
            }
          }
        `}
      </style>
      <rect width="64" height="64" rx="14" fill="#05070d" />
      <g className="multicode-spinner-drift" opacity="0.55">
        <rect x="10" y="30" width="8" height="3" fill="#2337ff" />
        <rect x="46" y="31" width="9" height="2" fill="#31d8ff" />
        <rect x="18" y="22" width="5" height="2" fill="#7a7d88" />
        <rect x="42" y="41" width="6" height="2" fill="#5360ff" />
      </g>
      <circle cx="32" cy="32" r="13" fill="#02030a" />
      <g className="multicode-spinner-ring">
        <path
          d="M12 32c4-9 12-14 23-13 9 1 15 5 18 13-4 8-12 13-22 13-9-1-16-5-19-13Z"
          fill="none"
          stroke="#f2f6ff"
          strokeWidth="4"
          strokeLinecap="square"
          strokeDasharray="38 18 12 10"
        />
        <path
          d="M13 32c6 5 13 7 22 6 7-1 13-3 17-6"
          fill="none"
          stroke="#344cff"
          strokeWidth="3"
          strokeLinecap="square"
          strokeDasharray="18 7 8 5"
        />
      </g>
      <circle cx="32" cy="32" r="12" fill="#01020a" />
      <g className="multicode-spinner-pulse">
        <rect x="52" y="47" width="5" height="3" fill="#17d8ff" />
        <rect x="58" y="47" width="3" height="3" fill="#17d8ff" opacity="0.55" />
      </g>
    </svg>
  )
}
