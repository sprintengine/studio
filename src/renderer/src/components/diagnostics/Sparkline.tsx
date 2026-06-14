import React from 'react'

// Hand-rolled inline-SVG sparkline — no charting dependency (the project enforces
// a bundle budget, so recharts/chart.js are off the table). Plots a numeric
// series scaled to its own min/max so trends and spikes are visible at a glance,
// where the panel otherwise shows only the latest value plus a single growth
// slope. Pure presentational; the caller owns the data and colour (via
// `currentColor`).
export function buildSparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length < 2) return ''
  let min = values[0]
  let max = values[0]
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const range = max - min || 1
  const stepX = width / (values.length - 1)
  // SVG y grows downward, so invert: the max value sits at y=0.
  return values
    .map((value, index) => {
      const x = index * stepX
      const y = height - ((value - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

export function Sparkline({
  values,
  width = 132,
  height = 22,
  className,
  title,
}: {
  values: readonly number[]
  width?: number
  height?: number
  className?: string
  title?: string
}): React.ReactElement {
  const points = buildSparklinePoints(values, width, height)
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {points ? (
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ) : (
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" strokeWidth={1} opacity={0.3} />
      )}
    </svg>
  )
}
