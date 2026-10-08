/**
 * A token count the way every surface shows one: 950 → "950", 12_345 →
 * "12.3k", 182_000 → "182k", 1_240_000 → "1.2M".
 *
 * One decimal while the scaled number is under a hundred, whole above it, and
 * never a trailing ".0". A count that would round to 1000k reads as "1M". A
 * count that is not a finite number reads as "0", as does anything below it.
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count)) return '0'
  const value = Math.max(0, Math.round(count))
  if (value < 1000) return String(value)
  const [scaled, unit] = value < 999_500 ? [value / 1000, 'k'] : [value / 1_000_000, 'M']
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`
}
