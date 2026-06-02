type MulticodeWordmarkProps = {
  className?: string
  title?: string
}

export default function MulticodeWordmark({
  className = 'h-6',
  title = 'multicode',
}: MulticodeWordmarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 140 32"
      fill="none"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="70"
        y="23"
        textAnchor="middle"
        fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fontSize="22"
        fontWeight="600"
        letterSpacing="-0.02em"
        fill="currentColor"
      >
        multicode
      </text>
    </svg>
  )
}
