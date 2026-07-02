export function formatRelativeMs(ms: number | null | undefined, now: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60_000)
  // Sub-minute recency stays visually blank. "Now" conflates active work with
  // something that merely became idle recently; live state has its own mark.
  if (minutes < 1) return ''
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

export function formatRelativeMsAgo(ms: number | null | undefined, now: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (Math.max(0, now - ms) < 60_000) return 'just now'
  const short = formatRelativeMs(ms, now)
  if (!short) return ''
  return `${short} ago`
}
